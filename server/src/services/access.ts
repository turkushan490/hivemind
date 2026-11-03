import { AUTO_TIERS, BASIC_PROFILE, EVERYTHING_PROFILE, type AccessProfile, type CanvasGraph, type CanvasNode, type ModelRef, type ProviderAccess } from '@hivemind/shared';
import { db, getSetting, setSetting } from '../db/index.js';
import type { User } from '../api/auth.js';

/**
 * Access profiles (Settings → Access): which providers, models and LoRAs a user, and an API token on top of its
 * user, may use. One function, allowedFor(user), answers every check: the lists the API returns, the start of a
 * run, and every model call during the run (Auto model and Routers pick models while it runs).
 *
 * - Admins always have Everything. Other users have their profile (null: the "New users get" profile).
 * - Providers a user added with their own key are always theirs to use.
 * - A token with a profile of its own gets only what both its user and that profile allow.
 */

export interface Access {
  /** Nothing is limited (an admin, without a token profile that limits it). */
  everything: boolean;
  /** Anything on this provider may be used (a provider with nothing allowed is hidden). */
  provider(providerId: string): boolean;
  model(providerId: string, model: string): boolean;
  lora(providerId: string, name: string): boolean;
}

export const EVERYTHING: Access = { everything: true, provider: () => true, model: () => true, lora: () => true };

export const EVERYTHING_INFO: AccessProfile = { id: EVERYTHING_PROFILE, name: 'Everything', builtin: true, providers: {} };

/** A 403 that says what to ask for. */
export const notAllowed = (what: string) => Object.assign(new Error(`You can't use ${what} (ask the admin to add it to your access)`), { statusCode: 403 });

// ---- Matching ----

/** ComfyUI on Windows writes "dnd\\x.safetensors"; Ollama's "llama3" is "llama3:latest". */
const norm = (s: string) =>
  s
    .trim()
    .replace(/\\/g, '/')
    .replace(/:latest$/i, '')
    .toLowerCase();

const globCache = new Map<string, RegExp>();
/** An exact name, or a glob where only * is special ("dnd/*" = everything in that folder and below). */
export function globMatch(pattern: string, name: string): boolean {
  const p = norm(pattern);
  const n = norm(name);
  if (!p.includes('*')) return p === n;
  let re = globCache.get(p);
  if (!re) {
    re = new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (globCache.size > 2000) globCache.clear();
    globCache.set(p, re);
  }
  return re.test(n);
}

const listAllows = (list: 'all' | 'none' | string[] | undefined, name: string) =>
  list === 'all' ? true : Array.isArray(list) ? list.some((p) => globMatch(p, name)) : false;

const anyAllowed = (list: 'all' | 'none' | string[] | undefined) => list === 'all' || (Array.isArray(list) && list.length > 0);

// ---- Profiles ----

interface ProfileRow {
  id: string;
  name: string;
  providers: string;
}

const parseProviders = (s: string): Record<string, ProviderAccess> => {
  try {
    const v = JSON.parse(s) as Record<string, ProviderAccess>;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

export function listProfiles(): AccessProfile[] {
  const rows = db.prepare('SELECT id, name, providers FROM access_profiles ORDER BY created_at, name').all() as unknown as ProfileRow[];
  return [EVERYTHING_INFO, ...rows.map((r) => ({ id: r.id, name: r.name, providers: parseProviders(r.providers) }))];
}

export function getProfile(id: string | null | undefined): AccessProfile | undefined {
  if (!id) return undefined;
  if (id === EVERYTHING_PROFILE) return EVERYTHING_INFO;
  const r = db.prepare('SELECT id, name, providers FROM access_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
  return r && { id: r.id, name: r.name, providers: parseProviders(r.providers) };
}

/** The profile new users get (Settings → Access → "New users get"); Basic by default. */
export const newUsersProfile = (): string => {
  const id = getSetting('access.newUsers');
  return id && getProfile(id) ? id : BASIC_PROFILE;
};

export function setNewUsersProfile(id: string) {
  if (!getProfile(id)) throw Object.assign(new Error('No such profile'), { statusCode: 400 });
  setSetting('access.newUsers', id);
}

/** Settings → Access → "Keep a copy in ComfyUI's output folder" (off: pictures only pass through ComfyUI's temp). */
export const keepComfyCopy = () => getSetting('access.keepComfyCopy') === '1';
export const setKeepComfyCopy = (on: boolean) => setSetting('access.keepComfyCopy', on ? '1' : '0');

/** Checks and cleans what the admin sent: {"<providerId>": {models, loras}}. */
export function cleanProviders(v: unknown): Record<string, ProviderAccess> {
  const bad = (m: string) => Object.assign(new Error(m), { statusCode: 400 });
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('providers must be an object: {"<providerId>": {"models": "all" | [...], "loras": "none" | "all" | [...]}}');
  const list = (x: unknown, what: string): string[] => {
    if (!Array.isArray(x) || x.some((s) => typeof s !== 'string' || !s.trim() || s.length > 300)) throw bad(`${what} must be "all" or a list of names`);
    if (x.length > 5000) throw bad(`${what}: at most 5000 names`);
    return [...new Set((x as string[]).map((s) => s.trim()))];
  };
  const out: Record<string, ProviderAccess> = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') throw bad(`providers["${id}"] must be {"models": …, "loras": …}`);
    const r = raw as { models?: unknown; loras?: unknown };
    const models = r.models === 'all' ? 'all' : list(r.models ?? [], `providers["${id}"].models`);
    const loras = r.loras === undefined || r.loras === 'none' ? 'none' : r.loras === 'all' ? 'all' : list(r.loras, `providers["${id}"].loras`);
    out[id] = { models, loras };
  }
  return out;
}

// ---- Who gets what ----

function fromProfile(p: AccessProfile | undefined, ownProviders: Set<string> = new Set()): Access {
  if (p?.id === EVERYTHING_PROFILE) return EVERYTHING;
  const of = (id: string) => p?.providers[id];
  return {
    everything: false,
    provider: (id) => ownProviders.has(id) || anyAllowed(of(id)?.models) || anyAllowed(of(id)?.loras),
    model: (id, m) => ownProviders.has(id) || listAllows(of(id)?.models, m),
    lora: (id, l) => ownProviders.has(id) || listAllows(of(id)?.loras ?? 'none', l),
  };
}

const both = (a: Access, b: Access): Access =>
  a.everything ? b : b.everything ? a : { everything: false, provider: (id) => a.provider(id) && b.provider(id), model: (id, m) => a.model(id, m) && b.model(id, m), lora: (id, l) => a.lora(id, l) && b.lora(id, l) };

/** The profile id a user has: admins Everything, others their own (or the "New users get" one). */
export function userProfileId(user: Pick<User, 'id' | 'role'>): string {
  if (user.role === 'admin') return EVERYTHING_PROFILE;
  const row = db.prepare('SELECT profile_id FROM users WHERE id = ?').get(user.id) as { profile_id: string | null } | undefined;
  return row?.profile_id ?? newUsersProfile();
}

/** What this user (and the API token the request came with) may use. */
export function allowedFor(user: Pick<User, 'id' | 'role' | 'tokenId'>): Access {
  let access: Access;
  if (user.role === 'admin') access = EVERYTHING;
  else {
    const own = new Set((db.prepare('SELECT id FROM providers WHERE owner_id = ?').all(user.id) as { id: string }[]).map((r) => r.id));
    // A profile that was deleted meanwhile allows nothing (deleting one moves its users to the default first).
    access = fromProfile(getProfile(userProfileId(user)) ?? { id: '-', name: '-', providers: {} }, own);
  }
  if (user.tokenId) {
    const t = db.prepare('SELECT profile_id FROM api_tokens WHERE id = ?').get(user.tokenId) as { profile_id: string | null } | undefined;
    if (t?.profile_id) access = both(access, fromProfile(getProfile(t.profile_id) ?? { id: '-', name: '-', providers: {} }));
  }
  return access;
}

// ---- Checks on canvases ----

/** Every model a block names, with what it is for (the Auto sizes are left out: Auto only picks allowed ones). */
function refsOf(node: CanvasNode): ModelRef[] {
  const c = node.config;
  const isRef = (m: unknown): m is ModelRef => !!m && typeof (m as ModelRef).providerId === 'string' && typeof (m as ModelRef).model === 'string';
  return [c.model, ...(Array.isArray(c.models) ? c.models : []), c.decider, c.jevScore, c.auto?.decider].filter(isRef);
}

/**
 * Before a run starts: every block's model, models list, decision model and LoRA must be allowed, and an Auto
 * block needs at least one allowed size. Throws a 403 that names the first one that isn't.
 */
export function checkGraph(graph: CanvasGraph, access: Access) {
  if (access.everything) return;
  for (const n of graph.nodes) {
    for (const ref of refsOf(n)) if (!access.model(ref.providerId, ref.model)) throw notAllowed(ref.model);
    const c = n.config;
    if (n.type === 'image' && c.lora && c.model && !access.lora(c.model.providerId, c.lora)) throw notAllowed(`the LoRA ${c.lora}`);
    if (n.type === 'llm' && c.auto && !c.model) {
      const sizes = AUTO_TIERS.map((t) => c.auto![t]).filter((m): m is ModelRef => !!m);
      if (sizes.length && !sizes.some((m) => access.model(m.providerId, m.model))) throw notAllowed(sizes[0].model);
    }
  }
}

/** Basic follows the cloud: a shared cloud provider the admin adds is in it (all models, no LoRAs). */
export function addToBasic(providerId: string) {
  const p = getProfile(BASIC_PROFILE);
  if (!p || p.providers[providerId]) return;
  db.prepare('UPDATE access_profiles SET providers = ? WHERE id = ?').run(JSON.stringify({ ...p.providers, [providerId]: { models: 'all', loras: 'none' } }), BASIC_PROFILE);
}
