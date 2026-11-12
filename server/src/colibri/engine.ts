import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { logError } from '../errors.js';

/**
 * Colibri (github.com/JustVugg/colibri) inside this container: a C engine for very large mixture-of-experts models
 * that keeps the hot experts on the GPU or in RAM and streams the rest from disk. The HiveMind image carries the
 * engine in /opt/colibri (a CPU build, and a CUDA build when it compiled); HiveMind starts `coli serve` on
 * localhost, one engine per loaded model (several at once when they fit the RAM budget), and stops each after the
 * keep-alive.
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
  /** Conversations colibri keeps in memory at once (KV slots, 1-16): each keeps its prompt, so a repeat is not read again. */
  kvSlots?: number;
  /** Models loaded at the same time (1-8), each in its own engine; they share the RAM budget. */
  maxEngines?: number;
  /** Models that stay loaded (no keep-alive), and come back after a bigger model pushed them out. */
  pinned?: string[];
}

type Filled = ColibriSettings & Required<Pick<ColibriSettings, 'gpu' | 'vramGb' | 'keepAliveMin' | 'callSeconds' | 'ctx' | 'kvSlots' | 'maxEngines'>>;
// 30 minutes: a robot conversation (HiveBot) stays warm between questions.
export const COLIBRI_DEFAULTS: Filled = { gpu: 'auto', vramGb: 0, keepAliveMin: 30, callSeconds: 7200, ctx: 0, kvSlots: 4, maxEngines: 3 };

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
  if (next.kvSlots !== undefined) next.kvSlots = Math.max(1, Math.min(16, Math.round(next.kvSlots)));
  if (next.maxEngines !== undefined) next.maxEngines = Math.max(1, Math.min(8, Math.round(Number(next.maxEngines) || 1)));
  if (next.pinned !== undefined) next.pinned = Array.isArray(next.pinned) ? [...new Set(next.pinned.filter((m) => typeof m === 'string' && validModelName(m)))].slice(0, 8) : [];
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
type Launcher = (o: { model: string; dir: string; port: number; ramGb: number; gpu: boolean; vramGb: number; ctx: number; kvSlots: number; engineDir: string }) => Launch;

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
  if (o.kvSlots > 1) args.push('--kv-slots', String(o.kvSlots));
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

/**
 * An imported GGUF in "link" mode keeps its weights in models/.gguf/, outside the model folder. gguf.json has their
 * size; without it (or a size of 0) the GGUF file itself is measured, with all its parts (-00001-of-00003 …).
 */
function linkedGgufBytes(dir: string): number {
  let g: { mode?: string; size?: number; gguf?: string };
  try {
    g = JSON.parse(readFileSync(join(dir, 'gguf.json'), 'utf8'));
  } catch {
    return 0;
  }
  if (g.mode !== undefined && g.mode !== 'link') return 0;
  if (typeof g.size === 'number' && g.size > 0) return g.size;
  if (!g.gguf) return 0;
  // The path is written as the container sees it; read it relative to this models folder.
  const rel = g.gguf.replace(/\\/g, '/').split('/colibri/models/')[1];
  const file = rel ? join(state.modelsDir, ...rel.split('/')) : g.gguf;
  try {
    const parts = /^(.*)-\d{5}-of-(\d{5})\.gguf$/i.exec(basename(file));
    if (!parts) return statSync(file).size;
    const folder = dirname(file);
    return readdirSync(folder)
      .filter((n) => n.startsWith(`${parts[1]}-`) && n.endsWith(`-of-${parts[2]}.gguf`))
      .reduce((n, f) => n + statSync(join(folder, f)).size, 0);
  } catch {
    return 0;
  }
}

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
    const bytes = hit && Date.now() - hit.at < 10 * 60_000 ? hit.bytes : folderBytes(dir) + linkedGgufBytes(dir);
    sizes.set(dir, { at: Date.now(), bytes });
    return [{ model, dir, sizeBytes: bytes }];
  });
}

export const isInstalled = (model: string) => installedModels().some((m) => m.model === model);

/** A model folder name: letters, digits, dot, dash and underscore only (it becomes a path and a model id). */
export const validModelName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name);

export function deleteModel(model: string) {
  if (!validModelName(model)) throw new Error('Not a model name');
  if (engines.has(model)) void stopEngine(model);
  rmSync(join(state.modelsDir, model), { recursive: true, force: true });
  rmSync(join(state.modelsDir, '.gguf', model), { recursive: true, force: true });
  sizes.delete(join(state.modelsDir, model));
}

// ---- the engine processes ----

/**
 * Several models can be loaded at once, each in its own `coli serve` on its own port (Settings → Colibri → models
 * loaded at once). They share the RAM budget: a model that doesn't fit unloads the one used longest ago (pinned
 * models last), never one that is answering. Only one engine uses the GPU; the others run on the CPU.
 */
type EngineState = 'starting' | 'ready';
interface Engine {
  model: string;
  port: number;
  proc: ChildProcess;
  state: EngineState;
  since: number;
  gpu: boolean;
  kvSlots: number;
  /** The RAM it was given (--ram). */
  ramBytes: number;
  /** Calls using it right now: it is never stopped under them. */
  active: number;
  lastUsed: number;
  idle?: NodeJS.Timeout;
}
const engines = new Map<string, Engine>();
/** Every start and stop goes through this queue, so two calls never start the same engine twice. */
let queue: Promise<unknown> = Promise.resolve();
/** Called with the minimum RAM a model needs (from the catalog), or undefined when unknown. */
let ramNeedOf: (model: string) => Promise<number | undefined> = async () => undefined;
export const setRamNeedLookup = (fn: typeof ramNeedOf) => (ramNeedOf = fn);

const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

const alive = (e: Engine) => e.proc.exitCode === null && e.proc.signalCode === null;
const info = (e: Engine) => ({ model: e.model, state: e.state, since: e.since, gpu: e.gpu, kvSlots: e.kvSlots, port: e.port, ramBytes: e.ramBytes, active: e.active, lastUsed: e.lastUsed });

/** One model's engine, or (no model) the one used last. */
export function loadedModel(model?: string) {
  if (model) {
    const e = engines.get(model);
    return e && alive(e) ? info(e) : undefined;
  }
  return loadedModels()[0];
}

/** Every loaded model, the one used last first. */
export const loadedModels = () =>
  [...engines.values()]
    .filter(alive)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map(info);

/** Where a model's engine listens (the first port when it isn't loaded). */
export const colibriBase = (model?: string) => `http://127.0.0.1:${(model && engines.get(model)?.port) || loadedModel()?.port || state.port}`;

const logFileOf = (model: string) => join(config.dataDir, 'colibri', `engine-${model}.log`);
let lastLog = '';

function logTail(lines = 30, file = lastLog || logFile()): string {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines - 1).join('\n').trim();
  } catch {
    return '';
  }
}

async function healthy(port: number, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The engine's queue counters (GET /health), when it runs. */
export const engineHealth = (model?: string) => {
  const l = loadedModel(model);
  return l ? healthy(l.port) : Promise.resolve(undefined);
};

const isPinned = (model: string) => (colibriSettings().pinned ?? []).includes(model);

function resetIdle(e: Engine, keepAlive?: string) {
  if (e.idle) clearTimeout(e.idle);
  // Pinned models stay loaded until room is needed.
  if (isPinned(e.model)) return;
  const ms = keepAliveMs(keepAlive) ?? colibriSettings().keepAliveMin * 60_000;
  if (ms <= 0) return;
  e.idle = setTimeout(() => {
    // Never in the middle of an answer: try again later while it is busy.
    if (e.active > 0) return resetIdle(e, keepAlive);
    void stopEngine(e.model).then(() => rewarmPinned());
  }, ms);
  e.idle.unref();
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

async function drop(e: Engine) {
  if (e.idle) clearTimeout(e.idle);
  if (engines.get(e.model) === e) engines.delete(e.model);
  await kill(e.proc);
}

/** Unloads one model (or every model); it starts again on the next call. */
export function stopEngine(model?: string): Promise<void> {
  return serial(async () => {
    for (const e of [...engines.values()]) if (!model || e.model === model) await drop(e);
  });
}

/** Pinned models that were pushed out come back once there is room (after a big model was unloaded). */
let rewarming = false;
function rewarmPinned() {
  if (rewarming) return;
  const missing = (colibriSettings().pinned ?? []).filter((m) => !loadedModel(m) && isInstalled(m));
  if (!missing.length) return;
  rewarming = true;
  void (async () => {
    try {
      for (const m of missing) await warmModel(m).catch(() => {});
    } finally {
      rewarming = false;
    }
  })();
}

/** How long a model may take to load: the dense part is read from disk (a 744B model reads ~10 GB). */
const LOAD_TIMEOUT_MS = 30 * 60_000;

/** RAM to give a model: all of it in RAM when it fits (its files plus 2 GB to work), else everything there is. */
const ramWant = (m: InstalledModel, need: number | undefined, budget: number) => Math.min(budget, Math.max(need ?? 0, m.sizeBytes + 2e9));

/**
 * Makes sure `model` is served, starting its engine when needed (and unloading others to make room), and holds it
 * until release(): an engine with holders is never stopped. loaded: it had to load (the caller shows "loading").
 */
export function acquire(model: string, opts: { keepAlive?: string; signal?: AbortSignal } = {}): Promise<{ loaded: boolean; release: () => void }> {
  return serial(async () => {
    if (!colibriAvailable()) throw new Error('Colibri is not in this HiveMind image');
    let loaded = false;
    let e = engines.get(model);
    if (e && (!alive(e) || e.state !== 'ready')) {
      await drop(e);
      e = undefined;
    }
    if (!e) {
      const found = installedModels().find((m) => m.model === model);
      if (!found) throw new Error(`Colibri has no model "${model}" (Settings → Colibri → Download)`);
      const budget = ramBudgetBytes();
      const need = await ramNeedOf(model).catch(() => undefined);
      if (need && need > budget)
        throw new Error(
          `${model} needs ${Math.round(need / 1e9)} GB of RAM and colibri has ${Math.round(budget / 1e9)} GB here. Give HiveMind more memory (--memory in its Docker template) or pick a smaller model.`,
        );
      const want = ramWant(found, need, budget);
      const most = Math.max(1, colibriSettings().maxEngines);
      // Make room: unload the model used longest ago (pinned ones last), waiting for any that is answering.
      for (;;) {
        const others = [...engines.values()].filter(alive);
        const used = others.reduce((n, o) => n + o.ramBytes, 0);
        if (others.length < most && used + want <= budget) break;
        const idle = others.filter((o) => o.active === 0).sort((a, b) => Number(isPinned(a.model)) - Number(isPinned(b.model)) || a.lastUsed - b.lastUsed);
        if (idle[0]) {
          await drop(idle[0]);
          continue;
        }
        if (opts.signal?.aborted) throw new Error('Cancelled');
        await new Promise((r) => setTimeout(r, 300));
      }
      for (const dead of [...engines.values()].filter((o) => !alive(o))) engines.delete(dead.model);
      e = await start(found, want, opts);
      loaded = true;
    }
    const held = e;
    held.active++;
    held.lastUsed = Date.now();
    if (held.idle) clearTimeout(held.idle);
    let done = false;
    return {
      loaded,
      release: () => {
        if (done) return;
        done = true;
        held.active = Math.max(0, held.active - 1);
        held.lastUsed = Date.now();
        if (!held.active && engines.get(held.model) === held && alive(held)) resetIdle(held, opts.keepAlive);
      },
    };
  });
}

/** Loads a model (or keeps it loaded) without answering. */
export async function warmModel(model: string, keepAlive?: string) {
  (await acquire(model, { keepAlive })).release();
}

function freePort(): number {
  const taken = new Set([...engines.values()].map((e) => e.port));
  for (let i = 0; i < 32; i++) if (!taken.has(state.port + i)) return state.port + i;
  throw new Error('Colibri: no free port for another engine');
}

async function start(m: InstalledModel, ramBytes: number, opts: { keepAlive?: string; signal?: AbortSignal }, retried = false, cpuOnly = false, slots?: number): Promise<Engine> {
  const s = { ...colibriSettings(), ...(slots && { kvSlots: slots }) };
  // One engine on the GPU at a time: the others answer from the CPU.
  const gpu = !cpuOnly && gpuUsable() && ![...engines.values()].some((o) => o.gpu && alive(o));
  const port = freePort();
  const launch = (state.launcher ?? defaultLauncher)({
    model: m.model,
    dir: m.dir,
    port,
    ramGb: Math.floor(ramBytes / 1e9),
    gpu,
    vramGb: s.vramGb,
    ctx: s.ctx,
    kvSlots: s.kvSlots,
    engineDir: gpu ? cudaDir() : cpuDir(),
  });
  mkdirSync(join(config.dataDir, 'colibri'), { recursive: true });
  // The log restarts with each start, so it shows this engine's start and not last week's.
  const file = logFileOf(m.model);
  lastLog = file;
  writeFileSync(file, `--- ${new Date().toISOString()} ${m.model} (${gpu ? 'CUDA' : 'CPU'}, ${Math.floor(ramBytes / 1e9)} GB RAM, port ${port})\n`);
  const out = openSync(file, 'a');
  const child = spawn(launch.cmd, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['ignore', out, out] });
  closeSync(out);
  const e: Engine = { model: m.model, port, proc: child, state: 'starting', since: Date.now(), gpu, kvSlots: s.kvSlots, ramBytes, active: 0, lastUsed: Date.now() };
  engines.set(m.model, e);
  let exited = false;
  child.once('exit', (code, sig) => {
    exited = true;
    if (engines.get(m.model) === e) {
      engines.delete(m.model);
      if (e.idle) clearTimeout(e.idle);
      if (code && !sig && e.state === 'ready') logError({ source: 'server', message: `Colibri stopped (exit code ${code}) while serving ${m.model}`, detail: logTail(15, file) });
    }
  });
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
    if (opts.signal?.aborted) {
      await drop(e);
      throw new Error('Cancelled');
    }
    if (exited) {
      if (engines.get(m.model) === e) engines.delete(m.model);
      const tail = logTail(15, file);
      // A model family that keeps fewer conversations: start again with what it allows.
      const fewer = tail.match(/supports at most (\d+) KV slot/i);
      if (fewer && !slots) return start(m, ramBytes, opts, retried, cpuOnly, Math.max(1, Number(fewer[1])));
      // The CUDA build has no engine for this model family (it did not compile for CUDA): the CPU one, this time.
      if (gpu && !retried && /engine is not built/i.test(tail)) return start(m, ramBytes, opts, true, true);
      // The CUDA build can't run here (no driver, missing library, a card it was not built for): the CPU build.
      if (gpu && !retried && /error while loading shared libraries|no CUDA-capable device|CUDA driver|cuda(Get|Set|Malloc|Init)|libcu/i.test(tail)) {
        state.cudaBroken = true;
        logError({ source: 'server', message: 'Colibri: the CUDA build would not start here, using the CPU build', detail: tail });
        return start(m, ramBytes, opts, true);
      }
      throw new Error(`Colibri could not start ${m.model}: ${tail.split('\n').slice(-4).join(' ').slice(0, 600) || 'no output'}`);
    }
    if (await healthy(port, opts.signal)) {
      e.state = 'ready';
      return e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await drop(e);
  throw new Error(`Colibri took more than ${LOAD_TIMEOUT_MS / 60_000} minutes to load ${m.model}`);
}

/**
 * The KV slot for a call, so a repeated prompt is not read again (colibri keeps each slot's prompt): decisions get the
 * last slot to themselves, a chat the slot of its conversation (its system prompt and first question). undefined
 * with one slot.
 */
export function cacheSlot(kind: 'chat' | 'decide', key: string, model?: string): number | undefined {
  const slots = loadedModel(model)?.kvSlots ?? 1;
  if (slots <= 1) return undefined;
  if (kind === 'decide') return slots - 1;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % (slots - 1);
}

/** colibri's engine binaries (one per model family). */
const ENGINE_NAMES = ['colibri', 'qwen36', 'qwen38', 'deepseek_v4', 'deepseek_v41', 'glm53', 'mimo', 'olmoe', 'kimi_k3', 'inkling', 'laya', 'gliner_decide', 'qwenimage'];

/** Which engines each build has (a model family without its engine can't start). */
export function builtEngines(): { cpu: string[]; cuda: string[] } {
  const has = (dir: string) => ENGINE_NAMES.filter((n) => existsSync(join(dir, n)));
  return { cpu: has(cpuDir()), cuda: has(cudaDir()) };
}

/** Everything the Settings card shows. */
export async function colibriStatus() {
  const b = build();
  const live = loadedModel();
  const all = loadedModels();
  return {
    available: colibriAvailable(),
    engines: state.launcher ? undefined : builtEngines(),
    version: b.version,
    ref: b.ref,
    cudaBuilt: !!b.cuda,
    gpu: gpuUsable(),
    cudaBroken: state.cudaBroken,
    gpuDevice: existsSync('/dev/nvidia0'),
    containerLimitBytes: containerLimitBytes(),
    ramBudgetBytes: ramBudgetBytes(),
    loaded: live ? { model: live.model, state: live.state, since: new Date(live.since).toISOString(), gpu: live.gpu } : undefined,
    running: all.map((e) => ({ model: e.model, state: e.state, since: new Date(e.since).toISOString(), gpu: e.gpu, ramBytes: e.ramBytes, active: e.active, pinned: isPinned(e.model) })),
    health: live?.state === 'ready' ? await healthy(live.port) : undefined,
    log: logTail(40),
    settings: colibriSettings(),
  };
}

process.once('exit', () => {
  for (const e of engines.values()) e.proc.kill('SIGTERM');
});
