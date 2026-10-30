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
  // The "DungeonMind DM" dataset is what jobs without a datasetId train on (older clients).
  const ds = await import('../src/lab/datasets.js');
  const dm = ds.createDataset('u1', { name: ds.DM_DATASET });
  ds.addItems(dm.id, 'lab', Array.from({ length: 3 }, () => ({ input: 'the players act', output: '{"narration":"ok"}' })));
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

  it('refuses too little data, bad names and bad bases', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    const base = { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:v1', providerId: 'ollama' };
    await expect(train.startTrain('u1', base, deps())).rejects.toThrow(/at least 20/);
    await expect(train.startTrain('u1', { ...base, name: 'Bad Name', allowSmall: true }, deps())).rejects.toThrow(/lowercase/);
    await expect(train.startTrain('u1', { ...base, base: '../etc', allowSmall: true }, deps())).rejects.toThrow(/Hugging Face repo/);
  });

  it('trains, frees the GPU, and imports the GGUF into Ollama', async () => {
    process.env.TRAINER_URL = 'http://trainer.test:8765';
    const calls = fakeServers();
    const freed: string[] = [];
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'dungeonmind-dm:test', providerId: 'ollama', allowSmall: true, maxSteps: 5 }, deps(freed));
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
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:wait', providerId: 'ollama', allowSmall: true }, deps());
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
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-9B', name: 'dm:oom', providerId: 'ollama', allowSmall: true }, deps());
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
    const job = await train.startTrain('u1', { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:pause', providerId: 'ollama', allowSmall: true }, deps());
    await waitFor(job.id, ['training']);
    expect(train.pauseTrain(job.id, 'u1')).toBe(true);
    expect((await waitFor(job.id, ['paused'])).state).toBe('paused');
    expect(train.resumeTrain(job.id, 'u2', deps())).toBe(false);
    expect(train.resumeTrain(job.id, 'u1', deps())).toBe(true);
    expect((await waitFor(job.id, ['done', 'error'])).state).toBe('done');
    expect(JSON.parse(calls.filter((c) => c.url.endsWith('/jobs')).at(-1)!.body!).resume).toBe(true);
  });
  it('trains on Hugging Face Jobs only after the estimate is confirmed and within the daily limit, then publishes', async () => {
    const hf = await import('../src/lab/hf.js');
    const cmds: string[][] = [];
    let polls = 0;
    hf.setHfRunner(async (cmd, args, token) => {
      cmds.push([cmd, ...args]);
      if (!token) throw new Error('no token');
      if (cmd === 'whoami') return { name: 'turks' };
      if (cmd === 'hardware')
        return { hardware: [{ name: 'l4x1', label: '1x Nvidia L4', gpu: 'L4', count: 1, vramGb: 24, usdPerHour: 0.8 }, { name: 'l4x4', label: '4x L4', gpu: 'L4', count: 4, vramGb: 96, usdPerHour: 3.8 }] };
      if (cmd === 'job-start') return { jobId: 'hfjob1', repo: 'turks/hivemind-train-x', url: 'https://huggingface.co/jobs/turks/hfjob1' };
      if (cmd === 'job-status') {
        if (++polls < 2) return { stage: 'RUNNING', status: { state: 'training', step: 2, totalSteps: 8 } };
        mkdirSync(join(args[2], 'gguf'), { recursive: true });
        writeFileSync(join(args[2], 'gguf', 'cloud.Q4_K_M.gguf'), 'cloud weights');
        return { stage: 'COMPLETED', status: { state: 'done', gguf: 'gguf/cloud.Q4_K_M.gguf' } };
      }
      if (cmd === 'publish') return { url: `https://huggingface.co/${args[1]}` };
      return {};
    });
    fakeServers();
    const opts = { base: 'unsloth/Qwen3.5-0.8B', name: 'dm:cloud', providerId: 'ollama', allowSmall: true, flavor: 'l4x1' };
    await expect(train.startTrain('u1', opts, deps())).rejects.toThrow(/Connect Hugging Face/);
    await hf.saveHfSettings({ token: 'hf_test', dailyBudgetUsd: 0.1 });
    expect(hf.hfSettings()).toMatchObject({ hasToken: true, user: 'turks' });
    await expect(train.startTrain('u1', opts, deps())).rejects.toThrow(/confirm that amount/);
    const est = await train.cloudEstimate('u1', opts);
    expect(est).toMatchObject({ flavor: 'l4x1', label: '1x Nvidia L4' });
    await expect(train.startTrain('u1', { ...opts, confirmUsd: est.usd }, deps())).rejects.toThrow(/daily limit|cloud limit/);
    await hf.saveHfSettings({ dailyBudgetUsd: 50 });
    const freed: string[] = [];
    const job = await train.startTrain('u1', { ...opts, confirmUsd: est.usd }, deps(freed));
    expect(job).toMatchObject({ backend: 'hf-jobs', flavor: 'l4x1', estimateUsd: est.usd });
    // No pause for a paid machine; it doesn't take this server's GPU.
    expect(train.pauseTrain(job.id, 'u1')).toBe(false);
    expect(await waitFor(job.id, ['done', 'error'])).toMatchObject({ state: 'done' });
    expect(freed).toEqual([]);
    expect(cmds.find((c) => c[0] === 'job-start')![2]).toBe('l4x1');
    expect(hf.spentToday()).toBe(est.usd);
    const pub = await train.publishTrain(job.id, 'u1', { repo: 'dm-cloud' });
    expect(pub.url).toBe('https://huggingface.co/turks/dm-cloud');
    expect(cmds.find((c) => c[0] === 'publish')!.slice(2, 4)).toEqual(['turks/dm-cloud', '1']);
    expect(readFileSync(join(train.LAB_DIR, 'train', job.id, 'README.md'), 'utf8')).toContain('base_model: unsloth/Qwen3.5-0.8B');
    hf.setHfRunner();
  });
});
