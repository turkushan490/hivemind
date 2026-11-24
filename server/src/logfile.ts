// The plain-text log file. Settings → Log file switches it: off, on (problems, warnings, start/stop) or debug (also every
// request, debug lines and console output). Docker keeps logging to stdout as before. Best-effort, never throws.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';
import { config } from './config.js';
import { getSetting, setSetting } from './db/index.js';

export type LogMode = 'off' | 'on' | 'debug';
export const LOG_MODES: LogMode[] = ['off', 'on', 'debug'];

const KEY = 'log.mode';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DEBUG_BYTES = 20 * 1024 * 1024;
let ready = false;
let mode: LogMode | undefined;

/** The file: LOG_FILE when set to a path, else hivemind.log in the data folder. The old one is `<file>.1`. */
export function logPath(): string {
  return config.logFile ?? join(config.dataDir, 'hivemind.log');
}

/** What is written now. Without a choice in Settings: on for the exe or when LOG_FILE is set, else off. */
export function logMode(): LogMode {
  if (mode) return mode;
  let saved: string | undefined;
  try {
    saved = getSetting(KEY);
  } catch {}
  mode = LOG_MODES.includes(saved as LogMode) ? (saved as LogMode) : config.logFile ? 'on' : 'off';
  return mode;
}

const levelHooks = new Set<(m: LogMode) => void>();
/** Called on every change (the web server's logger turns debug on and off with it). */
export function onLogMode(fn: (m: LogMode) => void): void {
  levelHooks.add(fn);
}

export function setLogMode(m: LogMode): LogMode {
  if (!LOG_MODES.includes(m)) throw new Error('Log mode is off, on or debug');
  const before = logMode();
  setSetting(KEY, m);
  mode = m;
  for (const fn of levelHooks) {
    try {
      fn(m);
    } catch {}
  }
  if (before !== m) write('server', `Log file set to ${m}`);
  return m;
}

/** Keys, tokens, PINs and passwords never end up in the file. */
export function redact(s: string): string {
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b((?:api[_-]?key|token|password|passwd|secret|pin|authorization|cookie)["']?\s*[:=]\s*["']?)[^"'\s&,;}]+/gi, '$1***')
    .replace(/\b(sk|hf|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, '$1-***');
}

function write(level: string, message: string, detail?: string): void {
  try {
    const file = logPath();
    if (!ready) {
      mkdirSync(dirname(file), { recursive: true });
      ready = true;
    }
    try {
      if (statSync(file).size > (mode === 'debug' ? MAX_DEBUG_BYTES : MAX_BYTES)) renameSync(file, `${file}.1`);
    } catch {}
    const line = `${new Date().toISOString()} [${level}] ${message}${detail ? `\n${detail}` : ''}`;
    appendFileSync(file, `${redact(line)}\n`);
  } catch {
    // Logging must never break the server.
  }
}

/** One timestamped line (plus optional detail), when the log file is on or on debug. */
export function appendLog(level: string, message: string, detail?: string): void {
  if (logMode() === 'off') return;
  write(level, message, detail);
}

/** Only on debug: the details you want while chasing a problem, not every day. */
export function debugLog(source: string, message: string, detail?: string): void {
  if (logMode() !== 'debug') return;
  write(source, message, detail);
}

/** A request path for the file: no query (tokens live there), and nothing after a hidden part. */
export function logUrl(url: string): string {
  const path = url.split('?')[0];
  const i = path.toLowerCase().indexOf('hidden');
  return i < 0 ? path : `${path.slice(0, path.indexOf('/', i) < 0 ? path.length : path.indexOf('/', i))}/…`;
}

const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const STDOUT_MIN = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[process.env.LOG_LEVEL || 'info'] ?? 30;

/**
 * The web server's log stream: stdout as before (at LOG_LEVEL), and the file — warnings and errors when on, debug lines
 * too on debug. Fastify's own per-request lines are left out of the file (the debug request line is shorter and safer).
 */
export const serverLogStream = {
  write(line: string): void {
    const level = Number(/"level":(\d+)/.exec(line)?.[1] ?? 30);
    if (level >= STDOUT_MIN) process.stdout.write(line);
    const m = logMode();
    if (m === 'off' || level < (m === 'debug' ? 20 : 40)) return;
    try {
      const o = JSON.parse(line) as { msg?: string; err?: { message?: string; stack?: string }; req?: { method?: string; url?: string } };
      if (o.msg === 'incoming request' || o.msg === 'request completed') return;
      const where = o.req?.method && o.req.url ? ` (${o.req.method} ${logUrl(o.req.url)})` : '';
      write(PINO_LEVELS[level] ?? 'info', `${o.msg ?? o.err?.message ?? ''}${where}`, o.err?.stack);
    } catch {}
  },
};

/** The web server's logger level for a mode: debug lines are only made when they are wanted. */
export function serverLogLevel(m = logMode()): string {
  return m === 'debug' ? 'debug' : process.env.LOG_LEVEL || 'info';
}

let captured = false;
/** console.error/warn go to the file when on, console.log/info/debug on debug (as well as to the terminal). */
export function captureConsole(): void {
  if (captured) return;
  captured = true;
  for (const name of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      const text = format(...args);
      if (name === 'error' || name === 'warn') appendLog(name, text);
      else debugLog(name === 'log' ? 'info' : name, text);
    };
  }
}

/** Size of the file and the old one, in bytes. */
export function logSize(): { size: number; old: number } {
  const size = (f: string) => {
    try {
      return statSync(f).size;
    } catch {
      return 0;
    }
  };
  return { size: size(logPath()), old: size(`${logPath()}.1`) };
}

/** The last `lines` lines (old file first, so nothing is missing right after a rotation). */
export function logTail(lines = 200): string {
  const read = (f: string) => {
    try {
      const s = readFileSync(f, 'utf8');
      return s.length > 4 * 1024 * 1024 ? s.slice(-4 * 1024 * 1024) : s;
    } catch {
      return '';
    }
  };
  const all = (read(`${logPath()}.1`) + read(logPath())).split('\n');
  if (all[all.length - 1] === '') all.pop();
  return all.slice(-Math.max(1, Math.min(lines, 20000))).join('\n');
}

/** Both files, for the download (old part first). */
export function logAll(): string {
  const read = (f: string) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  return read(`${logPath()}.1`) + read(logPath());
}

export function clearLog(): void {
  for (const f of [logPath(), `${logPath()}.1`]) {
    try {
      rmSync(f, { force: true });
    } catch {}
  }
  appendLog('server', 'Log file cleared');
}

/** For tests: forget the cached mode. */
export function resetLogModeCache(): void {
  mode = undefined;
}
