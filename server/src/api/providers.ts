import { PROVIDER_PRESETS, type ModelInfo, type ProviderInfo, type ProviderKind } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { decrypt, encrypt, newId } from '../crypto.js';
import { db } from '../db/index.js';
import type { ResolvedProvider } from '../engine/run.js';
import { createAdapter } from '../providers/index.js';
import { requireUser, type User } from './auth.js';

interface ProviderRow {
  id: string;
  preset: string;
  kind: ProviderKind;
  name: string;
  base_url: string;
  api_key_enc: string | null;
  owner_id: string | null;
  enabled: number;
  local: number;
}

const toInfo = (r: ProviderRow): ProviderInfo => ({
  id: r.id,
  preset: r.preset,
  kind: r.kind,
  name: r.name,
  baseUrl: r.base_url,
  hasKey: !!r.api_key_enc,
  enabled: !!r.enabled,
  local: !!r.local,
  shared: r.owner_id === null,
});

/** Shared providers (admin-made, owner null) plus the user's own. */
function visibleRows(user: User): ProviderRow[] {
  return db.prepare('SELECT * FROM providers WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at').all(user.id) as unknown as ProviderRow[];
}

function rowFor(user: User, id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)').get(id, user.id) as ProviderRow | undefined;
}

const canEdit = (user: User, row: ProviderRow) => (row.owner_id === null ? user.role === 'admin' : row.owner_id === user.id);

function adapterFor(row: ProviderRow) {
  return createAdapter({ id: row.id, kind: row.kind, preset: row.preset, baseUrl: row.base_url, apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : undefined });
}

// Model lists are cached briefly: OpenRouter's catalog is large and changes rarely.
const modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
async function modelsOf(row: ProviderRow, fresh = false): Promise<ModelInfo[]> {
  const hit = modelCache.get(row.id);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.models;
  const models = await adapterFor(row).listModels();
  modelCache.set(row.id, { at: Date.now(), models });
  return models;
}

export function resolverFor(user: User) {
  return async (providerId: string): Promise<ResolvedProvider> => {
    const row = rowFor(user, providerId);
    if (!row) throw new Error(`Provider "${providerId}" not found`);
    if (!row.enabled) throw new Error(`Provider "${row.name}" is disabled`);
    return {
      adapter: adapterFor(row),
      local: !!row.local,
      hostKey: row.base_url,
      modelInfo: async (model) => (await modelsOf(row)).find((m) => m.model === model),
    };
  };
}

/** Fresh install: add Ollama so local models work right away. */
export function seedProviders(ollamaUrl: string) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n;
  if (n > 0) return;
  db.prepare('INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES (?, ?, ?, ?, ?, 1)').run('ollama', 'ollama', 'ollama', 'Ollama', ollamaUrl);
}

export function providerRoutes(app: FastifyInstance) {
  app.get('/api/providers/presets', async () => PROVIDER_PRESETS);

  app.get('/api/providers', { preHandler: requireUser }, async (req) => visibleRows(req.user!).map(toInfo));

  app.post('/api/providers', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { preset?: string; name?: string; baseUrl?: string; apiKey?: string; shared?: boolean };
    const preset = PROVIDER_PRESETS.find((p) => p.id === body.preset);
    if (!preset) return reply.code(400).send({ error: 'Unknown preset' });
    const baseUrl = (body.baseUrl || preset.baseUrl).trim();
    if (!/^https?:\/\//.test(baseUrl)) return reply.code(400).send({ error: 'Base URL must start with http:// or https://' });
    if (preset.needsKey && !body.apiKey) return reply.code(400).send({ error: `${preset.name} needs an API key` });
    // Only admins add shared providers; everyone can add their own.
    const shared = body.shared !== false && req.user!.role === 'admin';
    const id = newId();
    db.prepare('INSERT INTO providers (id, preset, kind, name, base_url, api_key_enc, owner_id, local) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      preset.id,
      preset.kind,
      body.name?.trim() || preset.name,
      baseUrl,
      body.apiKey ? encrypt(body.apiKey.trim()) : null,
      shared ? null : req.user!.id,
      preset.local ? 1 : 0,
    );
    return toInfo(rowFor(req.user!, id)!);
  });

  app.patch('/api/providers/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = rowFor(req.user!, (req.params as { id: string }).id);
    if (!row || !canEdit(req.user!, row)) return reply.code(404).send({ error: 'Not found' });
    const body = (req.body ?? {}) as { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean };
    if (body.baseUrl !== undefined && !/^https?:\/\//.test(body.baseUrl)) return reply.code(400).send({ error: 'Base URL must start with http:// or https://' });
    db.prepare('UPDATE providers SET name = ?, base_url = ?, api_key_enc = ?, enabled = ? WHERE id = ?').run(
      body.name?.trim() || row.name,
      body.baseUrl?.trim() || row.base_url,
      body.apiKey ? encrypt(body.apiKey.trim()) : row.api_key_enc,
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      row.id,
    );
    modelCache.delete(row.id);
    return toInfo(rowFor(req.user!, row.id)!);
  });

  app.delete('/api/providers/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = rowFor(req.user!, (req.params as { id: string }).id);
    if (!row || !canEdit(req.user!, row)) return reply.code(404).send({ error: 'Not found' });
    db.prepare('DELETE FROM providers WHERE id = ?').run(row.id);
    modelCache.delete(row.id);
    return { ok: true };
  });

  app.get('/api/providers/:id/models', { preHandler: requireUser }, async (req, reply) => {
    const row = rowFor(req.user!, (req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    try {
      return await modelsOf(row, (req.query as { fresh?: string }).fresh === '1');
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Every model of every enabled provider; providers that fail are reported, not fatal. */
  app.get('/api/models', { preHandler: requireUser }, async (req) => {
    const rows = visibleRows(req.user!).filter((r) => r.enabled);
    const results = await Promise.allSettled(rows.map((r) => modelsOf(r)));
    return {
      models: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
      errors: results.flatMap((r, i) => (r.status === 'rejected' ? [{ providerId: rows[i].id, error: (r.reason as Error).message }] : [])),
    };
  });
}
