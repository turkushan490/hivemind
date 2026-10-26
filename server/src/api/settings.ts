import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { saveSearchSettings, searchSettings, webSearch } from '../services/search.js';
import { requireAdmin, requireUser } from './auth.js';

export function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/search', { preHandler: requireUser }, async () => searchSettings());

  app.put('/api/settings/search', { preHandler: requireAdmin }, async (req) => {
    saveSearchSettings((req.body ?? {}) as Parameters<typeof saveSearchSettings>[0]);
    return searchSettings();
  });

  /** Try a search with the current settings, so a wrong key shows up right away. */
  app.post('/api/settings/search/test', { preHandler: requireUser }, async (req, reply) => {
    const { q, source } = (req.body ?? {}) as { q?: string; source?: never };
    try {
      return await webSearch(q || 'Unraid', { source, count: 3 });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Memory blocks: see and clear what was remembered.
  app.get('/api/memory/keys', { preHandler: requireUser }, async (req) =>
    db.prepare('SELECT key, COUNT(*) AS count, MAX(created_at) AS last FROM memory WHERE owner_id = ? GROUP BY key ORDER BY last DESC').all(req.user!.id),
  );

  app.delete('/api/memory/keys/:key', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM memory WHERE owner_id = ? AND key = ?').run(req.user!.id, (req.params as { key: string }).key);
    return { ok: true };
  });
}
