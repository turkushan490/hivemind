import type { BuildResult } from '@hivemind/shared';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { cleanRel, rootOf, touchProject } from './projects.js';

/**
 * Builds a project inside the HiveMind container: npm install, then an npm script. The build runs on a copy in
 * /data/builds/<id> (node_modules stay there between builds), as its own unprivileged user when HiveMind runs
 * as root, with an empty environment (no HiveMind secrets), a time limit and a log limit. The output folder is
 * copied back into the project.
 */

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const buildsDir = resolve(config.dataDir, 'builds');
export const npmCacheDir = resolve(config.dataDir, 'cache', 'npm');

const LOG_MAX = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The build user (Dockerfile: useradd hmbuild) when HiveMind runs as root; else builds run as HiveMind's own user. */
function buildUser(): { uid: number; gid: number } | undefined {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return;
  try {
    const uid = Number(execFileSync('id', ['-u', 'hmbuild'], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('id', ['-g', 'hmbuild'], { encoding: 'utf8' }).trim());
    return Number.isInteger(uid) && uid > 0 ? { uid, gid } : undefined;
  } catch {
    return;
  }
}

let lockedDown = false;
/**
 * Once, when builds run as their own user: the data folder is closed to other users (the database, the secret
 * key, everyone's files), except the build and npm cache folders. Run at start-up and before a build.
 */
export function lockDataDir() {
  const user = buildUser();
  if (!user || lockedDown) return;
  lockedDown = true;
  try {
    chmodSync(config.dataDir, 0o711);
    for (const name of readdirSync(config.dataDir)) {
      if (name === 'builds' || name === 'cache') continue;
      const full = join(config.dataDir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      chmodSync(full, st.isDirectory() ? (st.mode & 0o7700) | 0o700 : (st.mode & 0o7700) | 0o600);
    }
    mkdirSync(buildsDir, { recursive: true });
    chmodSync(buildsDir, 0o711);
    mkdirSync(npmCacheDir, { recursive: true });
    chmodSync(join(config.dataDir, 'cache'), 0o711);
    chownSync(npmCacheDir, user.uid, user.gid);
  } catch (e) {
    console.warn(`Could not lock the data folder for builds: ${(e as Error).message}`);
  }
}

/** Is npm in this image? */
export function npmAvailable(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const running = new Set<string>();

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

/** Copies the project (not .git, node_modules or the output folder) into the build folder, keeping node_modules there. */
function prepare(project: { id: string }, work: string, outDir: string) {
  mkdirSync(work, { recursive: true });
  for (const name of readdirSync(work)) if (name !== 'node_modules' && name !== '.home') rmSync(join(work, name), { recursive: true, force: true });
  const root = rootOf(project);
  cpSync(root, work, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src).split(sep).join('/');
      if (!rel) return true;
      const top = rel.split('/')[0];
      if (top === '.git' || top === 'node_modules' || rel === outDir || rel.startsWith(`${outDir}/`)) return false;
      return !lstatSync(src).isSymbolicLink();
    },
  });
  mkdirSync(join(work, '.home'), { recursive: true });
}

interface Step {
  args: string[];
  label: string;
}

/** Builds a project. onLog gets the output as it comes; the result has the last 200 lines. */
export async function buildProject(
  project: { id: string },
  opts: { script?: string; outDir?: string; timeoutMs?: number; signal?: AbortSignal; onLog?: (text: string) => void } = {},
): Promise<BuildResult> {
  const script = (opts.script ?? 'build').trim() || 'build';
  if (!/^[A-Za-z0-9:._-]{1,60}$/.test(script)) throw err(400, `Not a valid npm script name: ${script.slice(0, 60)}`);
  const outWanted = opts.outDir?.trim() ? cleanRel(opts.outDir) : undefined;
  const root = rootOf(project);
  if (!existsSync(join(root, 'package.json'))) throw err(400, 'This project has no package.json, so there is nothing to build (a plain HTML site needs no build)');
  if (running.has(project.id)) throw err(409, 'This project is already building');
  if (!npmAvailable()) throw err(500, 'npm is not installed in this HiveMind image');
  running.add(project.id);
  const t0 = Date.now();
  const user = buildUser();
  lockDataDir();
  const work = join(buildsDir, project.id);
  let log = '';
  const add = (text: string) => {
    log = (log + text).slice(-LOG_MAX);
    opts.onLog?.(text);
  };
  try {
    mkdirSync(buildsDir, { recursive: true });
    mkdirSync(npmCacheDir, { recursive: true });
    prepare(project, work, outWanted ?? 'dist');
    if (user) {
      chownTree(work, user.uid, user.gid);
      chownSync(npmCacheDir, user.uid, user.gid);
    }
    // Nothing of HiveMind's environment: only what npm needs.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: join(work, '.home'),
      NODE_ENV: 'production',
      npm_config_cache: npmCacheDir,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const lock = existsSync(join(work, 'package-lock.json'));
    const steps: Step[] = [
      { args: lock ? ['ci', '--include=dev', '--no-audit'] : ['install', '--include=dev', '--no-audit'], label: lock ? 'npm ci' : 'npm install' },
      { args: ['run', script], label: `npm run ${script}` },
    ];
    const deadline = t0 + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (const step of steps) {
      add(`$ ${step.label}\n`);
      const code = await runStep(step.args, work, env, user, deadline - Date.now(), opts.signal, add);
      if (code !== 0) {
        const why = code === 'timeout' ? `stopped after ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} seconds` : code === 'cancelled' ? 'cancelled' : `exit code ${code}`;
        add(`\n${step.label} failed: ${why}\n`);
        return { ok: false, log: lastLines(log), ms: Date.now() - t0 };
      }
    }
    // The output folder: the one asked for, else dist/, else build/.
    const out = outWanted ?? ['dist', 'build', 'out'].find((d) => existsSync(join(work, d)) && statSync(join(work, d)).isDirectory());
    if (!out || !existsSync(join(work, out))) {
      add(`\nThe build finished, but there is no output folder${outWanted ? ` ${outWanted}` : ' (dist, build or out)'}\n`);
      return { ok: false, log: lastLines(log), ms: Date.now() - t0 };
    }
    const dest = join(root, out);
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(work, out), dest, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
    touchProject(project.id);
    add(`\nCopied ${out}/ into the project\n`);
    return { ok: true, log: lastLines(log), outDir: out, ms: Date.now() - t0 };
  } finally {
    running.delete(project.id);
  }
}

const lastLines = (log: string) => log.split('\n').slice(-200).join('\n');

function runStep(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  user: { uid: number; gid: number } | undefined,
  ms: number,
  signal: AbortSignal | undefined,
  onLog: (t: string) => void,
): Promise<number | 'timeout' | 'cancelled'> {
  if (ms <= 0) return Promise.resolve('timeout');
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: win,
      // Its own process group, so a time-out stops everything the script started.
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
      // Something the script started may still hold the output open: give up waiting after a few seconds.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(ended ?? 1);
      }, 5000).unref();
    };
    const timer = setTimeout(() => {
      ended = 'timeout';
      kill();
    }, ms);
    const onAbort = () => {
      ended = 'cancelled';
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => onLog(d.toString()));
    child.stderr.on('data', (d: Buffer) => onLog(d.toString()));
    child.on('error', (e) => {
      onLog(`${e.message}\n`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      resolve(ended ?? code ?? 1);
    });
  });
}
