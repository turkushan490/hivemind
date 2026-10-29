import { PROVIDER_PRESETS, type ModelInfo, type ProviderInfo, type ProviderKind } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { decrypt, encrypt, newId } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';
import type { ResolvedProvider } from '../engine/run.js';
import { createAdapter } from '../providers/index.js';
import { trainingServices } from '../lab/services.js';
import { isOllamaDecisionModel, SPAM_TEST, SPAM_TEST_STATE } from '../providers/decisions.js';
import { logError } from '../errors.js';
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
  parallel: number;
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
  parallel: !!r.parallel,
  shared: r.owner_id === null,
});

/** Shared providers (admin-made, owner null) plus the user's own. */
export function visibleRows(user: User): ProviderRow[] {
  return db.prepare('SELECT * FROM providers WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at').all(user.id) as unknown as ProviderRow[];
}

export function rowFor(user: User, id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)').get(id, user.id) as ProviderRow | undefined;
}

export const canEdit = (user: User, row: ProviderRow) => (row.owner_id === null ? user.role === 'admin' : row.owner_id === user.id);

export function adapterFor(row: ProviderRow) {
  return createAdapter({ id: row.id, kind: row.kind, preset: row.preset, baseUrl: row.base_url, apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : undefined });
}

// Model lists are cached briefly: OpenRouter's catalog is large and changes rarely.
const modelCache = new Map<string, { at: number; models: ModelInfo[] }>();
/** Call after models were added or removed on a provider. */
export const forgetModels = (providerId: string) => modelCache.delete(providerId);
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
      // Parallel on: this server's models don't wait for each other.
      exclusive: !!row.local && !row.parallel,
      // One GPU per machine: Ollama and ComfyUI on the same host share the lock.
      hostKey: hostOf(row.base_url),
      modelInfo: async (model) => (await modelsOf(row)).find((m) => m.model === model),
      stats: row.local ? modelStats(row.id) : undefined,
    };
  };
}

/**
 * Real load times and speeds per local model. Loading has no live progress in Ollama,
 * so the GPU bar is timed against the last real load of the same model on the same server.
 */
function modelStats(providerId: string): NonNullable<ResolvedProvider['stats']> {
  return {
    expectLoad(model, sizeBytes) {
      const row = db.prepare('SELECT load_ms FROM model_stats WHERE provider_id = ? AND model = ?').get(providerId, model) as { load_ms: number | null } | undefined;
      if (row?.load_ms) return { ms: Math.round(row.load_ms), estimated: false };
      // First load: about 0.7 GB/s from disk to GPU plus startup (measured on a Tesla T4: 5.4 GB in ~9 s).
      return { ms: Math.round(1000 + ((sizeBytes ?? 4e9) / 0.7e9) * 1000), estimated: true };
    },
    record(model, s) {
      if (!s.loadMs && !s.tokensPerSec) return;
      db.prepare(
        `INSERT INTO model_stats (provider_id, model, load_ms, tokens_per_sec) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_id, model) DO UPDATE SET
           load_ms = COALESCE(excluded.load_ms, load_ms),
           tokens_per_sec = COALESCE(excluded.tokens_per_sec, tokens_per_sec),
           updated_at = datetime('now')`,
      ).run(providerId, model, s.loadMs ?? null, s.tokensPerSec ?? null);
    },
  };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Gives back GPU memory on one machine: every enabled local AI server there except the one about to use it. */
export function gpuFreerFor(user: User) {
  return async (hostKey: string, exceptProviderId?: string) => {
    const rows = visibleRows(user).filter((r) => r.enabled && r.local && r.id !== exceptProviderId && hostOf(r.base_url) === hostKey);
    await Promise.allSettled(rows.map((r) => adapterFor(r).freeMemory?.()));
  };
}

/** What training jobs of this user need: their providers, the GPU freer, and where new models go (an Ollama server). */
export function trainDepsFor(user: User) {
  const ollamas = () => visibleRows(user).filter((r) => r.kind === 'ollama' && r.enabled);
  return {
    resolve: resolverFor(user),
    freeGpu: gpuFreerFor(user),
    ollamaUrl: (id: string) => ollamas().find((r) => r.id === id)?.base_url,
    defaultTarget: () => ollamas()[0]?.id,
  };
}

/** The training blocks' services for a run, or undefined for viewers and limited API tokens. */
export function trainingFor(user: User | undefined) {
  if (!user || user.role === 'viewer' || user.scope) return undefined;
  return trainingServices(user.id, trainDepsFor(user));
}

/** Fresh install: add Ollama so local models work right away. */
export function seedProviders(ollamaUrl: string, comfyUrl?: string, typesafeKey?: string) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n;
  if (n === 0) db.prepare('INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES (?, ?, ?, ?, ?, 1)').run('ollama', 'ollama', 'ollama', 'Ollama', ollamaUrl);
  // COMFYUI_URL adds ComfyUI once, also on existing installs; removing it later in Settings sticks.
  if (comfyUrl && !getSetting('seeded.comfyui')) {
    if (!(db.prepare("SELECT 1 FROM providers WHERE preset = 'comfyui'").get()))
      db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('comfyui', 'comfyui', 'comfyui', 'ComfyUI', ?, 1)").run(comfyUrl);
    setSetting('seeded.comfyui', '1');
  }
  // TYPESAFE_API_KEY adds Jev once, shared, with the key stored encrypted like every other key.
  if (typesafeKey && !getSetting('seeded.typesafe')) {
    if (!db.prepare("SELECT 1 FROM providers WHERE preset = 'typesafe'").get())
      db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, api_key_enc, local) VALUES ('typesafe', 'typesafe', 'decision', 'TypeSafe (Jev)', 'https://api.typesafe.ai', ?, 0)").run(encrypt(typesafeKey.trim()));
    setSetting('seeded.typesafe', '1');
  }
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
    // The server calls a provider's address itself, so only admins may point one at their own address (or the LAN).
    if (req.user!.role !== 'admin' && (preset.local || !preset.baseUrl || baseUrl.replace(/\/+$/, '') !== preset.baseUrl.replace(/\/+$/, '')))
      return reply.code(403).send({ error: 'Only an admin can add local or custom AI servers. You can add cloud providers with your own key.' });
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
    const body = (req.body ?? {}) as { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; parallel?: boolean };
    if (body.baseUrl !== undefined && !/^https?:\/\//.test(body.baseUrl)) return reply.code(400).send({ error: 'Base URL must start with http:// or https://' });
    if (body.baseUrl !== undefined && body.baseUrl.trim().replace(/\/+$/, '') !== row.base_url.replace(/\/+$/, '') && req.user!.role !== 'admin')
      return reply.code(403).send({ error: 'Only an admin can change the address of an AI server' });
    db.prepare('UPDATE providers SET name = ?, base_url = ?, api_key_enc = ?, enabled = ?, parallel = ? WHERE id = ?').run(
      body.name?.trim() || row.name,
      body.baseUrl?.trim() || row.base_url,
      body.apiKey ? encrypt(body.apiKey.trim()) : row.api_key_enc,
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      body.parallel === undefined ? row.parallel : body.parallel ? 1 : 0,
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

  /** Decision providers: asks the spam example from the Jev guide, so a wrong key shows up right away. */
  app.post('/api/providers/:id/test-decision', { preHandler: requireUser }, async (req, reply) => {
    const row = rowFor(req.user!, (req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const adapter = adapterFor(row);
    if (!adapter.decide) return reply.code(400).send({ error: `${row.name} is not a decision provider` });
    try {
      const model = (req.body as { model?: string } | undefined)?.model || (await modelsOf(row, true))[0]?.model;
      if (!model) throw new Error('No decision model found on this provider (Ollama: ollama pull nimble)');
      return { state: SPAM_TEST_STATE, ...(await adapter.decide({ model, state: SPAM_TEST_STATE, questions: SPAM_TEST })) };
    } catch (err) {
      const message = `${row.name} test failed: ${(err as Error).message}`;
      logError({ source: 'provider', message, userId: req.user!.id });
      return reply.code(502).send({ error: message });
    }
  });

  /** LoRAs a ComfyUI provider offers (for Image blocks). */
  app.get('/api/providers/:id/loras', { preHandler: requireUser }, async (req, reply) => {
    const row = rowFor(req.user!, (req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const adapter = adapterFor(row) as ReturnType<typeof adapterFor> & { loras?: () => Promise<string[]> };
    return adapter.loras ? adapter.loras().catch(() => []) : [];
  });

  /** Every model of every enabled provider; providers that fail are reported, not fatal. */
  app.get('/api/models', { preHandler: requireUser }, async (req) => {
    const rows = visibleRows(req.user!).filter((r) => r.enabled);
    // Decision models pulled into Ollama can't chat: model pickers get them only through a Decisions provider
    // (the Models page, which lists one server's models, still shows them to manage).
    const results = await Promise.allSettled(rows.map((r) => modelsOf(r).then((list) => (r.kind === 'ollama' ? list.filter((m) => !isOllamaDecisionModel(m.model)) : list))));
    return {
      models: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
      errors: results.flatMap((r, i) => (r.status === 'rejected' ? [{ providerId: rows[i].id, error: (r.reason as Error).message }] : [])),
    };
  });
}
