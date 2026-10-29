import type { TrainBase, TrainJob, TrainOverview, TrainState } from '@hivemind/shared';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { newId, randomToken } from '../crypto.js';
import { db, getSetting } from '../db/index.js';
import { withHostLock, type ResolvedProvider } from '../engine/run.js';
import { logError } from '../errors.js';
import { exportJsonl } from './data.js';
import { activeLab } from './runner.js';

/**
 * "Make a new model": a QLoRA fine-tune of a base model on the Lab dataset, done by the trainer container
 * (Unsloth) on the same GPU, then imported into Ollama as a new model. HiveMind holds that GPU's lock for the
 * whole job, so Ollama, ComfyUI and the simulator wait ("Training — local AI paused").
 *
 * The trainer scripts ship with HiveMind and are copied into the shared Lab folder (/data/lab/trainer), which the
 * trainer container mounts as /lab; the token in that folder is the shared secret between the two.
 */

export const LAB_DIR = join(config.dataDir, 'lab');
const TRAINER_DIR = join(LAB_DIR, 'trainer');
const TRAIN_DIR = join(LAB_DIR, 'train');
export const MIN_ROWS = 20;
/** How often the trainer is asked for progress (TRAIN_POLL_MS for tests). */
const pollMs = () => Number(process.env.TRAIN_POLL_MS) || 5000;
/** Training starts only when the GPU has at most this much in use (desktop and other small programs). */
const gpuFreeMb = () => Number(process.env.TRAIN_GPU_FREE_MB) || 1536;

export const BASES: TrainBase[] = [
  { id: 'unsloth/Qwen3.5-9B', name: 'Qwen3.5 9B', note: 'Best quality that fits a 16 GB GPU; the base OmniCoder is built on. Slowest.', secPerStep: 25 },
  { id: 'unsloth/Qwen3.5-4B', name: 'Qwen3.5 4B', note: 'About twice as fast, a bit less smart.', secPerStep: 12 },
  { id: 'unsloth/Qwen3-8B', name: 'Qwen3 8B', note: 'Text-only previous generation; very well supported.', secPerStep: 22 },
  { id: 'unsloth/Qwen3.5-2B', name: 'Qwen3.5 2B', note: 'Fast and small; good for quick tests.', secPerStep: 6 },
  { id: 'unsloth/Qwen3.5-0.8B', name: 'Qwen3.5 0.8B', note: 'Tiny: only to test that training works end to end.', secPerStep: 3 },
];

/** Where the trainer listens: TRAINER_URL, else Settings. */
export const trainerUrl = () => (process.env.TRAINER_URL || getSetting('lab.trainerUrl') || '').trim().replace(/\/+$/, '') || undefined;

const tokenFile = join(TRAINER_DIR, 'token');
const trainerToken = () => readFileSync(tokenFile, 'utf8').trim();

/** Puts the trainer scripts (this HiveMind's version) and a token into the Lab folder. */
export function installTrainerScripts() {
  mkdirSync(TRAINER_DIR, { recursive: true });
  mkdirSync(TRAIN_DIR, { recursive: true });
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomToken(), { mode: 0o600 });
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: server/dist/main.js → server/trainer; from source: server/src/lab → server/trainer.
  const src = [resolve(here, '../trainer'), resolve(here, '../../trainer')].find((d) => existsSync(join(d, 'server.py')));
  if (!src) return logError({ source: 'server', message: 'Lab: the trainer scripts are missing from this HiveMind build' });
  for (const f of ['server.py', 'train.py']) copyFileSync(join(src, f), join(TRAINER_DIR, f));
}

async function trainer(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<any> {
  const url = trainerUrl();
  if (!url) throw new Error('The trainer is not set up: add its address in Lab → New model (or TRAINER_URL)');
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${trainerToken()}`, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    throw new Error(`Can't reach the trainer at ${url}: ${cause?.code ?? (err as Error).message} — is the hivemind-trainer container running?`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(`Trainer: ${data.error ?? `HTTP ${res.status}`}`);
  return data;
}

interface TrainRow {
  id: string;
  owner_id: string;
  base: string;
  name: string;
  provider_id: string;
  settings: string;
  rows: number;
  state: TrainState;
  progress: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const toJob = (r: TrainRow): TrainJob => ({
  id: r.id,
  base: r.base,
  name: r.name,
  providerId: r.provider_id,
  rows: r.rows,
  state: r.state,
  ...(r.progress ? JSON.parse(r.progress) : {}),
  ...(r.error && { error: r.error }),
  startedAt: r.started_at,
  ...(r.finished_at && { finishedAt: r.finished_at }),
});

const update = (id: string, state: TrainState, progress?: Record<string, unknown>, error?: string) =>
  db
    .prepare(`UPDATE lab_trains SET state = ?, progress = COALESCE(?, progress), error = ?, finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END WHERE id = ?`)
    .run(state, progress ? JSON.stringify(progress) : null, error ?? null, ['done', 'error', 'cancelled', 'interrupted'].includes(state) ? 1 : 0, id);

/** "dungeonmind-dm:v1": lowercase, no spaces; the tag is optional. */
export const validName = (name: string) => /^[a-z0-9][a-z0-9._-]{0,60}(:[a-z0-9][a-z0-9._-]{0,40})?$/.test(name);

export interface TrainDeps {
  resolve(providerId: string): Promise<ResolvedProvider>;
  freeGpu(hostKey: string, exceptProviderId?: string): Promise<void>;
  /** Base URL of the Ollama server the new model goes to. */
  ollamaUrl(providerId: string): string | undefined;
}

const running = new Map<string, AbortController>();

export function overviewRows(ownerId: string): number {
  return exportJsonl(ownerId).split('\n').filter(Boolean).length;
}

export async function overview(ownerId: string): Promise<TrainOverview> {
  let t: TrainOverview['trainer'] = { url: trainerUrl(), ok: false };
  if (t.url) {
    try {
      const h = await trainer('/health');
      t = { ...t, ok: true, gpu: h.gpu?.name ? h.gpu : undefined, busy: h.busy ?? null };
    } catch (err) {
      t.error = (err as Error).message;
    }
  } else t.error = 'Not set up yet';
  const jobs = (db.prepare('SELECT * FROM lab_trains WHERE owner_id = ? ORDER BY started_at DESC LIMIT 20').all(ownerId) as unknown as TrainRow[]).map(toJob);
  return { trainer: t, rows: overviewRows(ownerId), minRows: MIN_ROWS, bases: BASES, jobs };
}

/** Starts a job: the dataset is written now, the training waits for the GPU and then runs in the background. */
export function startTrain(
  ownerId: string,
  opts: { base: string; name: string; providerId: string; epochs?: number; maxSeqLength?: number; maxSteps?: number; allowSmall?: boolean },
  deps: TrainDeps,
): TrainJob {
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(opts.base)) throw Object.assign(new Error('The base model must be a Hugging Face repo, e.g. unsloth/Qwen3.5-9B'), { statusCode: 400 });
  if (!validName(opts.name)) throw Object.assign(new Error('Name the new model like dungeonmind-dm:v1 (lowercase letters, digits, . _ -)'), { statusCode: 400 });
  if (!deps.ollamaUrl(opts.providerId)) throw Object.assign(new Error('Pick the Ollama server the new model goes to'), { statusCode: 400 });
  if ([...running.keys()].length) throw Object.assign(new Error('A model is already being made: wait for it or cancel it'), { statusCode: 409 });
  const dataset = exportJsonl(ownerId);
  const rows = dataset.split('\n').filter(Boolean).length;
  if (rows < (opts.allowSmall ? 1 : MIN_ROWS))
    throw Object.assign(new Error(`Only ${rows} training examples: let the simulator collect at least ${MIN_ROWS} good turns first (a few hundred is better)`), { statusCode: 400 });
  const id = newId().replace(/[^A-Za-z0-9_-]/g, '');
  const dir = join(TRAIN_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dataset.jsonl'), `${dataset}\n`);
  const settings = {
    base: opts.base,
    epochs: Math.max(1, Math.min(10, opts.epochs ?? 2)),
    maxSeqLength: Math.max(1024, Math.min(16384, opts.maxSeqLength ?? 4096)),
    ...(opts.maxSteps && { maxSteps: Math.max(1, Math.min(100_000, opts.maxSteps)) }),
    quant: 'q4_k_m',
  };
  db.prepare("INSERT INTO lab_trains (id, owner_id, base, name, provider_id, settings, rows, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')").run(
    id,
    ownerId,
    opts.base,
    opts.name,
    opts.providerId,
    JSON.stringify(settings),
    rows,
  );
  void run(id, ownerId, deps, false);
  return toJob(db.prepare('SELECT * FROM lab_trains WHERE id = ?').get(id) as unknown as TrainRow);
}

/** The whole job; resume=true picks up a job that was already started on the trainer (after a HiveMind restart). */
async function run(id: string, ownerId: string, deps: TrainDeps, resume: boolean) {
  const row = db.prepare('SELECT * FROM lab_trains WHERE id = ?').get(id) as unknown as TrainRow;
  const abort = new AbortController();
  running.set(id, abort);
  try {
    const target = await deps.resolve(row.provider_id);
    // A simulation would only wait behind the lock for hours: stop it.
    const lab = activeLab();
    if (lab?.status.running) {
      lab.stop();
      await lab.done.catch(() => {});
    }
    update(id, 'waiting', { note: 'Waiting for the GPU' });
    await withHostLock(target.hostKey, async () => {
      if (abort.signal.aborted) return;
      update(id, 'starting', { note: 'Freeing the GPU (Ollama, ComfyUI)' });
      await deps.freeGpu(target.hostKey).catch(() => {});
      if (!resume) {
        // Something outside HiveMind (an image still being made in ComfyUI) can keep the memory: wait until it's free.
        for (;;) {
          if (abort.signal.aborted) return update(id, 'cancelled', { note: 'Cancelled while waiting for the GPU' });
          const gpu = (await trainer('/health').catch(() => undefined))?.gpu as { usedMb?: number; totalMb?: number } | undefined;
          if (!gpu?.usedMb || gpu.usedMb <= gpuFreeMb()) break;
          update(id, 'waiting', { note: `The GPU is busy (${(gpu.usedMb / 1024).toFixed(1)} GB in use, e.g. an image in ComfyUI) — training starts when it's free` });
          await new Promise((r) => setTimeout(r, pollMs() * 6));
          await deps.freeGpu(target.hostKey).catch(() => {});
        }
        await trainer('/jobs', { method: 'POST', body: JSON.stringify({ id, ...JSON.parse(row.settings) }) });
      }
      // Poll until the trainer is done; the lock stays held, so local AI on this GPU waits.
      for (;;) {
        if (abort.signal.aborted) {
          await trainer(`/jobs/${id}/cancel`, { method: 'POST' }, 30_000).catch(() => {});
          update(id, 'cancelled', { note: 'Cancelled' });
          return;
        }
        let s: Record<string, any>;
        try {
          s = await trainer(`/jobs/${id}`);
        } catch (err) {
          // A short hiccup (trainer busy writing a checkpoint) is not the end of the job.
          update(id, row.state, { note: (err as Error).message });
          await new Promise((r) => setTimeout(r, pollMs() * 3));
          continue;
        }
        const progress = { step: s.step, totalSteps: s.totalSteps, loss: s.loss, etaS: s.etaS, note: s.note, log: s.log };
        if (s.state === 'error') throw new Error(s.error || 'The trainer failed (see the log)');
        if (s.state === 'cancelled') return update(id, 'cancelled', progress);
        if (s.state === 'done') {
          update(id, 'importing', { ...progress, note: `Importing ${s.gguf} into Ollama` });
          await importGguf(join(TRAIN_DIR, id, s.gguf), row.name, deps.ollamaUrl(row.provider_id)!, abort.signal);
          return update(id, 'done', { ...progress, etaS: 0, note: `Ready: ${row.name}` });
        }
        update(id, (['loading', 'training', 'exporting'].includes(s.state) ? s.state : 'starting') as TrainState, progress);
        await new Promise((r) => setTimeout(r, pollMs()));
      }
    });
  } catch (err) {
    const message = (err as Error).message;
    update(id, 'error', undefined, message);
    logError({ source: 'server', message: `Lab: making ${row.name} failed: ${message}`, userId: ownerId });
  } finally {
    running.delete(id);
  }
}

export function cancelTrain(id: string, ownerId: string): boolean {
  const row = db.prepare('SELECT id FROM lab_trains WHERE id = ? AND owner_id = ?').get(id, ownerId);
  const job = running.get(id);
  if (!row || !job) return false;
  job.abort();
  return true;
}

/** After a restart: jobs that were running keep going on the trainer, so HiveMind follows them again. */
export function resumeTrains(depsFor: (ownerId: string) => TrainDeps) {
  const rows = db.prepare("SELECT id, owner_id, state FROM lab_trains WHERE state NOT IN ('done', 'error', 'cancelled', 'interrupted')").all() as { id: string; owner_id: string; state: TrainState }[];
  for (const r of rows) {
    if (r.state === 'waiting' || r.state === 'importing') {
      update(r.id, 'interrupted', undefined, 'HiveMind restarted before this step finished; start it again');
      continue;
    }
    void run(r.id, r.owner_id, depsFor(r.owner_id), true);
  }
}

/** The GGUF into Ollama: upload it as a blob, then create the model from it (Ollama reads the chat template from the GGUF). */
export async function importGguf(file: string, name: string, ollamaUrl: string, signal?: AbortSignal) {
  if (!existsSync(file)) throw new Error(`The trainer said it made ${basename(file)}, but HiveMind can't find it in the Lab folder`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const digest = `sha256:${hash.digest('hex')}`;
  const base = ollamaUrl.replace(/\/+$/, '');
  const head = await fetch(`${base}/api/blobs/${digest}`, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
  if (!head.ok) {
    const up = await fetch(`${base}/api/blobs/${digest}`, {
      method: 'POST',
      body: Readable.toWeb(createReadStream(file)) as unknown as RequestInit['body'],
      headers: { 'content-length': String(statSync(file).size) },
      duplex: 'half',
      signal,
    } as RequestInit);
    if (!up.ok) throw new Error(`Ollama refused the model file: HTTP ${up.status} ${(await up.text().catch(() => '')).slice(0, 200)}`);
  }
  const res = await fetch(`${base}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: name, files: { [basename(file)]: digest }, stream: false }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) : AbortSignal.timeout(30 * 60_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
  if (!res.ok || data.error) throw new Error(`Ollama could not create ${name}: ${data.error ?? `HTTP ${res.status}`}`);
}

/** Every GGUF a job made (for a manual import or download). */
export const jobFiles = (id: string) => {
  const dir = join(TRAIN_DIR, id, 'gguf');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.gguf')) : [];
};
