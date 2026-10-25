import type { ProviderMemory } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { describe, logError } from '../errors.js';
import { requireUser } from './auth.js';
import { adapterFor, canEdit, rowFor, visibleRows } from './providers.js';

export function memoryRoutes(app: FastifyInstance) {
  /** What every local provider (Ollama) holds in RAM/VRAM right now. */
  app.get('/api/memory', { preHandler: requireUser }, async (req): Promise<ProviderMemory[]> => {
    const rows = visibleRows(req.user!).filter((r) => r.enabled && r.local);
    return Promise.all(
      rows.map(async (r) => {
        const base = { providerId: r.id, name: r.name, canUnload: canEdit(req.user!, r) };
        try {
          return { ...base, models: (await adapterFor(r).loaded?.()) ?? [] };
        } catch (err) {
          return { ...base, models: [], error: describe(err).message };
        }
      }),
    );
  });

  /** Body: { providerId?, model? }. No providerId = every local provider; no model = everything loaded. */
  app.post('/api/memory/unload', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { providerId?: string; model?: string };
    const rows = body.providerId
      ? [rowFor(req.user!, body.providerId)].filter((r) => !!r)
      : visibleRows(req.user!).filter((r) => r.enabled && r.local);
    if (rows.length === 0) return reply.code(404).send({ error: 'Provider not found' });
    const unloaded: string[] = [];
    const failed: { model: string; error: string }[] = [];
    for (const r of rows) {
      if (!canEdit(req.user!, r)) {
        failed.push({ model: r.name, error: 'Only an admin can unload shared providers' });
        continue;
      }
      const adapter = adapterFor(r);
      if (!adapter.loaded || !adapter.unload) continue;
      try {
        const models = body.model ? [body.model] : (await adapter.loaded()).map((m) => m.model);
        for (const m of models) {
          try {
            await adapter.unload(m);
            unloaded.push(m);
          } catch (err) {
            failed.push({ model: m, error: describe(err).message });
          }
        }
      } catch (err) {
        failed.push({ model: r.name, error: describe(err).message });
      }
    }
    for (const f of failed) logError({ source: 'provider', message: `Unload ${f.model} failed: ${f.error}`, userId: req.user!.id });
    return { unloaded, failed };
  });
}
