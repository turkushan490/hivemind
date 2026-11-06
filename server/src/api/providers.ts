import { PROVIDER_PRESETS, type ModelInfo, type ProviderInfo, type ProviderKind } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { decrypt, encrypt, newId } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';
import type { ResolvedProvider } from '../engine/run.js';
import { createAdapter } from '../providers/index.js';
import { trainingServices } from '../lab/services.js';
import { isOllamaDecisionModel, SPAM_TEST, SPAM_TEST_STATE } from '../providers/decisions.js';
import { logError } from '../errors.js';
import type { GpuNeed } from '../nodes/index.js';
import { sameModel } from '../events/runs.js';
import { requireUser, type User } from './auth.js';
import { canvasAllowed, datasetAllowed, trainingAllowed } from './scope.js';
import { mayUseFile } from '../services/files.js';
import { addToBasic, allowedFor, keepComfyCopy, type Access } from '../services/access.js';

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

/** Providers this user may use something of (Settings → Access); the others don't show anywhere. */
export function usableRows(user: User, access: Access = allowedFor(user)): ProviderRow[] {
  return visibleRows(user).filter((r) => access.provider(r.id));
}

/** One provider, when the user may see it and use something of it. */
export function usableRow(user: User, id: string, access: Access = allowedFor(user)): ProviderRow | undefined {
  const row = rowFor(user, id);
  return row && access.provider(row.id) ? row : undefined;
}

export function adapterFor(row: ProviderRow) {
  return createAdapter({
    id: row.id,
    kind: row.kind,
    preset: row.preset,
    baseUrl: row.base_url,
    apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : undefined,
    // ComfyUI: pictures pass through its temp folder unless the admin keeps a copy (Settings → Access).
    ...(row.kind === 'comfyui' && { keepImages: keepComfyCopy() }),
  });
}

/** The models of a provider this user may use (Settings → Access). */
export async function allowedModelsOf(row: ProviderRow, access: Access, fresh = false): Promise<ModelInfo[]> {
  const list = await modelsOf(row, fresh);
  return access.everything ? list : list.filter((m) => access.model(row.id, m.model));
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
const originOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Room a loading model needs beyond its file size (its context and working memory). */
const GPU_MARGIN = 1.5 * 1024 ** 3;

/**
 * Gives back GPU memory on one machine for the AI server about to use it: the other enabled local AI servers there
 * unload their models. Not when nothing has to load (the model is already loaded), and ComfyUI keeps its models
 * when the model fits in what is free: reloading a big image model costs most of a minute. After freeing, it waits
 * (at most 20 s) until Ollama has really let its models go, so the next model doesn't start on a full GPU.
 */
export function gpuFreerFor(user: User) {
  return async (hostKey: string, exceptProviderId?: string, need: GpuNeed = {}) => {
    // A provider on the same server (Ollama and its "decision models") shares that server's memory, which
    // Ollama manages itself: unloading it would reload the model on every call.
    const own = visibleRows(user).find((r) => r.id === exceptProviderId);
    if (own && need.model) {
      const loaded = await adapterFor(own).loaded?.().catch(() => undefined);
      if (loaded?.some((m) => sameModel(m.model, need.model!))) return;
    }
    const rows = visibleRows(user).filter(
      (r) => r.enabled && r.local && r.id !== exceptProviderId && hostOf(r.base_url) === hostKey && !(own && originOf(r.base_url) === originOf(own.base_url)),
    );
    await Promise.allSettled(
      rows.map(async (r) => {
        const a = adapterFor(r);
        if (need.bytes && a.vramFree) {
          const free = await a.vramFree().catch(() => undefined);
          if (free !== undefined && free >= need.bytes * 1.15 + GPU_MARGIN) return;
        }
        await a.freeMemory?.();
        // Ollama answers at once but lets go of the memory a moment later.
        if (a.loaded) for (const t = Date.now(); Date.now() - t < 20_000 && ((await a.loaded().catch(() => [])) ?? []).length; ) await new Promise((res) => setTimeout(res, 500));
      }),
    );
  };
}

/**
 * What training jobs of this user need: their providers, the GPU freer, and where new models go (an Ollama server).
 * Only providers the user may use (Settings → Access) can be a training target.
 */
export function trainDepsFor(user: User) {
  const ollamas = () => usableRows(user).filter((r) => r.kind === 'ollama' && r.enabled);
  return {
    resolve: resolverFor(user),
    freeGpu: gpuFreerFor(user),
    ollamaUrl: (id: string) => ollamas().find((r) => r.id === id)?.base_url,
    comfyUrl: (id: string) => usableRows(user).find((r) => r.id === id && r.kind === 'comfyui' && r.enabled)?.base_url,
    defaultTarget: () => ollamas()[0]?.id,
    defaultComfy: () => usableRows(user).find((r) => r.kind === 'comfyui' && r.enabled)?.id,
  };
}

/**
 * The training blocks' services for a run, or undefined for viewers and limited API tokens without training rights.
 * A limited token with training: true reaches only its datasets and canvases. A scheduled run trains in the
 * training window (nightly).
 */
export function trainingFor(user: User | undefined, opts: { scheduled?: boolean } = {}) {
  if (!user || user.role === 'viewer' || !trainingAllowed(user)) return undefined;
  return trainingServices(user.id, trainDepsFor(user), {
    nightly: !!opts.scheduled,
    tokenId: user.tokenId,
    allowFile: (path: string) => mayUseFile(user, path),
    ...(user.scope && { allowDataset: (name: string) => datasetAllowed(user, name), allowCanvas: (id: string) => canvasAllowed(user, id) }),
  });
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

  app.get('/api/providers', { preHandler: requireUser }, async (req) => usableRows(req.user!).map(toInfo));

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
    // Basic follows the cloud: a new shared cloud provider is in it (Settings → Access).
    if (shared && !preset.local && !['decision', 'comfyui', 'ollama'].includes(preset.kind)) addToBasic(id);
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
    const access = allowedFor(req.user!);
    const row = usableRow(req.user!, (req.params as { id: string }).id, access);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    try {
      return await allowedModelsOf(row, access, (req.query as { fresh?: string }).fresh === '1');
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Decision providers: asks the spam example from the Jev guide, so a wrong key shows up right away. */
  app.post('/api/providers/:id/test-decision', { preHandler: requireUser }, async (req, reply) => {
    const access = allowedFor(req.user!);
    const row = usableRow(req.user!, (req.params as { id: string }).id, access);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const adapter = adapterFor(row);
    if (!adapter.decide) return reply.code(400).send({ error: `${row.name} is not a decision provider` });
    const asked = (req.body as { model?: string } | undefined)?.model;
    if (asked && !access.model(row.id, asked)) return reply.code(403).send({ error: `You can't use ${asked} (ask the admin to add it to your access)` });
    try {
      const model = asked || (await allowedModelsOf(row, access, true))[0]?.model;
      if (!model) throw new Error('No decision model found on this provider (Ollama: ollama pull nimble)');
      return { state: SPAM_TEST_STATE, ...(await adapter.decide({ model, state: SPAM_TEST_STATE, questions: SPAM_TEST })) };
    } catch (err) {
      const message = `${row.name} test failed: ${(err as Error).message}`;
      logError({ source: 'provider', message, userId: req.user!.id });
      return reply.code(502).send({ error: message });
    }
  });

  /** LoRAs a ComfyUI provider offers (for Image blocks): only the ones this user may use. */
  app.get('/api/providers/:id/loras', { preHandler: requireUser }, async (req, reply) => {
    const access = allowedFor(req.user!);
    const row = usableRow(req.user!, (req.params as { id: string }).id, access);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const adapter = adapterFor(row) as ReturnType<typeof adapterFor> & { loras?: () => Promise<string[]> };
    const all = adapter.loras ? await adapter.loras().catch(() => []) : [];
    return access.everything ? all : all.filter((l) => access.lora(row.id, l));
  });

  /** Every model of every enabled provider this user may use; providers that fail are reported, not fatal. */
  app.get('/api/models', { preHandler: requireUser }, async (req) => {
    const access = allowedFor(req.user!);
    const rows = usableRows(req.user!, access).filter((r) => r.enabled);
    // Decision models pulled into Ollama can't chat: model pickers get them only through a Decisions provider
    // (the Models page, which lists one server's models, still shows them to manage).
    const results = await Promise.allSettled(rows.map((r) => allowedModelsOf(r, access).then((list) => (r.kind === 'ollama' ? list.filter((m) => !isOllamaDecisionModel(m.model)) : list))));
    return {
      models: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
      errors: results.flatMap((r, i) => (r.status === 'rejected' ? [{ providerId: rows[i].id, error: (r.reason as Error).message }] : [])),
    };
  });
}
