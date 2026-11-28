import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';

/** Rollout R3b: an idle ComfyUI is told to unload its models after the set minutes, once per idle stretch. */

let db: Awaited<ReturnType<typeof testApp>>['db'];
let app: Awaited<ReturnType<typeof testApp>>['app'];
let leash: typeof import('../src/services/comfyLeash.js');
let busy = false;
const frees: string[] = [];

beforeAll(async () => {
  ({ app, db } = await testApp('comfyleash', [['a1', 'admin']]));
  leash = await import('../src/services/comfyLeash.js');
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('comfy', 'comfyui', 'comfyui', 'ComfyUI', 'http://gpu.test:8188', 1)").run();
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'http://gpu.test:8188/queue') return Response.json({ queue_running: busy ? [[1]] : [], queue_pending: [] });
    if (url === 'http://gpu.test:8188/free' && init?.method === 'POST') {
      frees.push(url);
      return Response.json({});
    }
    return new Response('not found', { status: 404 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  return app?.close();
});

describe('ComfyUI on a leash', () => {
  it('waits while busy, frees after the idle minutes, once', async () => {
    leash.setComfyIdleFreeMin(3);
    const t0 = 1_000_000;
    busy = true;
    expect(await leash.comfyLeashTick(t0)).toEqual([]);
    busy = false;
    expect(await leash.comfyLeashTick(t0 + 60_000)).toEqual([]); // idle 1 min
    expect(await leash.comfyLeashTick(t0 + 4 * 60_000)).toEqual(['comfy']); // idle 3+ min: freed
    expect(await leash.comfyLeashTick(t0 + 10 * 60_000)).toEqual([]); // already freed this idle stretch
    expect(frees.length).toBe(1);
    busy = true;
    await leash.comfyLeashTick(t0 + 11 * 60_000); // a new picture: free again after the next idle stretch
    busy = false;
    await leash.comfyLeashTick(t0 + 12 * 60_000);
    expect(await leash.comfyLeashTick(t0 + 16 * 60_000)).toEqual(['comfy']);
  });

  it('0 minutes = off', async () => {
    leash.setComfyIdleFreeMin(0);
    expect(await leash.comfyLeashTick(9_000_000_000)).toEqual([]);
  });
});
