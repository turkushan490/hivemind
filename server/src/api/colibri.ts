import type { FastifyInstance } from 'fastify';
import { colibriStatus, deleteModel, isInstalled, saveColibriSettings, stopEngine, warmModel, type ColibriSettings } from '../colibri/engine.js';
import { cancelJob, catalog, listJobs, setHfTokenSource, startDownload, startGguf } from '../colibri/models.js';
import { db } from '../db/index.js';
import { DEFAULT_PRIORITY, withHostLock } from '../engine/run.js';
import { token as hfToken } from '../lab/hf.js';
import { requireAdmin } from './auth.js';
import { colibriGpuHost, forgetModels, gpuFreerFor } from './providers.js';

setHfTokenSource(hfToken);

/** The model lists of the colibri providers change with every download, import and delete. */
const forgetColibriModels = () => {
  for (const r of db.prepare("SELECT id FROM providers WHERE preset IN ('colibri', 'colibri-decisions')").all() as { id: string }[]) forgetModels(r.id);
};

/** Settings → Colibri: the built-in engine, its models (colibri's own catalog, GGUF imports) and its settings. Admins only. */
export function colibriRoutes(app: FastifyInstance) {
  app.get('/api/colibri/status', { preHandler: requireAdmin }, async () => ({ ...(await colibriStatus()), gpuHost: colibriGpuHost(), jobs: listJobs() }));

  app.put('/api/colibri/settings', { preHandler: requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as ColibriSettings;
    const keys: (keyof ColibriSettings)[] = ['ramGb', 'gpu', 'vramGb', 'keepAliveMin', 'callSeconds', 'gpuHost', 'ctx', 'kvSlots', 'maxEngines', 'pinned'];
    const patch = Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) as ColibriSettings;
    return saveColibriSettings(patch);
  });

  app.get('/api/colibri/catalog', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return await catalog((req.query as { fresh?: string }).fresh === '1');
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/colibri/jobs', { preHandler: requireAdmin }, async () => listJobs());

  app.post('/api/colibri/download', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const job = await startDownload(String((req.body as { id?: string })?.id ?? ''));
      forgetColibriModels();
      return job;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/colibri/import', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { repo?: string; file?: string; name?: string };
    try {
      return startGguf((b.repo ?? '').trim(), (b.file ?? '').trim(), (b.name ?? '').trim());
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/colibri/jobs/:id/cancel', { preHandler: requireAdmin }, async (req, reply) =>
    cancelJob((req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'No running job with that id' }),
  );

  app.delete('/api/colibri/models/:name', { preHandler: requireAdmin }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!isInstalled(name) && !(await catalog().catch(() => undefined))?.models.some((m) => m.id === name && m.downloaded_bytes > 0)) return reply.code(404).send({ error: 'No such model' });
    deleteModel(name);
    forgetColibriModels();
    return { ok: true };
  });

  /** Load now: takes its turn on the GPU like a run would (Ollama and ComfyUI make room first). */
  app.post('/api/colibri/load', { preHandler: requireAdmin }, async (req, reply) => {
    const model = String((req.body as { model?: string })?.model ?? '');
    if (!isInstalled(model)) return reply.code(404).send({ error: 'No such model' });
    const row = db.prepare("SELECT id FROM providers WHERE preset = 'colibri' LIMIT 1").get() as { id: string } | undefined;
    const host = colibriGpuHost();
    try {
      await withHostLock(
        host,
        async () => {
          await gpuFreerFor(req.user!)(host, row?.id, { model }).catch(() => {});
          await warmModel(model);
        },
        { label: `Colibri: loading ${model}`, priority: DEFAULT_PRIORITY },
      );
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Unloads one model ({ model }) or every colibri model. */
  app.post('/api/colibri/unload', { preHandler: requireAdmin }, async (req) => {
    const model = (req.body as { model?: string } | undefined)?.model;
    await stopEngine(typeof model === 'string' && model ? model : undefined);
    return { ok: true };
  });
}
