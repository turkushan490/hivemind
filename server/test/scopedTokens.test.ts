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

describe('limited tokens that may train', () => {
  let trainer: { authorization: string };
  let mine: string;
  let other: string;
  const as = (who: { authorization: string }, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: who, ...(payload && { payload }) });

  beforeAll(async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer(), payload: { name: 'DM trainer', canvases: ['dnd-*'], memory: ['dnd:*'], training: true, datasets: ['DungeonMind*'] } });
    expect(res.json().scope).toEqual({ canvases: ['dnd-*'], memory: ['dnd:*'], training: true, datasets: ['DungeonMind*'] });
    trainer = { authorization: `Bearer ${res.json().token}` };
    mine = (await app.inject({ method: 'POST', url: '/api/datasets', headers: bearer(), payload: { name: 'DungeonMind DM' } })).json().id;
    other = (await app.inject({ method: 'POST', url: '/api/datasets', headers: bearer(), payload: { name: 'Private notes' } })).json().id;
    await app.inject({ method: 'POST', url: `/api/datasets/${other}/items`, headers: bearer(), payload: { items: [{ input: 'secret', output: 'x' }] } });
    const { db } = await import('../src/db/index.js');
    db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://ollama.test:11434', 1)").run();
  });

  it('sees, makes and fills only matching datasets', async () => {
    expect(((await as(trainer, 'GET', '/api/datasets')).json() as { name: string }[]).map((d) => d.name)).toEqual(['DungeonMind DM']);
    expect((await as(trainer, 'POST', '/api/datasets', { name: 'Elsewhere' })).statusCode).toBe(403);
    expect((await as(trainer, 'POST', '/api/datasets', { name: 'DungeonMind Rules' })).statusCode).toBe(200);
    const added = await as(trainer, 'POST', `/api/datasets/${mine}/items`, { items: Array.from({ length: 3 }, (_, i) => ({ input: `turn ${i}`, output: '{"narration":"ok"}' })) });
    expect(added.json().added).toBe(3);
    const items = (await as(trainer, 'GET', `/api/datasets/${mine}/items`)).json() as { id: number }[];
    expect(items).toHaveLength(3);
    expect((await as(trainer, 'DELETE', `/api/datasets/items/${items[0].id}`)).statusCode).toBe(200);
    expect((await as(trainer, 'GET', `/api/datasets/${other}/items`)).statusCode).toBe(403);
    expect((await as(trainer, 'POST', `/api/datasets/${other}/items`, { items: [{ input: 'a', output: 'b' }] })).statusCode).toBe(403);
    const secret = ((await app.inject({ method: 'GET', url: `/api/datasets/${other}/items`, headers: bearer() })).json() as { id: number }[])[0];
    expect((await as(trainer, 'DELETE', `/api/datasets/items/${secret.id}`)).statusCode).toBe(403);
    expect((await as(trainer, 'DELETE', `/api/datasets/${mine}`)).statusCode).toBe(403);
    // A token without datasets in its scope reaches none.
    expect((await call('GET', '/api/datasets')).statusCode).toBe(403);
  });

  it('trains on matching datasets only, and reaches only the jobs it started', async () => {
    expect((await as(trainer, 'GET', '/api/lab/window')).statusCode).toBe(200);
    expect((await call('GET', '/api/lab/window')).statusCode).toBe(403);
    const body = { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:tok', providerId: 'ollama', allowSmall: true, nightly: true };
    expect((await call('POST', '/api/lab/train', { ...body, datasetId: mine })).statusCode).toBe(403);
    expect((await as(trainer, 'POST', '/api/lab/train', { ...body, datasetId: other })).statusCode).toBe(403);
    expect((await as(trainer, 'POST', '/api/lab/train', body)).statusCode).toBe(403);
    expect((await as(trainer, 'POST', '/api/lab/train', { ...body, datasetId: mine, flavor: 'l4x1', confirmUsd: 1 })).statusCode).toBe(403);
    const started = await as(trainer, 'POST', '/api/lab/train', { ...body, datasetId: mine });
    expect(started.statusCode).toBe(200);
    const id = started.json().id as string;
    const theirs = (await app.inject({ method: 'POST', url: '/api/lab/train', headers: bearer(), payload: { ...body, name: 'own:v1', datasetId: other } })).json().id as string;
    expect((await as(trainer, 'GET', `/api/lab/train/${id}`)).json()).toMatchObject({ id, name: 'dm:tok' });
    expect((await as(trainer, 'GET', `/api/lab/train/${theirs}`)).statusCode).toBe(403);
    expect((await as(trainer, 'POST', `/api/lab/train/${theirs}/cancel`)).statusCode).toBe(403);
    expect((await as(trainer, 'DELETE', `/api/lab/train/${theirs}`)).statusCode).toBe(403);
    expect((await as(trainer, 'GET', `/api/lab/train/${theirs}/events`)).statusCode).toBe(403);
    expect(((await as(trainer, 'GET', '/api/lab/train')).json().jobs as { id: string }[]).map((j) => j.id)).toEqual([id]);
    expect((await as(trainer, 'POST', `/api/lab/train/${id}/pause`)).statusCode).toBe(403);
    // Cancel, then delete its own job; the full token cleans up its own.
    for (const [who, job] of [
      [trainer, id],
      [bearer(), theirs],
    ] as const) {
      await as(who, 'POST', `/api/lab/train/${job}/cancel`);
      for (let i = 0; i < 100 && (await as(who, 'DELETE', `/api/lab/train/${job}`)).statusCode === 409; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await as(who, 'GET', `/api/lab/train/${job}`)).statusCode).toBe(404);
    }
  });

  it('training blocks work in its canvases, only with its datasets; schedules only for its canvases', async () => {
    const graph = (dataset: string) => ({ name: 'x', ...chain(node('q', 'input'), node('t', 'template', { prompt: 'A good answer' }), node('d', 'dataset', { dataset }), node('o', 'output')) });
    expect((await as(trainer, 'PUT', '/api/canvases/dnd-keep', graph('DungeonMind DM'))).statusCode).toBe(200);
    expect((await as(trainer, 'PUT', '/api/canvases/dnd-steal', graph('Private notes'))).statusCode).toBe(200);
    const ok = await as(trainer, 'POST', '/api/runs', { canvasId: 'dnd-keep', question: 'q' });
    expect((await waitRunAs(trainer, ok.json().runId)).json().status).toBe('done');
    const no = await as(trainer, 'POST', '/api/runs', { canvasId: 'dnd-steal', question: 'q' });
    const run = (await waitRunAs(trainer, no.json().runId)).json() as { status: string; events: { type: string; error?: string }[] };
    expect(run.events.find((e) => e.type === 'error')?.error).toMatch(/may not use dataset "Private notes"/);
    // A token without training rights: the blocks fail as before.
    const plain = await call('POST', '/api/runs', { canvasId: 'dnd-keep', question: 'q' });
    expect(((await waitRun(plain.json().runId)).json() as { events: { type: string; error?: string }[] }).events.find((e) => e.type === 'error')?.error).toMatch(/user who may train/);
    expect((await as(trainer, 'PUT', '/api/workflows/dnd-keep/schedule', { time: '03:15' })).statusCode).toBe(200);
    expect((await as(trainer, 'GET', '/api/workflows/dnd-keep/schedule')).json()).toMatchObject({ time: '03:15' });
    expect((await as(trainer, 'PUT', '/api/workflows/private/schedule', { time: '03:15' })).statusCode).toBe(403);
    expect((await as(trainer, 'DELETE', '/api/workflows/dnd-keep/schedule')).statusCode).toBe(200);
  });

  async function waitRunAs(who: { authorization: string }, runId: string) {
    for (let i = 0; i < 200; i++) {
      const r = await as(who, 'GET', `/api/runs/${runId}`);
      if (r.statusCode !== 409) return r;
      await new Promise((x) => setTimeout(x, 10));
    }
    throw new Error('run did not finish');
  }
});
