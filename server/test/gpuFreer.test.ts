import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];

beforeAll(async () => {
  ({ app, db } = await testApp('gpufreer'));
  const add = db.prepare('INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES (?, ?, ?, ?, ?, 1)');
  add.run('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434');
  add.run('jev', 'ollama-decisions', 'decision', 'Ollama decision models', 'http://gpu.test:11434');
  add.run('comfy', 'comfyui', 'comfyui', 'ComfyUI', 'http://gpu.test:9000');
});
afterAll(() => app?.close());
afterEach(() => vi.unstubAllGlobals());

describe('freeing the GPU before a local model call', () => {
  it('frees ComfyUI on the same machine, but not the same Ollama server under another provider', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ models: [{ name: 'wayfarer', model: 'wayfarer' }] }), { status: 200 });
    });
    const { gpuFreerFor } = await import('../src/api/providers.js');
    const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as never;
    await gpuFreerFor(user)('gpu.test', 'jev');
    expect(urls.some((u) => u.includes(':9000'))).toBe(true);
    expect(urls.some((u) => u.includes(':11434'))).toBe(false);
  });
});

describe('freeing only what is needed', () => {
  const GB = 1024 ** 3;
  /** A fake GPU host: Ollama with these loaded models, ComfyUI with this much free memory. */
  function host(opts: { loaded: string[]; comfyFree: number }) {
    const calls: string[] = [];
    let loaded = [...opts.loaded];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u.replace('http://gpu.test', '')}`);
      if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: loaded.map((name) => ({ name, model: name, size: 2 * GB, size_vram: 2 * GB })) }));
      if (u.endsWith('/api/generate')) {
        loaded = [];
        return new Response('{}');
      }
      if (u.endsWith('/system_stats')) return new Response(JSON.stringify({ devices: [{ vram_free: opts.comfyFree }] }));
      return new Response('{}');
    });
    return calls;
  }
  const freer = async () => {
    const { gpuFreerFor } = await import('../src/api/providers.js');
    return gpuFreerFor(db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as never);
  };

  it('frees nothing when the model is already loaded', async () => {
    const calls = host({ loaded: ['minicpm:latest'], comfyFree: 0 });
    await (await freer())('gpu.test', 'ollama', { model: 'minicpm', bytes: 1 * GB });
    expect(calls.some((c) => c.includes(':9000/free'))).toBe(false);
  });

  it('lets ComfyUI keep its model when the new one fits beside it, and frees it when it does not', async () => {
    let calls = host({ loaded: [], comfyFree: 6 * GB });
    await (await freer())('gpu.test', 'ollama', { model: 'small', bytes: 1.3 * GB });
    expect(calls.some((c) => c.includes(':9000/free'))).toBe(false);
    calls = host({ loaded: [], comfyFree: 6 * GB });
    await (await freer())('gpu.test', 'ollama', { model: 'big', bytes: 11.8 * GB });
    expect(calls.some((c) => c === 'POST :9000/free')).toBe(true);
  });

  it('before an image, waits until Ollama has really let its models go', async () => {
    const calls = host({ loaded: ['swift:27b'], comfyFree: 2 * GB });
    await (await freer())('gpu.test', 'comfy');
    const unload = calls.findIndex((c) => c.includes('/api/generate'));
    expect(unload).toBeGreaterThan(-1);
    expect(calls.slice(unload).some((c) => c.endsWith('/api/ps'))).toBe(true);
  });
});
