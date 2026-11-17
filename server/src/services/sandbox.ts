// H18: the Shell block's sandbox. Commands (bash or PowerShell) run in /data/sandbox/<key>/ inside the HiveMind
// container, as the unprivileged build user when HiveMind runs as root (no rights on the rest of /data), with an
// empty environment (no HiveMind secrets), a time limit, a process limit and a list of refused commands. A project's
// files are copied in first; what the commands leave in dist/ (or out/, build/) is copied back into the project, so
// an .exe made here can be downloaded from the project.
import { execFileSync, spawn } from 'node:child_process';
import { chownSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { lockDataDir } from './build.js';
import { rootOf, touchProject } from './projects.js';

export const sandboxDir = resolve(config.dataDir, 'sandbox');
const OUTPUT_MAX = 20 * 1024;
const LOG_MAX = 2 * 1024 * 1024;

export interface ShellResult {
  exitCode: number | 'timeout' | 'cancelled';
  /** The last 20 KB of what the commands wrote (stdout and stderr together). */
  output: string;
  ms: number;
  /** Folders copied back into the project. */
  copied?: string[];
}

/** Commands that are never run here: wiping the disk, mounting, raw devices, reaching into HiveMind's own data. */
const REFUSED: [RegExp, string][] = [
  [/\brm\s+(?:-[\w-]*\s+)*-[\w-]*r[\w-]*\s+(?:-[\w-]*\s+)*\/(?:\s|$|\*)/i, 'rm -r on /'],
  [/\b(mount|umount|mkfs(\.\w+)?|fdisk|parted|swapon|swapoff|insmod|modprobe|chroot|nsenter|reboot|shutdown|halt|poweroff)\b/i, 'system commands'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'writing to a device'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, 'a fork bomb'],
  [/\/data\/(?!sandbox\b)/, 'HiveMind data outside the sandbox'],
  [/\bdocker\b|\/var\/run\/docker\.sock/i, 'Docker'],
];

/** Private network addresses (the LAN) for ssh/scp/telnet: refused unless the block allows the LAN. */
const LAN_RE = /\b(ssh|scp|sftp|telnet|rsync)\b[^\n]*\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|localhost|127\.0\.0\.1)\b/i;

/** Why these commands are refused, or undefined when they may run. */
export function refusedCommand(commands: string, opts: { lan?: boolean } = {}): string | undefined {
  for (const [re, what] of REFUSED) if (re.test(commands)) return `refused: ${what} are not allowed in the sandbox`;
  if (!opts.lan && LAN_RE.test(commands)) return 'refused: ssh/scp to the LAN is not allowed from the sandbox';
  return undefined;
}

/** The build user's ids when HiveMind runs as root (the Dockerfile adds hmbuild). */
function sandboxUser(): { uid: number; gid: number } | undefined {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return;
  try {
    const uid = Number(execFileSync('id', ['-u', 'hmbuild'], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('id', ['-g', 'hmbuild'], { encoding: 'utf8' }).trim());
    return Number.isInteger(uid) && uid > 0 ? { uid, gid } : undefined;
  } catch {
    return;
  }
}

function chownTree(dir: string, uid: number, gid: number) {
  chownSync(dir, uid, gid);
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) chownTree(full, uid, gid);
    else chownSync(full, uid, gid);
  }
}

/** A safe folder name for the sandbox. */
export const sandboxKey = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'run';

/** Is this shell in the image? */
export function shellAvailable(shell: 'bash' | 'pwsh'): boolean {
  try {
    execFileSync(shell, shell === 'pwsh' ? ['-NoLogo', '-NoProfile', '-Command', 'exit 0'] : ['-c', 'exit 0'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs commands in the sandbox. With a project: its files are copied in first (not .git, node_modules), and the
 * output folders (dist/, out/, build/) the commands make are copied back into the project afterwards.
 */
export async function runShell(o: {
  key: string;
  project?: { id: string };
  shell: 'bash' | 'pwsh';
  commands: string;
  timeoutSec?: number;
  network?: boolean;
  lan?: boolean;
  keepFiles?: boolean;
  signal?: AbortSignal;
  onLog?: (text: string) => void;
}): Promise<ShellResult> {
  const t0 = Date.now();
  const why = refusedCommand(o.commands, { lan: o.lan });
  if (why) return { exitCode: 126, output: why, ms: 0 };
  const user = sandboxUser();
  lockDataDir();
  const work = join(sandboxDir, sandboxKey(o.key));
  mkdirSync(sandboxDir, { recursive: true });
  if (!o.keepFiles && existsSync(work)) {
    for (const name of readdirSync(work)) if (name !== '.home') rmSync(join(work, name), { recursive: true, force: true });
  }
  mkdirSync(join(work, '.home'), { recursive: true });
  if (o.project) {
    const root = rootOf(o.project);
    cpSync(root, work, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = relative(root, src).split(sep).join('/');
        if (!rel) return true;
        const top = rel.split('/')[0];
        return top !== '.git' && top !== 'node_modules' && !lstatSync(src).isSymbolicLink();
      },
    });
  }
  if (user) chownTree(work, user.uid, user.gid);

  const home = join(work, '.home');
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/local/go/bin:/usr/lib/go/bin:/usr/bin:/bin:/usr/share/dotnet',
    HOME: home,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    // Tools keep their caches in the sandbox's home, never in HiveMind's.
    GOPATH: join(home, 'go'),
    GOCACHE: join(home, '.cache', 'go'),
    GOFLAGS: '-modcacherw',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_HOME: home,
    NUGET_PACKAGES: join(home, '.nuget'),
    npm_config_cache: join(home, '.npm'),
    npm_config_update_notifier: 'false',
    PIP_CACHE_DIR: join(home, '.cache', 'pip'),
    WINEPREFIX: join(home, '.wine'),
    WINEDEBUG: '-all',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
  };
  // Network off: the container can't take the network away from one process, so every proxy points nowhere (tools
  // that honour proxies, e.g. npm, pip, go, dotnet, curl, can't download); said in the output.
  if (o.network === false) for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) env[k] = 'http://127.0.0.1:9';
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

  // At most 512 processes and 4 GB files; the time limit stops the whole process group.
  const limits = 'ulimit -u 512 2>/dev/null; ulimit -f 4194304 2>/dev/null;';
  const timeoutMs = Math.min(3600, Math.max(5, o.timeoutSec ?? 120)) * 1000;
  const args =
    o.shell === 'pwsh'
      ? ['-c', `${limits} exec pwsh -NoLogo -NoProfile -NonInteractive -Command -`]
      : ['-c', `${limits} exec bash -e -o pipefail -s`];
  let log = '';
  const add = (t: string) => {
    log = (log + t).slice(-LOG_MAX);
    o.onLog?.(t);
  };
  if (o.network === false) add('(network off: downloads through a proxy are blocked)\n');
  const code = await new Promise<number | 'timeout' | 'cancelled'>((res) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? (o.shell === 'pwsh' ? 'pwsh' : 'bash') : 'bash', win ? (o.shell === 'pwsh' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : ['-s']) : args, {
      cwd: work,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !win,
      ...(user && { uid: user.uid, gid: user.gid }),
    });
    let ended: 'timeout' | 'cancelled' | undefined;
    let settled = false;
    const kill = () => {
      try {
        if (!win && child.pid) process.kill(-child.pid, 'SIGKILL');
        else if (child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
      setTimeout(() => {
        if (settled) return;
        settled = true;
        res(ended ?? 1);
      }, 4000).unref();
    };
    const timer = setTimeout(() => {
      ended = 'timeout';
      kill();
    }, timeoutMs);
    const onAbort = () => {
      ended = 'cancelled';
      kill();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => add(d.toString()));
    child.stderr.on('data', (d: Buffer) => add(d.toString()));
    child.on('error', (e) => add(`${e.message}\n`));
    child.stdin.end(o.commands.endsWith('\n') ? o.commands : `${o.commands}\n`);
    child.on('close', (c) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      res(ended ?? c ?? 1);
    });
  });
  if (code === 'timeout') add(`\nStopped after ${timeoutMs / 1000} seconds\n`);
  const copied: string[] = [];
  if (o.project && code !== 'cancelled') {
    const root = rootOf(o.project);
    for (const d of ['dist', 'out', 'build']) {
      const src = join(work, d);
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      const dest = join(root, d);
      rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true, filter: (s) => !lstatSync(s).isSymbolicLink() });
      copied.push(d);
    }
    if (copied.length) touchProject(o.project.id);
  }
  return { exitCode: code, output: log.slice(-OUTPUT_MAX), ms: Date.now() - t0, ...(copied.length && { copied }) };
}
