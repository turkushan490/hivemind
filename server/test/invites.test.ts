import type { CanvasGraph } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

/** Rollout R1: invite links (one account per link) and per-profile limits (GPU place, runs per day). */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];

const post = (url: string, who: string | null, payload: object) =>
  app.inject({ method: 'POST', url, ...(who ? { headers: bearer(who) } : {}), payload });
const echo = (): CanvasGraph => chain(node('q', 'input'), node('t', 'template', { prompt: 'echo {{question}}' }), node('o', 'output'));

beforeAll(async () => {
  ({ app, db } = await testApp('invites', [
    ['a1', 'admin'],
    ['g1', 'user'],
  ]));
});
afterAll(() => app?.close());

describe('invite links', () => {
  it('only an admin makes one; it makes one account, once', async () => {
    expect((await post('/api/invites', 'g1', {})).statusCode).toBe(403);
    const made = await post('/api/invites', 'a1', { note: 'friend' });
    expect(made.statusCode).toBe(200);
    const { token } = made.json() as { token: string };

    expect((await app.inject({ method: 'GET', url: `/api/invites/check/${token}` })).statusCode).toBe(200);
    const ok = await post(`/api/invites/accept/${token}`, null, { username: 'newfriend', password: 'longenough1' });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'] ?? '')).toContain('=');
    expect(db.prepare("SELECT role FROM users WHERE username = 'newfriend'").get()).toEqual({ role: 'user' });

    // used: the same link can't make a second account
    const again = await post(`/api/invites/accept/${token}`, null, { username: 'second', password: 'longenough1' });
    expect(again.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/invites/check/${token}` })).statusCode).toBe(404);
  });

  it('a revoked or wrong link does nothing', async () => {
    const { id, token } = (await post('/api/invites', 'a1', {})).json() as { id: string; token: string };
    expect((await app.inject({ method: 'DELETE', url: `/api/invites/${id}`, headers: bearer('a1') })).statusCode).toBe(200);
    expect((await post(`/api/invites/accept/${token}`, null, { username: 'nobody', password: 'longenough1' })).statusCode).toBe(404);
    expect((await post('/api/invites/accept/not-a-real-token-xx', null, { username: 'nobody2', password: 'longenough1' })).statusCode).toBe(404);
  });
});

describe('profile limits', () => {
  it('runs per day stop at the limit, and the GPU place is kept behind the owner', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/access/profiles/basic', headers: bearer('a1'), payload: { dailyRuns: 1, priority: 150 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/canvases/echo-g1', headers: bearer('g1'), payload: { name: 'Echo', ...echo() } })).statusCode).toBe(200);
    const first = await post('/api/runs', 'g1', { question: 'hi', canvasId: 'echo-g1', priority: 5 });
    expect(first.statusCode).toBe(200);
    const runId = (first.json() as { runId: string }).runId;
    expect(db.prepare('SELECT priority FROM runs WHERE id = ?').get(runId)).toEqual({ priority: 150 });
    const second = await post('/api/runs', 'g1', { question: 'again', canvasId: 'echo-g1' });
    expect(second.statusCode).toBe(429);
    // the admin has no limit
    expect((await app.inject({ method: 'PUT', url: '/api/canvases/echo-a1', headers: bearer('a1'), payload: { name: 'Echo', ...echo() } })).statusCode).toBe(200);
    expect((await post('/api/runs', 'a1', { question: 'hi', canvasId: 'echo-a1' })).statusCode).toBe(200);
  });
});
