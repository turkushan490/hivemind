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
