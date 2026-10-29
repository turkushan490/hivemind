import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, fakeProvider, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let train: typeof import('../src/lab/train.js');

beforeAll(async () => {
  process.env.TRAIN_POLL_MS = '20';
  ({ app, db } = await testApp('train', [
    ['u1', 'admin'],
    ['u2', 'user'],
    ['v1', 'viewer'],
  ]));
  train = await import('../src/lab/train.js');
  db.prepare("INSERT INTO lab_runs (id, owner_id, name, config, status) VALUES ('r1', 'u1', 'sim', '{}', 'stopped')").run();
  for (let i = 0; i < 3; i++)
    db.prepare("INSERT INTO lab_turns (run_id, game, turn, seed, model, input, output, json_valid, error_types) VALUES ('r1', 0, ?, 1, 'p|dm', 'the players act', '{\"narration\":\"ok\"}', 1, '[]')").run(i);
});
afterAll(() => app?.close());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TRAINER_URL;
});

const ollama = { ...fakeProvider(), local: true, hostKey: 'gpu-host' };
const deps = (freed: string[] = []) => ({
  resolve: async () => ollama,
  freeGpu: async (host: string) => void freed.push(host),
  ollamaUrl: () => 'http://ollama.test:11434',
});

/** A fake trainer (job runs, then done with a GGUF in the Lab folder) plus a fake Ollama; returns every call. */
function fakeServers(final: Record<string, unknown> = { state: 'done', gguf: 'gguf/model.Q4_K_M.gguf' }, gpuUsed: number[] = []) {
  const calls: { method: string; url: string; body?: string }[] = [];
  let polls = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: typeof init.body === 'string' ? init.body : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.endsWith('/health')) return json({ ok: true, busy: null, gpu: { name: 'Tesla T4', usedMb: gpuUsed.shift() ?? 500, totalMb: 16384 } });
    if (url.endsWith('/jobs') && method === 'POST') {
      // The trainer writes the GGUF into the shared Lab folder.
      const id = JSON.parse(String(init.body)).id;
      mkdirSync(join(train.LAB_DIR, 'train', id, 'gguf'), { recursive: true });
      writeFileSync(join(train.LAB_DIR, 'train', id, 'gguf', 'model.Q4_K_M.gguf'), 'GGUF fake weights');
      return json({ ok: true, id });
    }
    if (/\/jobs\/[^/]+$/.test(url)) return json(++polls < 2 ? { state: 'training', step: 3, totalSteps: 10, loss: 1.2 } : final);
    if (url.includes('/api/blobs/') && method === 'HEAD') return new Response(null, { status: 404 });
    if (url.includes('/api/blobs/')) return new Response(null, { status: 201 });
    if (url.endsWith('/api/create')) return json({ status: 'success' });
    return json({ error: 'unexpected' }, 404);
  });
  return calls;
}

const waitFor = async (id: string, states: string[]) => {
  for (let i = 0; i < 400; i++) {
    const row = db.prepare('SELECT state, error FROM lab_trains WHERE id = ?').get(id) as { state: string; error: string | null };
    if (states.includes(row.state)) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
};

describe('make a new model', () => {
  it('copies the trainer scripts and a token into the Lab folder', () => {
    expect(existsSync(join(train.LAB_DIR, 'trainer', 'server.py'))).toBe(true);
    expect(existsSync(join(train.LAB_DIR, 'trainer', 'train.py'))).toBe(true);
    expect(readFileSync(join(train.LAB_DIR, 'trainer', 'token'), 'utf8').length).toBeGreaterThan(20);
  });

  it('refuses too little data, bad names and bad bases', () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    const base = { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:v1', providerId: 'ollama' };
    expect(() => train.startTrain('u1', base, deps())).toThrow(/at least 20/);
    expect(() => train.startTrain('u1', { ...base, name: 'Bad Name', allowSmall: true }, deps())).toThrow(/lowercase/);
    expect(() => train.startTrain('u1', { ...base, base: '../etc', allowSmall: true }, deps())).toThrow(/Hugging Face repo/);
  });

  it('trains, frees the GPU, and imports the GGUF into Ollama', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    const calls = fakeServers();
    const freed: string[] = [];
    const job = train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'dungeonmind-dm:test', providerId: 'ollama', allowSmall: true, maxSteps: 5 }, deps(freed));
    expect((await waitFor(job.id, ['done', 'error'])).state).toBe('done');
    expect(freed).toEqual(['gpu-host']);
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/jobs'))!.body!);
    expect(sent).toMatchObject({ id: job.id, base: 'unsloth/Qwen3.5-0.8B', maxSteps: 5, quant: 'q4_k_m' });
    expect(readFileSync(join(train.LAB_DIR, 'train', job.id, 'dataset.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    const create = JSON.parse(calls.find((c) => c.url.endsWith('/api/create'))!.body!);
    expect(create.model).toBe('dungeonmind-dm:test');
    expect(Object.values(create.files)[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('waits while something else (ComfyUI making an image) still holds the GPU', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    const calls = fakeServers(undefined, [12000, 12000, 400]);
    const job = train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:wait', providerId: 'ollama', allowSmall: true }, deps());
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const row = db.prepare('SELECT state, progress FROM lab_trains WHERE id = ?').get(job.id) as { state: string; progress: string | null };
      if (row.state === 'waiting' && row.progress?.includes('GPU is busy')) seen.add('busy');
      if (row.state === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.has('busy')).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/health')).length).toBe(3);
    expect((await waitFor(job.id, ['done', 'error'])).state).toBe('done');
  });

  it('shows a trainer failure as an error in Problems', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    fakeServers({ state: 'error', error: 'The GPU ran out of memory' });
    const job = train.startTrain('u1', { base: 'unsloth/Qwen3.5-9B', name: 'dm:oom', providerId: 'ollama', allowSmall: true }, deps());
    const row = await waitFor(job.id, ['done', 'error']);
    expect(row.error).toMatch(/ran out of memory/);
    expect((db.prepare("SELECT message FROM error_log WHERE message LIKE 'Lab: making dm:oom%'").get() as { message: string }).message).toMatch(/out of memory/);
  });

  it('everyone except viewers may train; the trainer address stays admin-only', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    fakeServers();
    const res = await app.inject({ method: 'GET', url: '/api/lab/train', headers: bearer('u1') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rows: 3, minRows: 20, trainer: { ok: true, gpu: { name: 'Tesla T4' } } });
    expect((await app.inject({ method: 'GET', url: '/api/lab/train', headers: bearer('u2') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/lab/train', headers: bearer('v1'), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/lab/train/settings', headers: bearer('u2'), payload: { url: '' } })).statusCode).toBe(403);
  });

  it('pauses after a checkpoint, frees the GPU, and resumes from it', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    const calls: { url: string; body?: string }[] = [];
    let paused = false;
    let resumed = false;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      const json = (data: unknown) => new Response(JSON.stringify(data));
      if (url.endsWith('/health')) return json({ ok: true, gpu: { name: 'Tesla T4', usedMb: 300, totalMb: 16384 } });
      if (url.endsWith('/pause')) return (paused = true), json({ ok: true });
      if (url.endsWith('/jobs')) {
        const body = JSON.parse(String(init.body));
        if (body.resume) resumed = true;
        mkdirSync(join(train.LAB_DIR, 'train', body.id, 'gguf'), { recursive: true });
        writeFileSync(join(train.LAB_DIR, 'train', body.id, 'gguf', 'm.gguf'), 'x');
        return json({ ok: true });
      }
      if (/\/jobs\/[^/]+$/.test(url)) return json(resumed ? { state: 'done', gguf: 'gguf/m.gguf' } : paused ? { state: 'paused', step: 4, totalSteps: 10 } : { state: 'training', step: 2, totalSteps: 10 });
      if (url.includes('/api/blobs/') && init.method === 'HEAD') return new Response(null, { status: 200 });
      if (url.endsWith('/api/create')) return json({ status: 'success' });
      return json({});
    });
    const job = train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:pause', providerId: 'ollama', allowSmall: true }, deps());
    await waitFor(job.id, ['training']);
    expect(train.pauseTrain(job.id, 'u1')).toBe(true);
    expect((await waitFor(job.id, ['paused'])).state).toBe('paused');
    expect(train.resumeTrain(job.id, 'u2', deps())).toBe(false);
    expect(train.resumeTrain(job.id, 'u1', deps())).toBe(true);
    expect((await waitFor(job.id, ['done', 'error'])).state).toBe('done');
    expect(JSON.parse(calls.filter((c) => c.url.endsWith('/jobs')).at(-1)!.body!).resume).toBe(true);
  });
});
