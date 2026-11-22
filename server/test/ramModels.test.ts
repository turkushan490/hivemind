import type { ProviderMemory } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let ollamaMod: typeof import('../src/providers/ollama.js');
let warm: typeof import('../src/services/keepWarm.js');

/** A fake Ollama: the GPU is full for GPU loads while `full`; what is loaded and what was asked are recorded. */
const o = { full: false, loaded: new Map<string, { size: number; vram: number }>(), chats: [] as Record<string, unknown>[], warms: [] as Record<string, unknown>[] };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  ({ app, db } = await testApp('ram'));
  ollamaMod = await import('../src/providers/ollama.js');
  warm = await import('../src/services/keepWarm.js');
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local, cpu_only) VALUES ('ollama-cpu', 'ollama', 'ollama', 'Ollama · CPU (RAM)', 'http://gpu.test:11434', 1, 1)").run();
  const g = { nodes: [{ id: 'c', type: 'llm', position: { x: 0, y: 0 }, config: { model: { providerId: 'ollama-cpu', model: 'desk' }, keepAlive: '8760h', numCtx: 32768 } }], edges: [] };
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('hb', 'u1', 'HiveBot', ?)").run(JSON.stringify(g));
});
afterAll(() => app.close());

beforeEach(() => {
  o.full = false;
  o.loaded.clear();
  o.chats = [];
  o.warms = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return json({ models: [...o.loaded].map(([name, m]) => ({ name, size: m.size, size_vram: m.vram, expires_at: new Date(Date.now() + 180_000).toISOString() })) });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (u.endsWith('/api/generate')) {
      if (body.keep_alive === 0) o.loaded.delete(body.model);
      else {
        o.warms.push(body);
        o.loaded.set(body.model, { size: 1.2e9, vram: 0 });
      }
      return json({ done: true });
    }
    if (u.endsWith('/api/chat')) {
      o.chats.push(body.options ?? {});
      if (o.full && body.options?.num_gpu !== 0)
        return json({ error: 'llama-server process has terminated: exit status 1: cudaMalloc failed: out of memory' }, 500);
      return new Response(`${JSON.stringify({ message: { content: 'hi' } })}\n${JSON.stringify({ done: true })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
});

describe('H36.1: a full GPU answers from RAM', () => {
  it('asks again with num_gpu 0 and says so on the block', async () => {
    o.full = true;
    const a = ollamaMod.ollamaAdapter({ id: 'ollama', kind: 'ollama', preset: 'ollama', baseUrl: 'http://gpu.test:11434' });
    const chunks = [];
    for await (const c of a.stream({ model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal)) chunks.push(c);
    expect(chunks).toContainEqual({ type: 'note', text: 'The GPU was full (ComfyUI?) — answered from RAM' });
    expect(chunks).toContainEqual({ type: 'token', text: 'hi' });
    expect(o.chats.map((c) => c.num_gpu)).toEqual([undefined, 0]);
    expect(ollamaMod.gpuFull('a 404')).toBe(false);
  });
});

describe('H36.2a: models kept in RAM come back', () => {
  it('reads keepAlive hours', () => {
    expect(warm.keepHours('8760h')).toBe(8760);
    expect(warm.keepHours('-1')).toBe(Infinity);
    expect(warm.keepHours('30m')).toBe(0.5);
    expect(warm.keepHours('soon')).toBeUndefined();
  });

  it('reloads a CPU model Ollama threw out, with the canvas context, once', async () => {
    expect(await warm.keepWarmTick()).toEqual(['desk']);
    expect(o.warms).toEqual([{ model: 'desk', prompt: '', keep_alive: '8760h', options: { num_ctx: 32768, num_gpu: 0 } }]);
    expect(await warm.keepWarmTick()).toEqual([]); // loaded now: nothing to do
    expect(warm.warmInfo('http://gpu.test:11434', 'desk')).toMatchObject({ reloads: 1 });
  });
});

describe('H36.3: one Ollama, each model once', () => {
  it('groups the providers of one server and shows where each model is', async () => {
    o.loaded.set('desk', { size: 1.2e9, vram: 0 });
    o.loaded.set('qwen3.5:9b', { size: 6.9e9, vram: 0.6e9 });
    const mem = (await app.inject({ method: 'GET', url: '/api/memory', headers: bearer() })).json() as ProviderMemory[];
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ providerId: 'ollama', name: 'Ollama (gpu.test:11434)', usedBy: ['Ollama', 'Ollama · CPU (RAM)'] });
    expect(mem[0].models.map((m) => m.model)).toEqual(['desk', 'qwen3.5:9b']);
    expect(mem[0].models[0].keptWarm).toBeDefined();
    // Unload all: one call per model to the one server.
    const r = (await app.inject({ method: 'POST', url: '/api/memory/unload', headers: bearer(), payload: {} })).json() as { unloaded: string[] };
    expect(r.unloaded).toEqual(['desk', 'qwen3.5:9b']);
  });
});
