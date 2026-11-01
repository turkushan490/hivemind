import type { ApiCall } from '@hivemind/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Activity → Incoming API calls: every request made with an API token (scoped or full, /v1 too), the last 1,000,
 * in memory only. Screen traffic (the session cookie) is not logged. Only the route pattern is kept: never the
 * URL, its query string, headers or bodies (they can hold tokens or game text).
 */

export const MAX_CALLS = 1000;
const calls: (ApiCall & { ownerId?: string })[] = [];

/** The run a request started (POST /api/runs, /v1/chat/completions), for its line in the log. */
const started = new WeakMap<FastifyRequest, { runId: string; canvasName?: string }>();

export function noteRun(req: FastifyRequest, runId: string, canvasName?: string) {
  started.set(req, { runId, canvasName });
}


/** onRequest hook: notes when a token request starts; the line is written when the response is done. */
export async function logApiCall(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers.authorization?.startsWith('Bearer ')) return;
  const t0 = Date.now();
  let logged = false;
  // On the raw response, so hijacked replies (event streams) are logged too.
  const done = () => {
    if (logged) return;
    logged = true;
    const user = req.user;
    const run = started.get(req);
    calls.push({
      at: t0,
      token: user?.tokenName ?? (user ? 'token' : 'Unknown token'),
      ...(user && { user: user.username, ownerId: user.id }),
      method: req.method,
      route: req.routeOptions.url ?? '(no such route)',
      status: reply.raw.statusCode,
      ms: Date.now() - t0,
      ...(run && { runId: run.runId, ...(run.canvasName && { canvasName: run.canvasName }) }),
    });
    if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
  };
  reply.raw.once('finish', done);
  reply.raw.once('close', done);
}

/** GET /api/activity/calls: newest first; a full admin sees everyone's, others their own. */
export function apiCalls(opts: { ownerId?: string; limit?: number; token?: string; failed?: boolean }): ApiCall[] {
  const limit = Math.max(1, Math.min(MAX_CALLS, Math.floor(opts.limit ?? 200) || 200));
  const out: ApiCall[] = [];
  for (let i = calls.length - 1; i >= 0 && out.length < limit; i--) {
    const { ownerId, ...c } = calls[i];
    if (opts.ownerId !== undefined && ownerId !== opts.ownerId) continue;
    if (opts.token && c.token !== opts.token) continue;
    if (opts.failed && c.status < 400) continue;
    out.push(c);
  }
  return out;
}

/** Test helper: forget the log. */
export const clearApiCalls = () => calls.splice(0);
