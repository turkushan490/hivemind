import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '../crypto.js';
import { logError } from '../errors.js';
import { colibriAvailable, colibriModelsDir, installedModels, ramBudgetBytes, setRamNeedLookup, validModelName } from './engine.js';

/** One entry of colibri's own catalog (c/setup_catalog.py) against this container's RAM and disk. */
export interface CatalogModel {
  id: string;
  name: string;
  family: string;
  repo: string;
  download_gb: number;
  ram_min_gb: number;
  ram_good_gb: number;
  dense_gb: number;
  runs: string;
  summary: string;
  status: 'good' | 'tight' | 'needs-ram' | 'needs-disk' | 'unsupported';
  fits: boolean;
  reason: string;
  recommended: boolean;
  license_note: string;
  size_class: 'small' | 'large';
  installed: boolean;
  downloaded_bytes: number;
}

export interface ColibriJob {
  id: string;
  kind: 'download' | 'gguf';
  model: string;
  label: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  doneBytes: number;
  totalBytes: number;
  file?: string;
  error?: string;
  startedAt: number;
}

/** The bridge script (server/colibri/helper.py), bundled or from source. */
function helperPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, '../colibri/helper.py'), resolve(here, '../../colibri/helper.py')].find((p) => existsSync(p));
}

const python = () => [process.env.COLIBRI_PYTHON, '/opt/unsloth-venv/bin/python', '/usr/bin/python3'].find((p) => p && existsSync(p)) ?? 'python3';

type Line = { type: 'progress' | 'result' | 'error'; [k: string]: unknown };

/** Runs one helper command; progress lines go to onLine, the result line is returned. */
export type HelperRunner = (args: string[], env: Record<string, string>, onLine: (l: Line) => void, signal?: AbortSignal) => Promise<Line>;

const spawnHelper: HelperRunner = (args, env, onLine, signal) =>
  new Promise((resolvePromise, reject) => {
    const helper = helperPath();
    if (!helper || !colibriAvailable()) return reject(new Error('Colibri is not in this HiveMind image'));
    const child = spawn(python(), [helper, ...args], { env: { ...process.env, COLIBRI_DIR: join(process.env.COLIBRI_DIR || '/opt/colibri', 'cpu', 'c'), ...env }, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let buf = '';
    let err = '';
    let result: Line | undefined;
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          const line = JSON.parse(raw) as Line;
          if (line.type === 'progress') onLine(line);
          else result = line;
        } catch {}
      }
    });
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (result?.type === 'error') return reject(new Error(String(result.message)));
      if (code === 0 && result) return resolvePromise(result);
      reject(new Error(signal?.aborted ? 'Cancelled' : err.trim().split('\n').slice(-3).join(' ') || `colibri helper exit code ${code}`));
    });
  });

let runner: HelperRunner = spawnHelper;
/** Tests: a fake helper. */
export const setHelperRunner = (r: HelperRunner) => (runner = r);

/** The Hugging Face token (Settings → Hugging Face), for gated or private models. */
let hfToken: () => string | undefined = () => undefined;
export const setHfTokenSource = (fn: () => string | undefined) => (hfToken = fn);
const tokenEnv = (): Record<string, string> => {
  const t = hfToken();
  return t ? { HF_TOKEN: t } : {};
};

let cached: { at: number; ram: number; models: CatalogModel[]; diskFree: number } | undefined;

/** Colibri's catalog against this container (cached a minute). */
export async function catalog(fresh = false): Promise<{ models: CatalogModel[]; diskFree: number }> {
  const ram = ramBudgetBytes();
  if (!fresh && cached && cached.ram === ram && Date.now() - cached.at < 60_000) return cached;
  const r = await runner(['catalog', String(Math.floor(ram)), colibriModelsDir()], tokenEnv(), () => {});
  cached = { at: Date.now(), ram, models: (r.models as CatalogModel[]) ?? [], diskFree: Number(r.disk_free) || 0 };
  return cached;
}

/** Catalog facts by model folder name (the catalog id); imports have none. */
export async function catalogEntry(model: string): Promise<CatalogModel | undefined> {
  return (await catalog().catch(() => undefined))?.models.find((m) => m.id === model);
}

// The engine refuses a model whose minimum RAM is more than it has.
setRamNeedLookup(async (model) => {
  const e = await catalogEntry(model);
  return e ? e.ram_min_gb * 1e9 : undefined;
});

const jobs = new Map<string, ColibriJob & { abort: AbortController }>();
const publicJob = ({ abort, ...j }: ColibriJob & { abort: AbortController }): ColibriJob => j;
export const listJobs = () => [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt - a.startedAt);

function startJob(kind: ColibriJob['kind'], model: string, label: string, args: string[]): ColibriJob {
  const running = [...jobs.values()].find((j) => j.model === model && j.state === 'running');
  if (running) return publicJob(running);
  const job: ColibriJob & { abort: AbortController } = { id: newId(), kind, model, label, state: 'running', doneBytes: 0, totalBytes: 0, startedAt: Date.now(), abort: new AbortController() };
  jobs.set(job.id, job);
  runner(
    args,
    tokenEnv(),
    (l) => {
      job.doneBytes = Number(l.done) || job.doneBytes;
      job.totalBytes = Number(l.total) || job.totalBytes;
      if (l.file) job.file = String(l.file);
      if (l.label) job.label = String(l.label);
    },
    job.abort.signal,
  ).then(
    () => {
      job.state = 'done';
      job.label = `${label}: ready`;
      cached = undefined;
    },
    (err: Error) => {
      job.state = job.abort.signal.aborted ? 'cancelled' : 'error';
      if (job.state === 'error') {
        job.error = err.message;
        logError({ source: 'server', message: `Colibri: ${label} failed: ${err.message}` });
      }
      cached = undefined;
    },
  );
  // Finished jobs are forgotten after a day.
  for (const [id, j] of jobs) if (j.state !== 'running' && Date.now() - j.startedAt > 86_400_000) jobs.delete(id);
  return publicJob(job);
}

/** Downloads a catalog model (resumes a half-finished one). */
export async function startDownload(id: string): Promise<ColibriJob> {
  const entry = (await catalog()).models.find((m) => m.id === id);
  if (!entry) throw new Error(`Colibri's catalog has no model "${id}"`);
  if (entry.status === 'needs-disk') throw new Error(entry.reason);
  return startJob('download', id, `Download ${entry.name}`, ['download', id, colibriModelsDir()]);
}

/** A GGUF from Hugging Face, imported with `coli import` (the weights are read from the GGUF in place). */
export function startGguf(repo: string, file: string, name: string): ColibriJob {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('The repository looks like owner/name');
  if (!/^[\w.*?\-/[\]]+\.gguf$/i.test(file) || file.includes('..')) throw new Error('The file looks like model-Q4_K_M.gguf (or a pattern like *Q4_K_M*.gguf)');
  if (!validModelName(name)) throw new Error('The name may only have letters, digits, dot, dash and underscore');
  if (installedModels().some((m) => m.model === name)) throw new Error(`There is already a colibri model called ${name}`);
  return startJob('gguf', name, `Import ${repo}`, ['gguf', repo, file, colibriModelsDir(), name]);
}

export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.state !== 'running') return false;
  j.abort.abort();
  return true;
}
