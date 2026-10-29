import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, fakeProvider, testApp } from './helpers.js';

let app: FastifyInstance;
let train: typeof import('../src/lab/train.js');
let comfy: string;
let files: string;

beforeAll(async () => {
  process.env.TRAIN_POLL_MS = '10';
  comfy = mkdtempSync(join(tmpdir(), 'hm-comfy-'));
  for (const d of ['input', 'output', 'models']) mkdirSync(join(comfy, d));
  process.env.COMFYUI_DIR = comfy;
  let db: Awaited<ReturnType<typeof testApp>>['db'];
  ({ app, db } = await testApp('imagelora', [['u1', 'admin']]));
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://ollama.test:11434', 1)").run();
  train = await import('../src/lab/train.js');
  files = join(process.env.DATA_DIR!, 'files');
  mkdirSync(join(files, 'faces'), { recursive: true });
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(files, 'faces', `p${i}.png`), `png ${i}`);
    if (i <= 2) writeFileSync(join(files, 'faces', `p${i}.txt`), `a man smiling ${i}`);
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.COMFYUI_DIR;
  return app?.close();
});

const call = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: bearer('u1'), ...(payload && { payload }) });

describe('image LoRAs', () => {
  it('adds pictures from a Files folder, captions the rest with a vision model, and trains in ComfyUI', async () => {
    const ds = (await call('POST', '/api/datasets', { name: 'My face', kind: 'image' })).json();
    expect((await call('POST', `/api/datasets/${ds.id}/pictures`, { folder: 'faces' })).json().added).toBe(6);
    // Again: the same pictures are updated, not doubled.
    expect((await call('POST', `/api/datasets/${ds.id}/pictures`, { folder: 'faces' })).json().dataset.items).toBe(6);

    let queued: any;
    let polls = 0;
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const json = (d: unknown) => new Response(JSON.stringify(d));
      if (url.endsWith('/api/chat')) return json({ message: { content: '"a man in a red jacket, outdoors"' } });
      if (url.endsWith('/object_info/TrainLoraNode'))
        return json({ TrainLoraNode: { input: { required: { model: ['MODEL'], steps: ['INT', { default: 16 }], training_dtype: [['bf16', 'fp32', 'none'], { default: 'bf16' }], rank: ['INT', { default: 8 }] } } } });
      if (url.endsWith('/queue')) return json({ queue_running: [], queue_pending: [] });
      if (url.endsWith('/prompt')) {
        queued = JSON.parse(String(init.body)).prompt;
        return json({ prompt_id: 'p1', node_errors: {} });
      }
      if (url.endsWith('/history/p1')) {
        if (++polls < 2) return json({});
        mkdirSync(join(comfy, 'output', 'loras', 'hivemind'), { recursive: true });
        writeFileSync(join(comfy, 'output', 'loras', 'hivemind', 'my-face-v1_00012_.safetensors'), 'lora');
        return json({ p1: { status: { status_str: 'success', completed: true } } });
      }
      return json({});
    });
    const r = (await call('POST', `/api/datasets/${ds.id}/caption`, { providerId: 'ollama', model: 'gemma4:e2b' })).json();
    expect(r).toEqual({ captioned: 3, left: 1 });
    await call('POST', `/api/datasets/${ds.id}/caption`, { providerId: 'ollama', model: 'gemma4:e2b' });

    const deps = {
      resolve: async () => ({ ...fakeProvider(), local: true, hostKey: 'gpu-host' }),
      freeGpu: async () => {},
      ollamaUrl: () => 'http://ollama.test:11434',
      comfyUrl: () => 'http://comfy.test:8188',
    };
    await expect(train.startTrain('u1', { base: '../evil.safetensors', name: 'my-face:v1', providerId: 'comfyui', datasetId: ds.id }, deps)).rejects.toThrow(/checkpoint/);
    const job = await train.startTrain('u1', { base: 'sdxl/juggernaut.safetensors', name: 'my-face:v1', providerId: 'comfyui', datasetId: ds.id, trigger: 'grim man', steps: 50 }, deps);
    expect(job).toMatchObject({ kind: 'image', backend: 'comfyui' });
    for (let i = 0; i < 200 && !['done', 'error'].includes((await call('GET', '/api/lab/train')).json().jobs[0].state); i++) await new Promise((res) => setTimeout(res, 20));
    const done = (await call('GET', '/api/lab/train')).json().jobs[0];
    expect(done).toMatchObject({ state: 'done', lora: 'hivemind/my-face-v1.safetensors' });

    // The workflow: the checkpoint, the pictures folder, ComfyUI's own defaults filled in, T4-safe settings.
    expect(queued['1'].inputs.ckpt_name).toBe('sdxl/juggernaut.safetensors');
    expect(queued['2'].inputs.folder).toBe(`hivemind/${job.id}`);
    expect(queued['6'].inputs).toEqual({ model: ['1', 0], steps: 50, training_dtype: 'bf16', rank: 32 });
    expect(queued['7'].inputs.prefix).toBe('loras/hivemind/my-face-v1');
    expect(existsSync(join(comfy, 'models', 'loras', 'hivemind', 'my-face-v1.safetensors'))).toBe(true);
    // The copy in ComfyUI's input folder is cleaned up; captions had the trigger word first.
    expect(existsSync(join(comfy, 'input', 'hivemind', job.id))).toBe(false);
    expect(calls.some((c) => c.startsWith('POST http://comfy.test:8188/prompt'))).toBe(true);
    expect(readFileSync(join(files, 'faces', 'p1.txt'), 'utf8')).toBe('a man smiling 1');
  });
});
