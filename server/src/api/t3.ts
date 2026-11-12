import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, randomToken, sha256 } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';
import {
  DEFAULT_OWNER,
  T3_ROLES,
  T3_TOKEN_FILE,
  folderStatus,
  hivemindBlock,
  mergeConfig,
  parseOwner,
  t3Dir,
  t3Models,
  t3Name,
  writeConfig,
  writeToken,
  type T3Choice,
  type T3Settings,
} from '../services/t3sync.js';
import { requireUser, type User } from './auth.js';
import { v1ModelData } from './v1.js';

const key = (u: User) => `user:${u.id}:t3`;

export function getT3Settings(u: User): T3Settings {
  try {
    const s = JSON.parse(getSetting(key(u)) ?? '{}') as Partial<T3Settings>;
    return { ...s, models: s.models && typeof s.models === 'object' ? s.models : {} };
  } catch {
    return { models: {} };
  }
}

/** Checks and cleans what the page sends; throws with a message the user can act on. */
function cleanSettings(body: unknown, prev: T3Settings): T3Settings {
  const b = (body ?? {}) as Partial<T3Settings>;
  const next: T3Settings = { ...prev };
  if (b.baseUrl !== undefined) {
    const url = String(b.baseUrl).trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('The address must start with http:// or https://');
    next.baseUrl = url || undefined;
  }
  if (b.owner !== undefined) {
    const owner = String(b.owner).trim();
    if (owner && !parseOwner(owner)) throw new Error('The file owner must look like 99:100 (user id:group id)');
    next.owner = owner || undefined;
  }
  if (b.models !== undefined) {
    if (!b.models || typeof b.models !== 'object' || Array.isArray(b.models)) throw new Error('models must be an object of model id → choice');
    const models: Record<string, T3Choice> = {};
    for (const [id, raw] of Object.entries(b.models)) {
      const c = (raw ?? {}) as T3Choice;
      const choice: T3Choice = {};
      if (typeof c.name === 'string' && c.name.trim()) choice.name = c.name.trim().slice(0, 80);
      if (typeof c.description === 'string' && c.description.trim()) choice.description = c.description.trim().slice(0, 120);
      if (c.role !== undefined && c.role !== null) {
        if (!T3_ROLES.includes(c.role)) throw new Error(`Unknown role "${String(c.role)}"`);
        choice.role = c.role;
      }
      if (typeof c.reasoning === 'boolean') choice.reasoning = c.reasoning;
      models[id.slice(0, 300)] = choice;
    }
    next.models = models;
  }
  return next;
}

/** The address T3 should use: the saved one, else what the file has, else the one this page was opened on. */
function baseUrlFor(req: FastifyRequest, s: T3Settings, inFile?: string): string {
  if (s.baseUrl) return s.baseUrl;
  if (inFile) return inFile;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  return `${proto}://${req.headers.host}/v1`;
}

/** A full API token for T3, written to its token file; the old one made for T3 is revoked. */
function newT3Token(u: User, s: T3Settings): { token: string; id: string } {
  if (s.tokenId) db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(s.tokenId, u.id);
  const token = `hm_${randomToken(24)}`;
  const id = newId();
  db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, u.id, 'T3 Code', sha256(token), token.slice(0, 7), null, null);
  return { token, id };
}

async function modelsFor(u: User) {
  return t3Models((await v1ModelData(u)).data as Parameters<typeof t3Models>[0]);
}

export function t3Routes(app: FastifyInstance) {
  /** The page: folder status, every model with its T3 name, and the saved choices. */
  app.get('/api/t3', { preHandler: requireUser }, async (req) => {
    const u = req.user!;
    const s = getT3Settings(u);
    const folder = folderStatus();
    const models = await modelsFor(u);
    return {
      folder,
      settings: { ...s, owner: s.owner ?? DEFAULT_OWNER, baseUrl: baseUrlFor(req, s, folder.baseUrlInFile) },
      models: models.map((m) => ({ ...m, t3Name: t3Name(m, s.models[m.id]) })),
    };
  });

  app.put('/api/t3', { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    if (u.scope) return reply.code(403).send({ error: 'A limited API token cannot change the T3 settings' });
    try {
      const next = cleanSettings(req.body, getT3Settings(u));
      setSetting(key(u), JSON.stringify(next));
      return next;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Update T3: save what the page sends (optional), then write opencode.json (and a token when T3 has none). */
  app.post('/api/t3/update', { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    if (u.scope) return reply.code(403).send({ error: 'A limited API token cannot change the T3 settings' });
    let s: T3Settings;
    try {
      s = cleanSettings(req.body, getT3Settings(u));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const folder = folderStatus();
    if (!folder.mapped)
      return reply.code(409).send({ error: `HiveMind can't write T3's OpenCode folder: ${folder.dir} isn't mapped (see the steps on this page), or use Download opencode.json.` });
    const dir = t3Dir();
    const owner = s.owner ?? DEFAULT_OWNER;
    const models = await modelsFor(u);
    const baseUrl = baseUrlFor(req, s, folder.baseUrlInFile);
    let existing: string | undefined;
    try {
      existing = readFileSync(join(dir, 'opencode.json'), 'utf8');
    } catch {}
    let cfg: Record<string, unknown>;
    try {
      cfg = mergeConfig(existing, hivemindBlock(models, s, baseUrl));
    } catch (err) {
      return reply.code(409).send({ error: `T3's opencode.json is broken, so it was left alone: ${(err as Error).message}` });
    }
    const warnings = writeConfig(cfg, owner, dir);
    let tokenCreated = false;
    if (!folder.tokenPresent) {
      const t = newT3Token(u, s);
      s.tokenId = t.id;
      const w = writeToken(t.token, owner, dir);
      if (w) warnings.push(w);
      tokenCreated = true;
    }
    s.baseUrl = baseUrl;
    setSetting(key(u), JSON.stringify(s));
    const written = Object.keys((cfg.provider as { hivemind: { models: object } }).hivemind.models).length;
    const missing = Object.keys(s.models).filter((id) => !models.some((m) => m.id === id));
    return { written, missing, tokenCreated, warnings, folder: folderStatus() };
  });

  /** A new token for T3: revokes the one made before and writes the new one. */
  app.post('/api/t3/token', { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    if (u.scope) return reply.code(403).send({ error: 'A limited API token cannot make tokens' });
    const folder = folderStatus();
    if (!folder.mapped) return reply.code(409).send({ error: `${folder.dir} isn't mapped, so the token can't be written for T3` });
    const s = getT3Settings(u);
    const t = newT3Token(u, s);
    s.tokenId = t.id;
    setSetting(key(u), JSON.stringify(s));
    const warning = writeToken(t.token, s.owner ?? DEFAULT_OWNER, t3Dir());
    return { ok: true, file: T3_TOKEN_FILE, ...(warning && { warnings: [warning] }) };
  });

  /** The opencode.json T3 would get, for copying by hand (the token stays a file reference). */
  app.get('/api/t3/opencode.json', { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    const s = getT3Settings(u);
    const folder = folderStatus();
    let existing: string | undefined;
    if (folder.mapped)
      try {
        existing = readFileSync(join(t3Dir(), 'opencode.json'), 'utf8');
      } catch {}
    let cfg: Record<string, unknown>;
    const block = hivemindBlock(await modelsFor(u), s, baseUrlFor(req, s, folder.baseUrlInFile));
    try {
      cfg = mergeConfig(existing, block);
    } catch {
      cfg = mergeConfig(undefined, block);
    }
    reply.header('content-disposition', 'attachment; filename="opencode.json"');
    return cfg;
  });
}
