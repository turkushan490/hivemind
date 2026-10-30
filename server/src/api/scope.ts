import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import type { NodeServices } from '../nodes/index.js';
import { authenticate, type User } from './auth.js';

/**
 * Limited API tokens (e.g. one for DungeonMind that may only touch "dnd-*" canvases and "dnd:*" / "rules:*" memory).
 * Such a token works only on the routes below, and only for the canvases, runs and memory keys its scope names.
 */

/** "dnd-*" matches every id starting with "dnd-"; anything else must match exactly. */
export const matches = (patterns: string[], value: string) => patterns.some((p) => (p.endsWith('*') ? value.startsWith(p.slice(0, -1)) : value === p));

export const canvasAllowed = (user: User, id: string | null | undefined) => !user.scope || (!!id && matches(user.scope.canvases, id));
export const memoryAllowed = (user: User, key: string) => !user.scope || matches(user.scope.memory, key);
/** Datasets by name ("DungeonMind*"); a limited token without datasets in its scope reaches none. */
export const datasetAllowed = (user: User, name: string) => !user.scope || matches(user.scope.datasets ?? [], name);
/** Limited tokens may train only when their scope says training: true. */
export const trainingAllowed = (user: User) => !user.scope || user.scope.training === true;

const SCOPED_ROUTES = new Set([
  'GET /api/auth/me',
  'GET /api/canvases',
  'GET /api/canvases/:id',
  'PUT /api/canvases/:id?',
  'POST /api/runs',
  'GET /api/runs/:id',
  'GET /api/runs/:id/events',
  'POST /api/runs/:id/cancel',
  'GET /api/memory/keys',
  'DELETE /api/memory/keys/:key',
  'POST /api/memory/keys/:key/import',
  'POST /api/memory/keys/:key/search',
  'GET /api/files/raw',
  'GET /v1/models',
  'POST /v1/chat/completions',
  'GET /api/workflows/:id/schedule',
  'PUT /api/workflows/:id/schedule',
  'DELETE /api/workflows/:id/schedule',
]);

/** Only for tokens with datasets in their scope, and only for matching datasets. */
const DATASET_ROUTES = new Set([
  'GET /api/datasets',
  'POST /api/datasets',
  'GET /api/datasets/:id/items',
  'POST /api/datasets/:id/items',
  'DELETE /api/datasets/items/:itemId',
]);

/** Only for tokens with training: true; the job routes only for jobs the token started. */
const TRAINING_ROUTES = new Set([
  'GET /api/lab/window',
  'GET /api/lab/train',
  'POST /api/lab/train',
  'GET /api/lab/train/:id',
  'POST /api/lab/train/:id/cancel',
  'DELETE /api/lab/train/:id',
  'GET /api/lab/train/:id/events',
]);

const datasetName = (ownerId: string, id: string) =>
  (db.prepare('SELECT name FROM datasets WHERE id = ? AND owner_id = ?').get(id, ownerId) as { name: string } | undefined)?.name;

/** preHandler hook: what a limited token may not do is refused here, before the route runs. */
export async function scopeGuard(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers.authorization?.startsWith('Bearer ')) return;
  const url = req.routeOptions.url;
  if (!url || url === '/api/health') return;
  const user = authenticate(req);
  if (!user?.scope) return;
  const deny = (what: string) => reply.code(403).send({ error: `This API token is limited and may not ${what}` });
  const route = `${req.method} ${url}`;
  const params = (req.params ?? {}) as { id?: string; key?: string; itemId?: string };
  if (DATASET_ROUTES.has(route)) {
    if (!user.scope.datasets?.length) return deny('use datasets');
    if (route === 'POST /api/datasets') {
      const name = String((req.body as { name?: unknown } | undefined)?.name ?? '').trim();
      if (!datasetAllowed(user, name)) return deny(`make dataset "${name}"`);
    }
    if (params.id !== undefined) {
      const name = datasetName(user.id, params.id);
      if (name !== undefined && !datasetAllowed(user, name)) return deny(`use dataset "${name}"`);
    }
    if (params.itemId !== undefined) {
      const row = db.prepare('SELECT d.name FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id WHERE i.id = ? AND d.owner_id = ?').get(Number(params.itemId), user.id) as
        | { name: string }
        | undefined;
      if (row && !datasetAllowed(user, row.name)) return deny(`use dataset "${row.name}"`);
    }
    return;
  }
  if (TRAINING_ROUTES.has(route)) {
    if (!trainingAllowed(user)) return deny('train models');
    if (route === 'POST /api/lab/train') {
      const body = (req.body ?? {}) as { datasetId?: unknown; flavor?: unknown };
      const name = typeof body.datasetId === 'string' ? datasetName(user.id, body.datasetId) : undefined;
      if (name === undefined) return deny('train without a datasetId of one of its datasets');
      if (!datasetAllowed(user, name)) return deny(`train on dataset "${name}"`);
      if (body.flavor) return deny('rent a Hugging Face machine (cloud training)');
    }
    if (params.id !== undefined && url.startsWith('/api/lab/train/:id')) {
      const job = db.prepare('SELECT token_id FROM lab_trains WHERE id = ? AND owner_id = ?').get(params.id, user.id) as { token_id: string | null } | undefined;
      if (job && job.token_id !== user.tokenId) return deny('use a training job it did not start');
    }
    return;
  }
  if (!SCOPED_ROUTES.has(route)) return deny('use this part of HiveMind');
  if ((url.startsWith('/api/canvases/') || url.startsWith('/api/workflows/')) && !canvasAllowed(user, params.id)) return deny(`use canvas "${params.id ?? ''}"`);
  if (url.startsWith('/api/runs/:id')) {
    const run = db.prepare('SELECT canvas_id FROM runs WHERE id = ? AND owner_id = ?').get(params.id ?? '', user.id) as { canvas_id: string | null } | undefined;
    if (run && !canvasAllowed(user, run.canvas_id)) return deny('see this run');
  }
  if (params.key !== undefined && !memoryAllowed(user, params.key)) return deny(`use memory "${params.key}"`);
  // Files: only what blocks made (outputs/…), never the rest of the shared files folder.
  if (url === '/api/files/raw') {
    const path = String((req.query as { path?: string }).path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path.startsWith('outputs/')) return deny('read files outside outputs/');
  }
  if (req.method === 'POST' && url === '/api/runs') {
    const body = (req.body ?? {}) as { canvasId?: string; graph?: unknown };
    // A per-run model override (models) is fine: it only picks among the owner's own providers.
    if (body.graph !== undefined) return deny('run a canvas sent in the request; send a canvasId');
    if (!canvasAllowed(user, body.canvasId)) return deny(`run canvas "${body.canvasId ?? ''}"`);
  }
}

/** The memory a run may use, checked key by key (a block that names another key fails with a clear message). */
export function scopedMemory(mem: NonNullable<NodeServices['memory']>, user: User): NonNullable<NodeServices['memory']> {
  if (!user.scope) return mem;
  const check = (key: string) => {
    if (!memoryAllowed(user, key)) throw new Error(`This API token may not use memory "${key}" (allowed: ${user.scope!.memory.join(', ') || 'none'})`);
  };
  return {
    recall: (key, limit) => (check(key), mem.recall(key, limit)),
    save: (key, text) => (check(key), mem.save(key, text)),
    search: (key, query, limit) => (check(key), mem.search!(key, query, limit)),
  };
}
