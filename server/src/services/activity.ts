import type { ApiCall, LiveApiCall } from '@hivemind/shared';
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

/** More about a call for its line in the log: the model, the numbers, why it failed. */
const extra = new WeakMap<FastifyRequest, Partial<ApiCall>>();
export function noteCall(req: FastifyRequest, more: Partial<ApiCall>) {
  extra.set(req, { ...extra.get(req), ...more });
}

/** onSend hook: a failed API call keeps its error message, so the log can say why (a 403's reason). */
export async function captureError(req: FastifyRequest, reply: FastifyReply, payload: unknown) {
  if (reply.statusCode < 400 || !req.headers.authorization?.startsWith('Bearer ') || typeof payload !== 'string') return payload;
  try {
    const j = JSON.parse(payload) as { error?: string | { message?: string } };
    const msg = typeof j.error === 'string' ? j.error : j.error?.message;
    if (msg) noteCall(req, { error: msg.slice(0, 300) });
  } catch {}
  return payload;
}

// ---- /v1 model calls going on now ----

let nextId = 1;
const live = new Map<number, LiveApiCall & { ownerId?: string }>();

/** A /v1 model call starts: it shows under Running now until finish(). */
export function startLiveCall(req: FastifyRequest, model: string, tools: number) {
  const user = req.user;
  const c: LiveApiCall & { ownerId?: string } = {
    id: nextId++,
    token: user?.tokenName ?? 'token',
    ...(user && { user: user.username, ownerId: user.id }),
    model,
    startedAt: Date.now(),
    state: 'waiting for the GPU',
    tokens: 0,
    text: '',
    toolCalls: [],
    tools,
  };
  live.set(c.id, c);
  return {
    set: (p: Partial<LiveApiCall>) => Object.assign(c, p),
    write(text: string, thinking = false) {
      c.state = thinking ? 'thinking' : 'writing';
      c.tokens++;
      c.text = (c.text + text).slice(-300);
    },
    finish: () => live.delete(c.id),
  };
}

export function liveCalls(ownerId?: string): LiveApiCall[] {
  return [...live.values()].filter((c) => ownerId === undefined || c.ownerId === ownerId).map(({ ownerId: _o, ...c }) => c);
}


/** onResponse hook: one line per request made with an API token (event streams too, when they end). */
export async function logApiCall(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers.authorization?.startsWith('Bearer ')) return;
  const user = req.user;
  const run = started.get(req);
  const ms = Math.round(reply.elapsedTime);
  calls.push({
    ...extra.get(req),
    at: Date.now() - ms,
    token: user?.tokenName ?? (user ? 'token' : 'Unknown token'),
    ...(user && { user: user.username, ownerId: user.id }),
    method: req.method,
    route: req.routeOptions.url ?? '(no such route)',
    status: reply.raw.statusCode,
    ms,
    ...(run && { runId: run.runId, ...(run.canvasName && { canvasName: run.canvasName }) }),
  });
  if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
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
