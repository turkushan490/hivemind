import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StreamChunk } from '../src/providers/types.js';
import { bearer, testApp } from './helpers.js';

/** Colibri inside HiveMind: the engine manager, its two providers, and the API, against a fake `coli serve`. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let modelsDir: string;
let engine: typeof import('../src/colibri/engine.js');
const launches: { model: string; gpu: boolean; ramGb: number }[] = [];
const fake = fileURLToPath(new URL('./fake-coli.mjs', import.meta.url));
let failWith = '';

/** A finished download (its manifest says complete), or a half one. */
function addModel(name: string, complete = true) {
  const dir = join(modelsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.colibri-download.json'), JSON.stringify({ repo: `x/${name}`, complete, files: [] }));
  writeFileSync(join(dir, 'weights.bin'), Buffer.alloc(1000));
}

beforeAll(async () => {
  ({ app, db } = await testApp('colibri'));
  engine = await import('../src/colibri/engine.js');
  modelsDir = mkdtempSync(join(tmpdir(), 'hm-colibri-models-'));
  engine.configureColibri({
    root: mkdtempSync(join(tmpdir(), 'hm-colibri-root-')),
    modelsDir,
    port: 18790 + Math.floor(Math.random() * 500),
    launcher: (o) => {
      launches.push({ model: o.model, gpu: o.gpu, ramGb: o.ramGb });
      return { cmd: process.execPath, args: [fake, 'serve', '--model', o.dir, '--model-id', o.model, '--port', String(o.port)], env: (failWith ? { FAKE_COLI_FAIL: failWith } : {}) as Record<string, string> };
    },
  });
  const models = await import('../src/colibri/models.js');
  // The catalog normally comes from colibri's own setup_catalog.py.
  models.setHelperRunner(async (args) => {
    if (args[0] !== 'catalog') throw new Error('not in this test');
    return {
      type: 'result',
      disk_free: 5e11,
      models: [
        { id: 'qwen36-35b', name: 'Qwen3.6-35B-A3B', ram_min_gb: 10, size_class: 'small', status: 'tight', installed: true, downloaded_bytes: 0 },
        { id: 'glm-5.2', name: 'GLM-5.2', ram_min_gb: 99999, size_class: 'large', status: 'needs-ram', installed: true, downloaded_bytes: 0 },
      ],
    };
  });
  addModel('qwen36-35b');
  addModel('qwen3-coder-30b');
  addModel('glm-5.2');
  addModel('half-done', false);
  const { seedColibri } = await import('../src/api/providers.js');
  seedColibri();
});
afterAll(async () => {
  await engine?.stopEngine();
  await app?.close();
});

const collect = async (it: AsyncIterable<StreamChunk>) => {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};
const adapterOf = async (id: string) => {
  const { adapterFor } = await import('../src/api/providers.js');
  return adapterFor(db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as never);
};

describe('colibri engine', () => {
  it('both providers are added once, and only finished models are offered, with catalog names', async () => {
    const rows = db.prepare("SELECT id, kind, local FROM providers WHERE preset LIKE 'colibri%' ORDER BY id").all();
    expect(rows).toEqual([
      { id: 'colibri', kind: 'openai', local: 1 },
      { id: 'colibri-decisions', kind: 'decision', local: 1 },
    ]);
    const chat = await (await adapterOf('colibri')).listModels();
    expect(chat.map((m) => m.model).sort()).toEqual(['glm-5.2', 'qwen3-coder-30b', 'qwen36-35b']);
    expect(chat.find((m) => m.model === 'glm-5.2')?.name).toBe('GLM-5.2 (colibri, slow)');
    expect(chat.find((m) => m.model === 'qwen3-coder-30b')?.name).toBe('qwen3-coder-30b (colibri)');
    const decide = await (await adapterOf('colibri-decisions')).listModels();
    expect(decide.every((m) => m.kind === 'decision')).toBe(true);
  });

  it('loads a model on the first call, keeps it for the next, and switches by restarting', async () => {
    const a = await adapterOf('colibri');
    const first = await collect(a.stream({ model: 'qwen36-35b', messages: [{ role: 'user', content: 'hi' }], think: false }, new AbortController().signal));
    expect(first[0]).toEqual({ type: 'loading' });
    expect(first.filter((c) => c.type === 'token').map((c) => (c as { text: string }).text).join('')).toBe('qwen36-35b says: hi (no thinking)');
    const done = first.at(-1) as Extract<StreamChunk, { type: 'done' }>;
    expect(done.outputTokens).toBe(4);
    expect(done.loadMs).toBeGreaterThan(0);
    const second = await collect(a.stream({ model: 'qwen36-35b', messages: [{ role: 'user', content: 'again' }] }, new AbortController().signal));
    expect(second[0]).toEqual({ type: 'warm' });
    expect(launches.filter((l) => l.model === 'qwen36-35b')).toHaveLength(1);
    expect(await a.loaded!()).toMatchObject([{ model: 'qwen36-35b' }]);
    await collect(a.stream({ model: 'qwen3-coder-30b', messages: [{ role: 'user', content: 'code' }] }, new AbortController().signal));
    expect(engine.loadedModel()?.model).toBe('qwen3-coder-30b');
    expect(launches.map((l) => l.model)).toEqual(['qwen36-35b', 'qwen3-coder-30b']);
  });

  it('never switches models in the middle of an answer', async () => {
    const hold = await engine.acquire('qwen3-coder-30b');
    let switched = false;
    const other = engine.acquire('qwen36-35b').then((h) => {
      switched = true;
      h.release();
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(switched).toBe(false);
    expect(engine.loadedModel()?.model).toBe('qwen3-coder-30b');
    hold.release();
    await other;
    expect(engine.loadedModel()?.model).toBe('qwen36-35b');
  });

  it('refuses a model that needs more RAM than the container has, with what to do', async () => {
    const a = await adapterOf('colibri');
    await expect(collect(a.stream({ model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toThrow(/needs 99999 GB of RAM.*--memory/);
    await expect(engine.acquire('half-done')).rejects.toThrow(/has no model "half-done"/);
  });

  it('answers Decide questions through /v1/systemone', async () => {
    const a = await adapterOf('colibri-decisions');
    const r = await a.decide!({
      model: 'qwen36-35b',
      state: 'Checkout is down',
      questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { technical: 'bugs', billing: 'money' } }, down: { type: 'noul', instructions: 'Is it down?' } },
    });
    expect(r.answers.team).toMatchObject({ type: 'choice', choice: 'technical', probabilities: { technical: 0.8 } });
    expect(r.answers.down).toEqual({ type: 'noul', p: 0.9 });
    expect(r.usage.inputTokens).toBe(12);
  });

  it('shows why the engine would not start', async () => {
    await engine.stopEngine();
    failWith = 'qwen36 engine is broken: bad tensor layout';
    try {
      await expect(engine.acquire('qwen3-coder-30b')).rejects.toThrow(/could not start qwen3-coder-30b.*bad tensor layout/);
    } finally {
      failWith = '';
    }
  });

  it('unloads after the keep-alive', async () => {
    const h = await engine.acquire('qwen36-35b', { keepAlive: '300ms' });
    h.release();
    expect(engine.loadedModel()?.model).toBe('qwen36-35b');
    for (let i = 0; i < 50 && engine.loadedModel(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(engine.loadedModel()).toBeUndefined();
  });

  it('reads keep-alive values like Ollama', () => {
    expect(engine.keepAliveMs('30m')).toBe(1_800_000);
    expect(engine.keepAliveMs('90s')).toBe(90_000);
    expect(engine.keepAliveMs('2h')).toBe(7_200_000);
    expect(engine.keepAliveMs('-1')).toBe(0);
    expect(engine.keepAliveMs('soon')).toBeUndefined();
  });
});

describe('colibri in runs and settings', () => {
  it('shares the GPU queue with the Ollama on the same machine, and gets the long time limit', async () => {
    db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama-gpu', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
    const { resolverFor } = await import('../src/api/providers.js');
    const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as never;
    const p = await resolverFor(user)('colibri');
    expect(p.hostKey).toBe('gpu.test');
    expect(p.exclusive).toBe(true);
    expect(p.callSeconds).toBe(7200);
    // CPU only: it holds no GPU, so it never waits in the GPU queue.
    await app.inject({ method: 'PUT', url: '/api/colibri/settings', headers: bearer(), payload: { gpu: 'off', callSeconds: 3600 } });
    const cpu = await resolverFor(user)('colibri');
    expect(cpu.exclusive).toBe(false);
    expect(cpu.callSeconds).toBe(3600);
    await app.inject({ method: 'PUT', url: '/api/colibri/settings', headers: bearer(), payload: { gpu: 'auto', callSeconds: 7200 } });
  });

  it('Settings → Colibri: status, catalog, and admins only', async () => {
    const s = await app.inject({ method: 'GET', url: '/api/colibri/status', headers: bearer() });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ available: true, gpuHost: 'gpu.test', settings: { keepAliveMin: 10 } });
    const c = await app.inject({ method: 'GET', url: '/api/colibri/catalog', headers: bearer() });
    expect(c.json().models.map((m: { id: string }) => m.id)).toEqual(['qwen36-35b', 'glm-5.2']);
    const presets = (await app.inject({ method: 'GET', url: '/api/providers/presets' })).json() as { id: string }[];
    expect(presets.some((p) => p.id === 'colibri')).toBe(true);
    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json() as { features: string[] };
    expect(health.features).toContain('colibri');
  });

  it('the overnight research template puts the slow model on the big blocks', async () => {
    const { TEMPLATES } = await import('../../web/src/canvas/templates.js');
    const t = TEMPLATES.find((x) => x.id === 'deep-research-overnight')!;
    const fast = { providerId: 'groq', model: 'fast' };
    const big = { providerId: 'colibri', model: 'glm-5.2' };
    const g = t.build({ text: [fast], judge: fast, slow: big });
    const bigBlocks = g.nodes.filter((n) => n.config.model?.model === 'glm-5.2');
    expect(bigBlocks.map((n) => n.label)).toEqual(['Big model: facts, conflicts, links', 'Big model: final answer']);
    expect(bigBlocks.every((n) => (n.config.maxSeconds ?? 0) >= 3600)).toBe(true);
    // Reviewers stay on the fast models.
    expect(g.nodes.filter((n) => n.type === 'panel').every((n) => !n.config.models?.some((m) => m.model === 'glm-5.2'))).toBe(true);
  });
});
