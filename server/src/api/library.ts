import { OLLAMA_PICKS, type HfFile, type HfRepo, type ModelInfo, type PullJob } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { newId } from '../crypto.js';
import { describe, logError } from '../errors.js';
import { requireUser, type User } from './auth.js';
import { adapterFor, canEdit, forgetModels, rowFor, visibleRows } from './providers.js';

// Downloads run in the background on the server, so they keep going when the page is closed.
const jobs = new Map<string, PullJob & { abort: AbortController; ownerId: string }>();

const MODEL_NAME = /^[\w.\-/:]{1,200}$/;

const publicJob = ({ abort, ownerId, ...j }: PullJob & { abort: AbortController; ownerId: string }): PullJob => j;

function localRow(user: User, providerId: string) {
  const row = rowFor(user, providerId);
  if (!row || !row.local) throw Object.assign(new Error('Local provider not found'), { statusCode: 404 });
  return row;
}

function startPull(user: User, providerId: string, model: string): PullJob {
  const row = localRow(user, providerId);
  if (!canEdit(user, row)) throw Object.assign(new Error('Only an admin can download models to a shared provider'), { statusCode: 403 });
  const running = [...jobs.values()].find((j) => j.providerId === providerId && j.model === model && j.state === 'running');
  if (running) return publicJob(running);
  const adapter = adapterFor(row);
  if (!adapter.pull) throw Object.assign(new Error('This provider cannot download models'), { statusCode: 400 });

  const job: PullJob & { abort: AbortController; ownerId: string } = {
    id: newId(),
    providerId,
    model,
    status: 'starting',
    state: 'running',
    startedAt: Date.now(),
    abort: new AbortController(),
    ownerId: user.id,
  };
  jobs.set(job.id, job);
  (async () => {
    try {
      for await (const p of adapter.pull!(model, job.abort.signal)) {
        job.status = p.status;
        // Ollama reports progress per layer; follow the biggest one (the weights).
        if (p.total && p.total >= (job.totalBytes ?? 0)) {
          job.totalBytes = p.total;
          job.doneBytes = p.completed ?? 0;
        }
      }
      job.state = 'done';
      job.status = 'success';
    } catch (err) {
      if (job.abort.signal.aborted) {
        job.state = 'cancelled';
        job.status = 'cancelled';
      } else {
        job.state = 'error';
        job.error = describe(err).message;
        logError({ source: 'provider', message: `Download ${model} failed: ${job.error}`, userId: user.id });
      }
    } finally {
      forgetModels(providerId);
      // Finished jobs stay visible for a while, then disappear.
      setTimeout(() => jobs.delete(job.id), 30 * 60_000).unref();
    }
  })();
  return publicJob(job);
}

// ---- Hugging Face ----
// Longest forms first, so Q4_0_4_4 is not read as Q4_0 and Q4_K_XL not as Q4_K.
const QUANT = /(IQ\d_[A-Z]+|Q\d_K_XL|Q\d_K(?:_[SML])?|Q\d_\d(?:_\d_\d)?|BF16|F16|F32)/i;

async function hfJson(url: string) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`Hugging Face answered HTTP ${res.status}`), { statusCode: 502 });
  return res.json();
}

// OpenRouter's catalog is public: show its free models before you even have a key.
let orCache: { at: number; models: ModelInfo[] } | undefined;

export function libraryRoutes(app: FastifyInstance) {
  app.get('/api/ollama/picks', async () => OLLAMA_PICKS);

  app.get('/api/ollama/pulls', { preHandler: requireUser }, async (req) => {
    const visible = new Set(visibleRows(req.user!).map((r) => r.id));
    return [...jobs.values()].filter((j) => visible.has(j.providerId)).map(publicJob).sort((a, b) => b.startedAt - a.startedAt);
  });

  app.post('/api/ollama/:providerId/pull', { preHandler: requireUser }, async (req, reply) => {
    const model = String((req.body as { model?: string })?.model ?? '').trim();
    if (!MODEL_NAME.test(model)) return reply.code(400).send({ error: 'Not a valid model name (example: qwen3:4b or hf.co/user/repo:Q4_K_M)' });
    return startPull(req.user!, (req.params as { providerId: string }).providerId, model);
  });

  app.post('/api/ollama/pulls/:id/cancel', { preHandler: requireUser }, async (req, reply) => {
    const job = jobs.get((req.params as { id: string }).id);
    if (!job || (job.ownerId !== req.user!.id && req.user!.role !== 'admin')) return reply.code(404).send({ error: 'Download not found' });
    job.abort.abort();
    return { ok: true };
  });

  app.delete('/api/ollama/:providerId/models', { preHandler: requireUser }, async (req, reply) => {
    const row = localRow(req.user!, (req.params as { providerId: string }).providerId);
    if (!canEdit(req.user!, row)) return reply.code(403).send({ error: 'Only an admin can delete models from a shared provider' });
    const model = String((req.query as { model?: string }).model ?? '');
    if (!MODEL_NAME.test(model)) return reply.code(400).send({ error: 'Not a valid model name' });
    const adapter = adapterFor(row);
    try {
      await adapter.unload?.(model).catch(() => {});
      await adapter.remove!(model);
    } catch (err) {
      const { message } = describe(err);
      logError({ source: 'provider', message: `Delete ${model} failed: ${message}`, userId: req.user!.id });
      return reply.code(502).send({ error: message });
    }
    forgetModels(row.id);
    return { ok: true };
  });

  app.get('/api/hf/search', { preHandler: requireUser }, async (req): Promise<HfRepo[]> => {
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    const url = new URL('https://huggingface.co/api/models');
    if (q) url.searchParams.set('search', q);
    url.searchParams.set('filter', 'gguf');
    url.searchParams.set('sort', 'downloads');
    url.searchParams.set('direction', '-1');
    url.searchParams.set('limit', '30');
    const data = (await hfJson(url.toString())) as { id: string; downloads?: number; likes?: number; lastModified?: string }[];
    return data.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, updatedAt: m.lastModified }));
  });

  app.get('/api/hf/files', { preHandler: requireUser }, async (req, reply): Promise<HfFile[] | void> => {
    const repo = String((req.query as { repo?: string }).repo ?? '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return reply.code(400).send({ error: 'Not a valid repo (user/name)' });
    const tree = (await hfJson(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`)) as {
      type: string;
      path: string;
      size?: number;
      lfs?: { size?: number };
    }[];
    const files: HfFile[] = [];
    for (const f of tree) {
      if (f.type !== 'file' || !f.path.toLowerCase().endsWith('.gguf') || /mmproj/i.test(f.path)) continue;
      const quant = f.path.match(QUANT)?.[1]?.toUpperCase();
      if (!quant) continue;
      files.push({
        file: f.path,
        quant,
        sizeBytes: f.lfs?.size ?? f.size,
        pullName: `hf.co/${repo}:${quant}`,
        split: /-\d{5}-of-\d{5}\.gguf$/i.test(f.path),
      });
    }
    // One entry per quant: Ollama picks the file by its quant tag.
    const seen = new Set<string>();
    return files
      .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))
      .filter((f) => !seen.has(f.quant) && seen.add(f.quant));
  });

  app.get('/api/catalog/openrouter-free', async (_req, reply) => {
    if (orCache && Date.now() - orCache.at < 3600_000) return orCache.models;
    try {
      const data = (await (await fetch('https://openrouter.ai/api/v1/models')).json()) as { data?: { id: string; name?: string; context_length?: number }[] };
      const models = (data.data ?? [])
        .filter((m) => m.id.endsWith(':free'))
        .map((m) => ({ providerId: 'openrouter', model: m.id, name: m.name ?? m.id, free: true, contextLength: m.context_length }));
      orCache = { at: Date.now(), models };
      return models;
    } catch (err) {
      return reply.code(502).send({ error: `Could not load the OpenRouter catalog: ${describe(err).message}` });
    }
  });
}
