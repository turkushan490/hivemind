import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { logError } from '../errors.js';
import { forgetKey, importMemory, keyExists, MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, searchMemory } from '../services/memory.js';
import { homeAssistantConnection, homeAssistantSettings, saveHomeAssistantSettings } from '../services/homeassistant.js';
import { saveSearchSettings, searchSettings, webSearch } from '../services/search.js';
import { requireAdmin, requireUser } from './auth.js';
import { memoryAllowed } from './scope.js';

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
    (
      db
        .prepare(
          `SELECT m.key, COUNT(*) AS count, MAX(m.created_at) AS last, COALESCE(k.pinned, 0) AS pinned FROM memory m
           LEFT JOIN memory_keys k ON k.owner_id = m.owner_id AND k.key = m.key WHERE m.owner_id = ? GROUP BY m.key ORDER BY last DESC`,
        )
        .all(req.user!.id) as { key: string; count: number; last: string; pinned: number }[]
    )
      .filter((r) => memoryAllowed(req.user!, r.key))
      .map((r) => ({ ...r, pinned: !!r.pinned })),
  );

  app.delete('/api/memory/keys/:key', { preHandler: requireUser }, async (req) => {
    forgetKey(req.user!.id, (req.params as { key: string }).key);
    return { ok: true };
  });

  /** Bulk import (e.g. every rule of an SRD, one entry each). The key is kept whole: never trimmed to 500. */
  app.post('/api/memory/keys/:key/import', { preHandler: requireUser, bodyLimit: MAX_IMPORT_BYTES }, async (req, reply) => {
    const key = (req.params as { key: string }).key.trim();
    if (!key || key.length > 120) return reply.code(400).send({ error: 'The memory key must be 1-120 characters' });
    const body = (req.body ?? {}) as { entries?: unknown; replace?: boolean };
    if (!Array.isArray(body.entries)) return reply.code(400).send({ error: 'Send { entries: [{ text, tags? }], replace? }' });
    if (body.entries.length > MAX_IMPORT_ENTRIES) return reply.code(413).send({ error: `At most ${MAX_IMPORT_ENTRIES} entries per import` });
    const entries: { text: string; tags?: string[] }[] = [];
    for (const e of body.entries as { text?: unknown; tags?: unknown }[]) {
      if (!e || typeof e.text !== 'string') return reply.code(400).send({ error: 'Every entry needs a text' });
      if (e.tags !== undefined && !Array.isArray(e.tags)) return reply.code(400).send({ error: 'tags must be a list of strings' });
      entries.push({ text: e.text, tags: e.tags as string[] | undefined });
    }
    return { imported: importMemory(req.user!.id, key, entries, !!body.replace), key };
  });

  /** The best matches in one key, as a Memory block in search mode finds them. */
  app.post('/api/memory/keys/:key/search', { preHandler: requireUser }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const { query, limit } = (req.body ?? {}) as { query?: unknown; limit?: unknown };
    if (typeof query !== 'string' || !query.trim()) return reply.code(400).send({ error: 'Send a query' });
    if (!keyExists(req.user!.id, key)) return reply.code(404).send({ error: `Nothing is remembered under "${key}"` });
    return searchMemory(req.user!.id, key, query, typeof limit === 'number' ? limit : 5);
  });
}
