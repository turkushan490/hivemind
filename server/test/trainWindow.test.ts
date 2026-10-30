import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, fakeProvider, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let train: typeof import('../src/lab/train.js');
let clock: typeof import('../src/clock.js');
let ds: typeof import('../src/lab/datasets.js');
let datasetId: string;

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);

beforeAll(async () => {
  process.env.TRAIN_POLL_MS = '20';
  process.env.TRAINER_URL = 'http://trainer.test:8765';
  ({ app, db } = await testApp('trainwindow', [
    ['u1', 'admin'],
    ['u2', 'user'],
  ]));
  train = await import('../src/lab/train.js');
  clock = await import('../src/clock.js');
  ds = await import('../src/lab/datasets.js');
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://ollama.test:11434', 1)").run();
  const d = ds.createDataset('u1', { name: 'Support' });
  ds.addItems(d.id, 'manual', Array.from({ length: 25 }, (_, i) => ({ input: `q${i}`, output: `a${i}` })));
  datasetId = d.id;
});
afterAll(() => {
  clock.setClock();
  delete process.env.TRAINER_URL;
  return app?.close();
});
afterEach(() => vi.unstubAllGlobals());

const deps = () => ({ resolve: async () => ({ ...fakeProvider(), local: true, hostKey: 'gpu-host' }), freeGpu: async () => {}, ollamaUrl: () => 'http://ollama.test:11434' });

/** A fake trainer that trains until it is paused, finishes after a resume, and a fake Ollama. */
function fakeTrainer(opts: { finishRightAway?: boolean } = {}) {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let paused = false;
  let resumed = !!opts.finishRightAway;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.endsWith('/health')) return json({ ok: true, gpu: { name: 'GPU', usedMb: 100, totalMb: 16384 } });
    if (url.endsWith('/jobs') && method === 'POST') {
      if (body.resume) resumed = true;
      const dir = join(train.LAB_DIR, 'train', body.id);
      mkdirSync(join(dir, 'gguf'), { recursive: true });
      writeFileSync(join(dir, 'gguf', 'm.gguf'), 'weights');
      writeFileSync(join(dir, 'train.log'), '[download] unsloth/Qwen3.5-0.8B\n[train] step 1/4 loss 2.1000\n[train] step 2/4 loss 1.5000\n[gguf] exporting q4_k_m\n');
      return json({ ok: true });
    }
    if (url.endsWith('/pause')) return (paused = true), json({ ok: true });
    if (/\/jobs\/[^/]+$/.test(url)) {
      const losses = [
        { step: 1, loss: 2.1 },
        { step: 2, loss: 1.5 },
      ];
      if (resumed) return json({ state: 'done', gguf: 'gguf/m.gguf', step: 4, totalSteps: 4, loss: 1.1, losses, sample: { prompt: 'q0', answer: 'a0', expected: 'a0' } });
      return json(paused ? { state: 'paused', step: 2, totalSteps: 4, losses } : { state: 'training', step: 2, totalSteps: 4, loss: 1.5, etaS: 60, losses });
    }
    if (url.includes('/api/blobs/') && method === 'HEAD') return new Response(null, { status: 200 });
    if (url.endsWith('/api/create')) return json({ status: 'success' });
    if (url.endsWith('/api/delete')) return json({});
    return json({ error: 'unexpected' }, 404);
  });
  return calls;
}

const state = (id: string) => db.prepare('SELECT state, settings FROM lab_trains WHERE id = ?').get(id) as { state: string; settings: string };
async function waitState(id: string, want: string) {
  for (let i = 0; i < 400; i++) {
    if (state(id).state === want) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`job stayed ${state(id).state}, wanted ${want}`);
}

/** The SSE stream of a finished job, as [{event, data}]. */
async function events(id: string, who = 'u1') {
  const res = await app.inject({ method: 'GET', url: `/api/lab/train/${id}/events`, headers: bearer(who) });
  return {
    status: res.statusCode,
    type: res.headers['content-type'],
    list: res.body
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => ({ event: b.split('\n')[0].slice(7), data: JSON.parse(b.split('\n')[1].slice(6)) })),
  };
}

describe('training window', () => {
  it('a setting with a 03:00–08:00 default; GET /api/lab/window says whether it is open', async () => {
    clock.setClock(() => at(2, 2, 59));
    expect((await app.inject({ method: 'GET', url: '/api/lab/window', headers: bearer('u2') })).json()).toEqual({ start: '03:00', end: '08:00', open: false });
    clock.setClock(() => at(2, 3, 0));
    expect((await app.inject({ method: 'GET', url: '/api/lab/window', headers: bearer() })).json().open).toBe(true);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/training', headers: bearer('u2'), payload: { start: '01:00' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/training', headers: bearer(), payload: { start: '25:00' } })).statusCode).toBe(400);
    // Across midnight.
    const night = await app.inject({ method: 'PUT', url: '/api/settings/training', headers: bearer(), payload: { start: '22:00', end: '02:00' } });
    expect(night.json()).toEqual({ start: '22:00', end: '02:00', open: false });
    clock.setClock(() => at(2, 1, 30));
    expect((await app.inject({ method: 'GET', url: '/api/lab/window', headers: bearer() })).json().open).toBe(true);
    await app.inject({ method: 'PUT', url: '/api/settings/training', headers: bearer(), payload: { start: '03:00', end: '08:00' } });
  });

  it('a nightly job waits as queued, trains when the window opens, pauses when it closes and resumes in the next one', async () => {
    const calls = fakeTrainer();
    clock.setClock(() => at(2, 22, 0));
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'night:v1', providerId: 'ollama', datasetId, nightly: true }, deps());
    expect(job).toMatchObject({ state: 'queued', nightly: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(state(job.id).state).toBe('queued');
    expect(calls.some((c) => c.url.endsWith('/jobs'))).toBe(false);
    // 03:00: it starts.
    clock.setClock(() => at(3, 3, 0));
    await waitState(job.id, 'training');
    expect(calls.filter((c) => c.url.endsWith('/jobs'))).toHaveLength(1);
    // 08:00: a checkpoint, the GPU is free, and it waits for the next window.
    clock.setClock(() => at(3, 8, 0));
    await waitState(job.id, 'queued');
    expect(calls.some((c) => c.url.endsWith('/pause'))).toBe(true);
    expect(JSON.parse(state(job.id).settings).windowPaused).toBe(true);
    // The next night it continues from the checkpoint.
    clock.setClock(() => at(4, 3, 5));
    await waitState(job.id, 'done');
    expect(calls.filter((c) => c.url.endsWith('/jobs')).at(-1)!.body!.resume).toBe(true);
  });

  it('a nightly job started while the window is open trains right away', async () => {
    fakeTrainer({ finishRightAway: true });
    clock.setClock(() => at(5, 4, 0));
    const res = await app.inject({ method: 'POST', url: '/api/lab/train', headers: bearer(), payload: { base: 'unsloth/Qwen3.5-0.8B', name: 'day:v1', providerId: 'ollama', datasetId, nightly: true } });
    expect(res.json()).toMatchObject({ state: 'waiting', nightly: true });
    await waitState(res.json().id, 'done');
  });
});

describe('delete, live events and new examples', () => {
  it('refuses to delete a running job; deletes a finished one, with ?model=1 also from Ollama', async () => {
    const calls = fakeTrainer();
    clock.setClock(() => at(6, 4, 0));
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'gone:v1', providerId: 'ollama', datasetId }, deps());
    await waitState(job.id, 'training');
    const del = (id: string, q = '', who = 'u1') => app.inject({ method: 'DELETE', url: `/api/lab/train/${id}${q}`, headers: bearer(who) });
    expect((await del(job.id)).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/lab/train/${job.id}/cancel`, headers: bearer() })).statusCode).toBe(200);
    await waitState(job.id, 'cancelled');
    expect((await del(job.id, '', 'u2')).statusCode).toBe(404);
    expect((await del(job.id)).json()).toEqual({ ok: true, modelDeleted: false });
    expect(db.prepare('SELECT 1 FROM lab_trains WHERE id = ?').get(job.id)).toBeUndefined();

    const done = (db.prepare("SELECT id FROM lab_trains WHERE name = 'night:v1'").get() as { id: string }).id;
    expect((await del(done, '?model=1')).json()).toEqual({ ok: true, modelDeleted: true });
    const gone = calls.find((c) => c.url.endsWith('/api/delete'));
    expect(gone).toMatchObject({ method: 'DELETE', body: { model: 'night:v1' } });
    expect((await del(done)).statusCode).toBe(404);
  });

  it('GET /api/lab/train/:id/events streams state, progress, loss per step, log lines, the sample and end', async () => {
    const id = (db.prepare("SELECT id FROM lab_trains WHERE name = 'day:v1'").get() as { id: string }).id;
    const { status, type, list } = await events(id);
    expect(status).toBe(200);
    expect(type).toContain('text/event-stream');
    const of = (e: string) => list.filter((x) => x.event === e).map((x) => x.data);
    expect(of('state').at(-1)).toMatchObject({ state: 'done', note: 'Ready: day:v1' });
    expect(of('progress').at(-1)).toMatchObject({ step: 4, totalSteps: 4, loss: 1.1 });
    expect(of('loss')).toEqual([
      { step: 1, loss: 2.1 },
      { step: 2, loss: 1.5 },
    ]);
    expect(of('log')).toEqual(
      expect.arrayContaining([
        { source: 'trainer', line: '[download] unsloth/Qwen3.5-0.8B' },
        { source: 'trainer', line: '[gguf] exporting q4_k_m' },
        expect.objectContaining({ source: 'hivemind', line: expect.stringContaining('Importing gguf/m.gguf into Ollama') }),
      ]),
    );
    expect(of('sample')).toEqual([{ prompt: 'q0', answer: 'a0', expected: 'a0' }]);
    expect(list.at(-1)).toEqual({ event: 'end', data: { state: 'done' } });
    expect((await events(id, 'u2')).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toEqual(expect.arrayContaining(['trainEvents', 'trainingWindow']));
  });

  it('streams a running job live until it ends', async () => {
    fakeTrainer({ finishRightAway: true });
    clock.setClock(() => at(7, 4, 0));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'live:v1', providerId: 'ollama', datasetId }, deps());
    const addr = app.server.address() as { port: number };
    // node:http, because fetch is the fake trainer here.
    const text = await new Promise<string>((resolve, reject) =>
      get({ host: '127.0.0.1', port: addr.port, path: `/api/lab/train/${job.id}/events`, headers: bearer() }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', reject),
    );
    expect(text).toContain('event: end\ndata: {"state":"done"}');
    expect(text.indexOf('"state":"waiting"')).toBeLessThan(text.indexOf('"state":"done"'));
  });

  it('counts the examples a model name has not been trained on yet', async () => {
    // night:v1 is deleted; day:v1 and live:v1 trained on all 25 examples.
    expect(train.newExamples('u1', datasetId, 'day:v2')).toBe(0);
    ds.addItems(datasetId, 'manual', [
      { input: 'new1', output: 'x' },
      { input: 'new2', output: 'y' },
      { input: 'pending', output: 'z', review: 'pending' },
    ]);
    expect(train.newExamples('u1', datasetId, 'day:20261107')).toBe(2);
    expect(train.newExamples('u1', datasetId, 'never-trained')).toBe(27);
  });
});
