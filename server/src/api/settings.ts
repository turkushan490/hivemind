import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { logError } from '../errors.js';
import { homeAssistantConnection, homeAssistantSettings, saveHomeAssistantSettings } from '../services/homeassistant.js';
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

  // ---- Home Assistant (for Home Assistant blocks) ----
  app.get('/api/settings/homeassistant', { preHandler: requireUser }, async () => homeAssistantSettings());

  app.put('/api/settings/homeassistant', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      saveHomeAssistantSettings((req.body ?? {}) as { url?: string; token?: string });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return homeAssistantSettings();
  });

  /** Checks address and token; on success also returns the entities, for the block's picker. */
  app.get('/api/homeassistant/entities', { preHandler: requireUser }, async (req, reply) => {
    const ha = homeAssistantConnection();
    if (!ha) return reply.code(400).send({ error: 'Home Assistant is not connected yet (Settings → Home Assistant)' });
    let res: Response;
    try {
      res = await fetch(`${ha.url}/api/states`, { headers: { authorization: `Bearer ${ha.token}` }, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      const message = `Can't reach Home Assistant at ${ha.url}: ${cause?.code ?? (err as Error).message}`;
      logError({ source: 'server', message, userId: req.user!.id });
      return reply.code(502).send({ error: message });
    }
    if (!res.ok) {
      const message = `Home Assistant answered HTTP ${res.status}${res.status === 401 ? ' — the token is wrong or expired' : ''}`;
      logError({ source: 'server', message, userId: req.user!.id });
      return reply.code(502).send({ error: message });
    }
    const states = (await res.json()) as { entity_id: string; state: string; attributes?: { friendly_name?: string } }[];
    return states
      .map((s) => ({ id: s.entity_id, name: s.attributes?.friendly_name ?? s.entity_id, state: s.state }))
      .sort((a, b) => a.id.localeCompare(b.id));
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
