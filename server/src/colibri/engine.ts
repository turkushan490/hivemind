import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { logError } from '../errors.js';

/**
 * Colibri (github.com/JustVugg/colibri) inside this container: a C engine for very large mixture-of-experts models
 * that keeps the hot experts on the GPU or in RAM and streams the rest from disk. The HiveMind image carries the
 * engine in /opt/colibri (a CPU build, and a CUDA build when it compiled); HiveMind starts `coli serve` on
 * localhost with one model at a time, switches models by restarting it, and stops it after the keep-alive.
 */

export interface ColibriSettings {
  /** RAM for the engine in GB; 0 or unset = the container's limit minus room for HiveMind. */
  ramGb?: number;
  /** auto: the GPU when the CUDA build works; off: CPU only (then it never waits for the GPU). */
  gpu?: 'auto' | 'off';
  /** VRAM budget in GB for the hot experts; 0 = colibri decides. */
  vramGb?: number;
  /** Minutes a model stays loaded after its last call. */
  keepAliveMin?: number;
  /** Seconds one call may take when the block sets no limit of its own (giant models are slow). */
  callSeconds?: number;
  /** The machine whose GPU this container uses: the host of the Ollama/ComfyUI there, so they share one GPU queue. */
  gpuHost?: string;
  /** Context in tokens; 0 = colibri decides from the memory there is. */
  ctx?: number;
}

type Filled = ColibriSettings & Required<Pick<ColibriSettings, 'gpu' | 'vramGb' | 'keepAliveMin' | 'callSeconds' | 'ctx'>>;
export const COLIBRI_DEFAULTS: Filled = { gpu: 'auto', vramGb: 0, keepAliveMin: 10, callSeconds: 7200, ctx: 0 };

export function colibriSettings(): Filled {
  let s: ColibriSettings = {};
  try {
    s = JSON.parse(getSetting('colibri') ?? '{}') as ColibriSettings;
  } catch {}
  return { ...COLIBRI_DEFAULTS, ...s };
}

export function saveColibriSettings(patch: ColibriSettings): ColibriSettings {
  const next: ColibriSettings = { ...colibriSettings(), ...patch };
  if (next.ramGb !== undefined) next.ramGb = Math.max(0, Math.min(4096, Math.round(next.ramGb)));
  if (next.vramGb !== undefined) next.vramGb = Math.max(0, Math.min(1024, Number(next.vramGb) || 0));
  if (next.keepAliveMin !== undefined) next.keepAliveMin = Math.max(1, Math.min(24 * 60, Math.round(next.keepAliveMin)));
  if (next.callSeconds !== undefined) next.callSeconds = Math.max(60, Math.min(86400, Math.round(next.callSeconds)));
  if (next.ctx !== undefined) next.ctx = Math.max(0, Math.min(1_048_576, Math.round(next.ctx)));
  if (next.gpu !== 'off') next.gpu = 'auto';
  if (next.gpuHost !== undefined) next.gpuHost = next.gpuHost.trim() || undefined;
  setSetting('colibri', JSON.stringify(next));
  return next;
}

/** What the image built (written by the Dockerfile). */
interface Build {
  ref?: string;
  version?: string;
  cuda?: boolean;
}

/** How the engine process is started; tests swap in a fake `coli serve`. */
export interface Launch {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}
type Launcher = (o: { model: string; dir: string; port: number; ramGb: number; gpu: boolean; vramGb: number; ctx: number; engineDir: string }) => Launch;

const state = {
  root: process.env.COLIBRI_DIR || '/opt/colibri',
  modelsDir: process.env.COLIBRI_MODELS || join(config.dataDir, 'colibri', 'models'),
  port: Number(process.env.COLIBRI_PORT) || 8790,
  launcher: undefined as Launcher | undefined,
  /** The CUDA build would not start here (no GPU, missing libraries): the CPU build from now on. */
  cudaBroken: false,
};

/** Tests: a fake engine, its own folders and port. */
export function configureColibri(o: { root?: string; modelsDir?: string; port?: number; launcher?: Launcher }) {
  if (o.root !== undefined) state.root = o.root;
  if (o.modelsDir !== undefined) state.modelsDir = o.modelsDir;
  if (o.port !== undefined) state.port = o.port;
  if (o.launcher !== undefined) state.launcher = o.launcher;
  state.cudaBroken = false;
}

export const colibriBase = () => `http://127.0.0.1:${state.port}`;
export const colibriModelsDir = () => state.modelsDir;
const logFile = () => join(config.dataDir, 'colibri', 'engine.log');

function build(): Build {
  try {
    return JSON.parse(readFileSync(join(state.root, 'build.json'), 'utf8')) as Build;
  } catch {
    return {};
  }
}

const cpuDir = () => join(state.root, 'cpu', 'c');
const cudaDir = () => join(state.root, 'cuda', 'c');

/** The engine is in this image (or a test launcher stands in for it). */
export const colibriAvailable = () => !!state.launcher || existsSync(join(cpuDir(), 'coli'));

/** A CUDA build is there, a GPU is visible, and it hasn't failed to start. */
export function gpuUsable(): boolean {
  if (colibriSettings().gpu === 'off' || state.cudaBroken) return false;
  if (state.launcher) return true;
  return !!build().cuda && existsSync(join(cudaDir(), 'coli')) && existsSync('/dev/nvidia0');
}

/** Python for coli: the image's (the training stack's), else python3 from PATH. */
const python = () => [process.env.COLIBRI_PYTHON, '/opt/unsloth-venv/bin/python', '/usr/bin/python3'].find((p) => p && existsSync(p)) ?? 'python3';

/** CUDA libraries the image already has (PyTorch's pip packages): the engine links cudart and cuBLAS. */
function cudaLibDirs(): string[] {
  const dirs = [join(state.root, 'lib')];
  for (const venv of ['/opt/unsloth-venv/lib']) {
    let pys: string[] = [];
    try {
      pys = readdirSync(venv).filter((d) => d.startsWith('python'));
    } catch {}
    for (const py of pys) {
      const nv = join(venv, py, 'site-packages', 'nvidia');
      for (const pkg of ['cuda_runtime', 'cublas', 'cuda_nvrtc']) dirs.push(join(nv, pkg, 'lib'));
    }
  }
  return dirs.filter((d) => existsSync(d));
}

const defaultLauncher: Launcher = (o) => {
  const engineDir = o.engineDir;
  const args = [join(engineDir, 'coli'), 'serve', '--model', o.dir, '--model-id', o.model, '--host', '127.0.0.1', '--port', String(o.port), '--max-queue', '32', '--queue-timeout', '86400'];
  if (o.ramGb > 0) args.push('--ram', String(o.ramGb));
  if (o.ctx > 0) args.push('--ctx', String(o.ctx));
  args.push('--gpu', o.gpu ? 'auto' : 'none');
  if (o.gpu && o.vramGb > 0) args.push('--vram', String(o.vramGb));
  const libs = o.gpu ? cudaLibDirs() : [];
  return {
    cmd: python(),
    args,
    env: { PYTHONUNBUFFERED: '1', ...(libs.length && { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }) },
  };
};

// ---- memory ----

/** The container's memory limit (cgroup v2, then v1), else the machine's RAM. */
export function containerLimitBytes(): number {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = readFileSync(f, 'utf8').trim();
      const n = Number(v);
      // cgroup v1 reports "no limit" as a huge number.
      if (v !== 'max' && Number.isFinite(n) && n > 0 && n < totalmem() * 4) return Math.min(n, totalmem());
    } catch {}
  }
  return totalmem();
}

/** Room HiveMind itself (and a project build) needs next to the engine. */
const HIVEMIND_ROOM = 4e9;

/** RAM the engine may use, in bytes: the setting, never more than the container leaves. */
export function ramBudgetBytes(): number {
  const room = Math.max(0, containerLimitBytes() - HIVEMIND_ROOM);
  const set = colibriSettings().ramGb;
  return set ? Math.min(set * 1e9, room) : room;
}

// ---- installed models ----

export interface InstalledModel {
  model: string;
  dir: string;
  sizeBytes: number;
}

function folderBytes(dir: string, depth = 0): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) n += depth < 3 ? folderBytes(p, depth + 1) : 0;
      else n += statSync(p).size;
    } catch {}
  }
  return n;
}

const sizes = new Map<string, { at: number; bytes: number }>();

/** Models ready to serve: a finished download (its manifest says complete) or an imported GGUF (config.json). */
export function installedModels(): InstalledModel[] {
  let names: string[] = [];
  try {
    names = readdirSync(state.modelsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names.flatMap((model) => {
    const dir = join(state.modelsDir, model);
    let ready = false;
    try {
      const m = JSON.parse(readFileSync(join(dir, '.colibri-download.json'), 'utf8')) as { complete?: boolean };
      ready = !!m.complete;
    } catch {
      ready = existsSync(join(dir, 'config.json'));
    }
    if (!ready) return [];
    const hit = sizes.get(dir);
    const bytes = hit && Date.now() - hit.at < 10 * 60_000 ? hit.bytes : folderBytes(dir);
    sizes.set(dir, { at: Date.now(), bytes });
    return [{ model, dir, sizeBytes: bytes }];
  });
}

export const isInstalled = (model: string) => installedModels().some((m) => m.model === model);

/** A model folder name: letters, digits, dot, dash and underscore only (it becomes a path and a model id). */
export const validModelName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name);

export function deleteModel(model: string) {
  if (!validModelName(model)) throw new Error('Not a model name');
  if (current?.model === model) void stopEngine();
  rmSync(join(state.modelsDir, model), { recursive: true, force: true });
  rmSync(join(state.modelsDir, '.gguf', model), { recursive: true, force: true });
  sizes.delete(join(state.modelsDir, model));
}

// ---- the engine process ----

type EngineState = 'starting' | 'ready';
let proc: ChildProcess | undefined;
let current: { model: string; state: EngineState; since: number; gpu: boolean } | undefined;
let idle: NodeJS.Timeout | undefined;
/** Every start and stop goes through this queue, so two calls never start two engines. */
let queue: Promise<unknown> = Promise.resolve();
/** Called with the minimum RAM a model needs (from the catalog), or undefined when unknown. */
let ramNeedOf: (model: string) => Promise<number | undefined> = async () => undefined;
export const setRamNeedLookup = (fn: typeof ramNeedOf) => (ramNeedOf = fn);

const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

/** What is loaded right now, if anything. */
export const loadedModel = () => (current && proc && proc.exitCode === null ? { ...current } : undefined);

function logTail(lines = 30): string {
  try {
    const text = readFileSync(logFile(), 'utf8');
    return text.split('\n').slice(-lines - 1).join('\n').trim();
  } catch {
    return '';
  }
}

async function healthy(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`${colibriBase()}/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The engine's queue counters (GET /health), when it runs. */
export const engineHealth = () => (loadedModel() ? healthy() : Promise.resolve(undefined));

function resetIdle(keepAlive?: string) {
  if (idle) clearTimeout(idle);
  const ms = keepAliveMs(keepAlive) ?? colibriSettings().keepAliveMin * 60_000;
  if (ms <= 0) return;
  idle = setTimeout(() => {
    // Never in the middle of an answer: try again later while it is busy.
    if (active > 0) return resetIdle(keepAlive);
    void stopEngine();
  }, ms);
  idle.unref();
}

/** "30m", "2h", "90s", "-1" (forever) like Ollama's keep_alive; undefined when not given. */
export function keepAliveMs(keep?: string): number | undefined {
  if (!keep) return undefined;
  if (/^-1$/.test(keep.trim())) return 0;
  const m = keep.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return undefined;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
}

async function kill(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const gone = new Promise<void>((r) => p.once('exit', () => r()));
  p.kill('SIGTERM');
  const t = setTimeout(() => p.kill('SIGKILL'), 10_000);
  await gone;
  clearTimeout(t);
}

/** Unloads the model (stops the engine); it starts again on the next call. */
export function stopEngine(): Promise<void> {
  return serial(async () => {
    if (idle) clearTimeout(idle);
    const p = proc;
    proc = undefined;
    current = undefined;
    if (p) await kill(p);
  });
}

/** How long a model may take to load: the dense part is read from disk (a 744B model reads ~10 GB). */
const LOAD_TIMEOUT_MS = 30 * 60_000;

/** Calls using the engine right now: a model switch waits until they are done. */
let active = 0;

/**
 * Makes sure `model` is the one being served, starting or switching the engine when needed, and holds it until
 * release() (a switch to another model waits for every holder). loaded: it had to load (the caller shows "loading").
 */
export function acquire(model: string, opts: { keepAlive?: string; signal?: AbortSignal } = {}): Promise<{ loaded: boolean; release: () => void }> {
  return serial(async () => {
    if (!colibriAvailable()) throw new Error('Colibri is not in this HiveMind image');
    let loaded = false;
    const live = loadedModel();
    if (live?.model !== model || live.state !== 'ready') {
      const found = installedModels().find((m) => m.model === model);
      if (!found) throw new Error(`Colibri has no model "${model}" (Settings → Colibri → Download)`);
      const budget = ramBudgetBytes();
      const need = await ramNeedOf(model).catch(() => undefined);
      if (need && need > budget)
        throw new Error(
          `${model} needs ${Math.round(need / 1e9)} GB of RAM and colibri has ${Math.round(budget / 1e9)} GB here. Give HiveMind more memory (--memory in its Docker template) or pick a smaller model.`,
        );
      // Never cut off an answer of the model that is loaded now.
      while (active > 0) {
        if (opts.signal?.aborted) throw new Error('Cancelled');
        await new Promise((r) => setTimeout(r, 300));
      }
      if (proc) {
        if (idle) clearTimeout(idle);
        const p = proc;
        proc = undefined;
        current = undefined;
        await kill(p);
      }
      loaded = await start(found, budget, opts);
    }
    active++;
    if (idle) clearTimeout(idle);
    let done = false;
    return {
      loaded,
      release: () => {
        if (done) return;
        done = true;
        active = Math.max(0, active - 1);
        if (!active && loadedModel()) resetIdle(opts.keepAlive);
      },
    };
  });
}

/** Loads a model (or keeps it loaded) without answering. */
export async function warmModel(model: string, keepAlive?: string) {
  (await acquire(model, { keepAlive })).release();
}

async function start(m: InstalledModel, budget: number, opts: { keepAlive?: string; signal?: AbortSignal }, retried = false, cpuOnly = false): Promise<boolean> {
  const s = colibriSettings();
  const gpu = !cpuOnly && gpuUsable();
  const launch = (state.launcher ?? defaultLauncher)({
    model: m.model,
    dir: m.dir,
    port: state.port,
    ramGb: Math.floor(budget / 1e9),
    gpu,
    vramGb: s.vramGb,
    ctx: s.ctx,
    engineDir: gpu ? cudaDir() : cpuDir(),
  });
  mkdirSync(join(config.dataDir, 'colibri'), { recursive: true });
  // The log restarts with each model, so it shows this engine's start and not last week's.
  writeFileSync(logFile(), `--- ${new Date().toISOString()} ${m.model} (${gpu ? 'CUDA' : 'CPU'}, ${Math.floor(budget / 1e9)} GB RAM)\n`);
  const out = openSync(logFile(), 'a');
  const child = spawn(launch.cmd, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['ignore', out, out] });
  closeSync(out);
  proc = child;
  current = { model: m.model, state: 'starting', since: Date.now(), gpu };
  let exited = false;
  child.once('exit', (code, sig) => {
    exited = true;
    if (proc === child) {
      proc = undefined;
      current = undefined;
      if (code && !sig) logError({ source: 'server', message: `Colibri stopped (exit code ${code}) while serving ${m.model}`, detail: logTail(15) });
    }
  });
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
    if (opts.signal?.aborted) {
      await kill(child);
      throw new Error('Cancelled');
    }
    if (exited) {
      const tail = logTail(15);
      // The CUDA build has no engine for this model family (it did not compile for CUDA): the CPU one, this time.
      if (gpu && !retried && /engine is not built/i.test(tail)) return start(m, budget, opts, true, true);
      // The CUDA build can't run here (no driver, missing library, a card it was not built for): the CPU build.
      if (gpu && !retried && /error while loading shared libraries|no CUDA-capable device|CUDA driver|cuda(Get|Set|Malloc|Init)|libcu/i.test(tail)) {
        state.cudaBroken = true;
        logError({ source: 'server', message: 'Colibri: the CUDA build would not start here, using the CPU build', detail: tail });
        return start(m, budget, opts, true);
      }
      throw new Error(`Colibri could not start ${m.model}: ${tail.split('\n').slice(-4).join(' ').slice(0, 600) || 'no output'}`);
    }
    if (await healthy(opts.signal)) {
      if (proc === child && current) current.state = 'ready';
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await kill(child);
  throw new Error(`Colibri took more than ${LOAD_TIMEOUT_MS / 60_000} minutes to load ${m.model}`);
}

/** Everything the Settings card shows. */
export async function colibriStatus() {
  const b = build();
  const live = loadedModel();
  return {
    available: colibriAvailable(),
    version: b.version,
    ref: b.ref,
    cudaBuilt: !!b.cuda,
    gpu: gpuUsable(),
    cudaBroken: state.cudaBroken,
    gpuDevice: existsSync('/dev/nvidia0'),
    containerLimitBytes: containerLimitBytes(),
    ramBudgetBytes: ramBudgetBytes(),
    loaded: live ? { model: live.model, state: live.state, since: new Date(live.since).toISOString(), gpu: live.gpu } : undefined,
    health: live?.state === 'ready' ? await healthy() : undefined,
    log: logTail(40),
    settings: colibriSettings(),
  };
}

process.once('exit', () => {
  proc?.kill('SIGTERM');
});
