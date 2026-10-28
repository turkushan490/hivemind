import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

let app: FastifyInstance;
let scoped: { authorization: string };

const canvas = (key: string) => ({ name: 'x', ...chain(node('q', 'input'), node('m', 'memory', { key, mode: 'save' }), node('o', 'output')) });

beforeAll(async () => {
  ({ app } = await testApp('scope', [['u1', 'user']]));
  const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer(), payload: { name: 'DungeonMind', canvases: ['dnd-*'], memory: ['dnd:*', 'rules:*'] } });
  expect(res.statusCode).toBe(200);
  scoped = { authorization: `Bearer ${res.json().token}` };
  for (const id of ['dnd-narrate', 'dnd-bad', 'private']) {
    const key = id === 'dnd-bad' ? 'secret' : 'dnd:{{vars.t}}';
    expect((await app.inject({ method: 'PUT', url: `/api/canvases/${id}`, headers: bearer(), payload: canvas(key) })).statusCode).toBe(200);
  }
});
afterAll(() => app?.close());

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: scoped, ...(payload && { payload }) });

async function waitRun(runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', `/api/runs/${runId}`);
    if (r.statusCode !== 409) return r;
    await new Promise((x) => setTimeout(x, 10));
  }
  throw new Error('run did not finish');
}

describe('canvas-scoped API tokens', () => {
  it('lists and installs only matching canvases', async () => {
    const list = (await call('GET', '/api/canvases')).json() as { id: string }[];
    expect(list.map((c) => c.id).sort()).toEqual(['dnd-bad', 'dnd-narrate']);
    expect((await call('GET', '/api/canvases/private')).statusCode).toBe(403);
    expect((await call('PUT', '/api/canvases/dnd-setup', canvas('dnd:x'))).statusCode).toBe(200);
    expect((await call('PUT', '/api/canvases/other', canvas('dnd:x'))).statusCode).toBe(403);
    const models = (await call('GET', '/v1/models')).json() as { data: { id: string }[] };
    expect(models.data.map((m) => m.id)).not.toContain('private');
  });

  it('reads only generated files (outputs/)', async () => {
    expect((await call('GET', '/api/files/raw?path=notes/secret.txt')).statusCode).toBe(403);
    expect((await call('GET', '/api/files/raw?path=/outputs/../notes/secret.txt')).statusCode).toBe(400);
    expect((await call('GET', '/api/files/raw?path=outputs/missing.png')).statusCode).toBe(404);
  });

  it('runs only its canvases, never an ad-hoc graph', async () => {
    expect((await call('POST', '/api/runs', { canvasId: 'private', question: 'x' })).statusCode).toBe(403);
    expect((await call('POST', '/api/runs', { graph: canvas('dnd:a'), question: 'x' })).statusCode).toBe(403);
    const ok = await call('POST', '/api/runs', { canvasId: 'dnd-narrate', question: 'hello', vars: { t: 't1' } });
    expect(ok.statusCode).toBe(200);
    expect((await waitRun(ok.json().runId)).json().status).toBe('done');
  });

  it('a block using a memory key outside the scope fails with a clear message', async () => {
    const res = await call('POST', '/api/runs', { canvasId: 'dnd-bad', question: 'x' });
    const run = (await waitRun(res.json().runId)).json() as { status: string; events: { type: string; error?: string }[] };
    expect(run.status).toBe('error');
    expect(run.events.find((e) => e.type === 'error')?.error).toMatch(/may not use memory "secret"/);
  });

  it('memory routes only for its key patterns; other routes are refused', async () => {
    expect((await call('POST', '/api/memory/keys/rules:srd51/import', { entries: [{ text: 'Grapple' }] })).statusCode).toBe(200);
    expect((await call('POST', '/api/memory/keys/notes/import', { entries: [{ text: 'x' }] })).statusCode).toBe(403);
    const keys = (await call('GET', '/api/memory/keys')).json() as { key: string }[];
    expect(keys.every((k) => k.key.startsWith('dnd:') || k.key.startsWith('rules:'))).toBe(true);
    expect((await call('GET', '/api/providers')).statusCode).toBe(403);
    expect((await call('POST', '/api/tokens', { name: 'more' })).statusCode).toBe(403);
    // The full token still sees everything.
    expect((await app.inject({ method: 'GET', url: '/api/providers', headers: bearer() })).statusCode).toBe(200);
  });

  it('rejects a bad scope', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer(), payload: { name: 'bad', canvases: 'dnd-*' } });
    expect(res.statusCode).toBe(400);
  });
});
