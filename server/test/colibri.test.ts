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
      return { cmd: process.execPath, args: [fake, 'serve', '--model', o.dir, '--model-id', o.model, '--port', String(o.port), '--kv-slots', String(o.kvSlots)], env: (failWith ? { FAKE_COLI_FAIL: failWith } : {}) as Record<string, string> };
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
    // One model at a time: a second model has to wait for the first one's answer.
    await engine.stopEngine();
    engine.saveColibriSettings({ maxEngines: 1 });
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
    engine.saveColibriSettings({ maxEngines: 3 });
  });

  it('keeps several models loaded, each on its own port, and unloads the one used longest ago when RAM runs out', async () => {
    await engine.stopEngine();
    launches.length = 0;
    engine.saveColibriSettings({ maxEngines: 3, ramGb: 0 });
    const a = await adapterOf('colibri');
    await collect(a.stream({ model: 'qwen36-35b', messages: [{ role: 'user', content: 'one' }] }, new AbortController().signal));
    await collect(a.stream({ model: 'qwen3-coder-30b', messages: [{ role: 'user', content: 'two' }] }, new AbortController().signal));
    const both = engine.loadedModels();
    expect(both.map((m) => m.model).sort()).toEqual(['qwen3-coder-30b', 'qwen36-35b']);
    expect(new Set(both.map((m) => m.port)).size).toBe(2);
    // Only the first one got the GPU.
    expect(launches.map((l) => l.gpu)).toEqual([true, false]);
    // Back to the first: no load, it answers on its own port.
    const again = await collect(a.stream({ model: 'qwen36-35b', messages: [{ role: 'user', content: 'three' }] }, new AbortController().signal));
    expect(again[0]).toEqual({ type: 'warm' });
    expect(again.filter((c) => c.type === 'token').map((c) => (c as { text: string }).text).join('')).toContain('qwen36-35b says: three');
    expect(launches).toHaveLength(2);
    // RAM for 13 GB: qwen36 needs 10 GB, the others 2 GB each; a third model pushes out the one used longest ago (the coder).
    engine.saveColibriSettings({ ramGb: 13 });
    addModel('small-one');
    await collect(a.stream({ model: 'small-one', messages: [{ role: 'user', content: 'four' }] }, new AbortController().signal));
    expect(engine.loadedModels().map((m) => m.model).sort()).toEqual(['qwen36-35b', 'small-one']);
    expect((await a.loaded!()).map((m) => m.model).sort()).toEqual(['qwen36-35b', 'small-one']);
    // Unloading one leaves the other.
    await a.unload!('small-one');
    expect(engine.loadedModels().map((m) => m.model)).toEqual(['qwen36-35b']);
    engine.saveColibriSettings({ ramGb: 0 });
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

  it('keeps each conversation and the decisions on their own memory slot', async () => {
    const chat = await adapterOf('colibri');
    const dec = await adapterOf('colibri-decisions');
    const ask = (system: string, q: string) => collect(chat.stream({ model: 'qwen36-35b', messages: [{ role: 'system', content: system }, { role: 'user', content: q }] }, new AbortController().signal));
    await ask('You are Jev.', 'Hello');
    await ask('You are Jev.', 'What time is it?');
    await ask('You are Ultron.', 'Hello');
    await dec.decide!({ model: 'qwen36-35b', state: 'x', questions: { q: { type: 'noul', instructions: 'yes?' } } });
    const { kv, slots } = (await (await fetch(`${engine.colibriBase()}/debug/slots`)).json()) as { kv: number; slots: [string, number | null][] };
    expect(kv).toBe(4);
    const chats = slots.filter((s) => s[0] === 'chat').slice(-3).map((s) => s[1]!);
    // The same character keeps its slot (its prompt is read once); decisions have slot 3 to themselves.
    expect(chats[0]).toBe(chats[1]);
    expect(chats.every((n) => n >= 0 && n < 3)).toBe(true);
    expect(slots.filter((s) => s[0] === 'decide').at(-1)![1]).toBe(3);
  });

  it('a picture in the question goes to the model; one that reads text only is asked again without it', async () => {
    const { runGraph } = await import('../src/engine/run.js');
    const { resolverFor } = await import('../src/api/providers.js');
    const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as never;
    const g = {
      nodes: [
        { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'llm', position: { x: 1, y: 0 }, config: { model: { providerId: 'colibri', model: 'qwen36-35b' } } },
        { id: 'o', type: 'output', position: { x: 2, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 'a' },
        { id: 'e2', source: 'a', target: 'o' },
      ],
    } as never;
    const notes: string[] = [];
    const read: string[] = [];
    const r = await runGraph(
      g,
      'What is on this picture? ![cat](hm-file:uploads/cat.png)',
      { resolve: resolverFor(user), emit: (e) => e.type === 'node_progress' && notes.push((e as { note: string }).note), services: { readFile: (p) => (read.push(p), Buffer.from([0x89, 0x50, 1, 2])) } },
      new AbortController().signal,
    );
    expect(r.status).toBe('done');
    expect(read).toEqual(['uploads/cat.png']);
    expect(notes.some((n) => /can't read images/.test(n))).toBe(true);
    expect(r.final).toContain('[image: cat]');
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
    expect(s.json()).toMatchObject({ available: true, gpuHost: 'gpu.test', settings: { keepAliveMin: 30, kvSlots: 4 } });
    const c = await app.inject({ method: 'GET', url: '/api/colibri/catalog', headers: bearer() });
    expect(c.json().models.map((m: { id: string }) => m.id)).toEqual(['qwen36-35b', 'glm-5.2']);
    const presets = (await app.inject({ method: 'GET', url: '/api/providers/presets' })).json() as { id: string }[];
    expect(presets.some((p) => p.id === 'colibri')).toBe(true);
    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json() as { features: string[] };
    expect(health.features).toContain('colibri');
  });

  it('Colibri: start here sorts the question with colibri, answers on the matching branch, and explains', async () => {
    const { TEMPLATES } = await import('../../web/src/canvas/templates.js');
    const { runGraph } = await import('../src/engine/run.js');
    const { resolverFor } = await import('../src/api/providers.js');
    const t = TEMPLATES.find((x) => x.id === 'colibri-start')!;
    const g = t.build({
      text: [],
      colibri: { chat: { providerId: 'colibri', model: 'qwen36-35b' }, coder: { providerId: 'colibri', model: 'qwen36-35b' }, decide: { providerId: 'colibri-decisions', model: 'qwen36-35b' } },
    });
    const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as never;
    const r = await runGraph(g, 'How do I reverse a list in Python?', { resolve: resolverFor(user), emit: () => {} }, new AbortController().signal);
    expect(r.status).toBe('done');
    // The fake colibri picks the first option ("code"): only the code block answered.
    expect(r.final).toContain('qwen36-35b says: How do I reverse a list in Python?');
    expect(r.final).toContain('How this workflow worked');
    expect(r.final!.match(/says:/g)).toHaveLength(1);
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
