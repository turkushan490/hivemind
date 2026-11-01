import type { ActivityRunning, ApiCall, ProviderMemory, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { get } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let runs: typeof import('../src/events/runs.js');
let memory: typeof import('../src/api/memory.js');
let activity: typeof import('../src/services/activity.js');
let settings: typeof import('../src/db/index.js');

/**
 * A fake Ollama on gpu.test, like the real one: "loop*" models never stop answering (until the request is
 * aborted), others answer at once. keep_alive 0 is answered with 200 but ignored while a request still uses the
 * model, or always when `sticky`.
 */
const ollama = {
  loaded: new Set<string>(),
  busy: new Map<string, number>(),
  sticky: false,
  chats: [] as { model: string; options: Record<string, unknown> }[],
};
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return json({ models: [...ollama.loaded].map((name) => ({ name, size: 2e9, size_vram: 2e9 })) });
    if (u.endsWith('/api/tags')) return json({ models: [] });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (u.endsWith('/api/generate')) {
      if (body.keep_alive === 0 && !ollama.sticky && !ollama.busy.get(body.model)) ollama.loaded.delete(body.model);
      return json({ done: true });
    }
    if (u.endsWith('/api/chat')) {
      const model = body.model as string;
      ollama.chats.push({ model, options: body.options });
      ollama.loaded.add(model);
      if (!model.startsWith('loop')) return new Response(`${JSON.stringify({ message: { content: `${model}: ok` } })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
      ollama.busy.set(model, (ollama.busy.get(model) ?? 0) + 1);
      const enc = new TextEncoder();
      let t: NodeJS.Timeout;
      const done = () => {
        clearInterval(t);
        ollama.busy.set(model, ollama.busy.get(model)! - 1);
      };
      return new Response(
        new ReadableStream({
          start(c) {
            t = setInterval(() => c.enqueue(enc.encode(`${JSON.stringify({ message: { thinking: 'wait, ' } })}\n`)), 5);
            init!.signal!.addEventListener('abort', () => {
              done();
              c.error(new DOMException('The operation was aborted', 'AbortError'));
            });
          },
          cancel: done,
        }),
      );
    }
    return new Response('not found', { status: 404 });
  });
}

const graph = (model: string, label = 'chronicler', providerId = 'ollama') => chain(node('i', 'input'), node('l', 'llm', { model: { providerId, model } }, label), node('o', 'output'));

async function start(payload: Record<string, unknown>, who = 'u1') {
  const res = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer(who), payload: { question: 'What happens next?', ...payload } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { runId: string }).runId;
}

const row = (id: string) => db.prepare('SELECT status, events, source FROM runs WHERE id = ?').get(id) as { status: string; events: string | null; source: string | null };

async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (await fn()) return;
  throw new Error('Timed out waiting');
}
const ended = (id: string) => until(() => row(id).status !== 'running');
const errorsOf = (id: string) => (JSON.parse(row(id).events ?? '[]') as RunEvent[]).filter((e) => e.type === 'error').map((e) => e.error);
const running = async (who = 'u1') => (await app.inject({ method: 'GET', url: '/api/activity/running', headers: bearer(who) })).json() as ActivityRunning;

beforeAll(async () => {
  ({ app, db } = await testApp('activity', [
    ['u1', 'admin'],
    ['u2', 'user'],
    ['u3', 'user'],
  ]));
  runs = await import('../src/events/runs.js');
  memory = await import('../src/api/memory.js');
  activity = await import('../src/services/activity.js');
  settings = await import('../src/db/index.js');
  db.prepare("UPDATE api_tokens SET name = 'DungeonMind' WHERE id = 't-u1'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
  // u2's own Ollama (on the same GPU), used by a canvas u2 shares.
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local, owner_id) VALUES ('own', 'ollama', 'ollama', 'My Ollama', 'http://gpu.test:11434', 1, 'u2')").run();
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph, shared) VALUES ('dnd-chronicle', 'u1', 'dnd-chronicle', ?, 0)").run(JSON.stringify(graph('loop-a')));
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph, shared) VALUES ('shared', 'u2', 'Shared story', ?, 1)").run(JSON.stringify(graph('loop-own', 'teller', 'own')));
  Object.assign(memory.unloadTiming, { runWaitMs: 2000, goneWaitMs: 150, pollMs: 20 });
});
beforeEach(() => {
  fakeOllama();
  ollama.loaded.clear();
  ollama.busy.clear();
  ollama.sticky = false;
  ollama.chats = [];
  settings.setSetting('run.limits', JSON.stringify({}));
  runs.runTiming.aloneMs = 30_000;
});
afterEach(async () => {
  // Nothing may keep running into the next test.
  for (const r of runs.activeRuns({ id: 'u1', role: 'admin' })) runs.cancelRun(r.runId, { id: 'u1', role: 'admin' });
  await until(() => runs.activeRuns({ id: 'u1', role: 'admin' }).length === 0);
  vi.unstubAllGlobals();
});
afterAll(() => app?.close());

describe('run limits', () => {
  it('stops a model that never answers, logs it in Problems, and the next queued run starts', async () => {
    settings.setSetting('run.limits', JSON.stringify({ maxSeconds: 0.2 }));
    const looping = await start({ canvasId: 'dnd-chronicle' });
    const next = await start({ graph: graph('quick') });
    await ended(looping);
    await ended(next);
    expect(row(looping).status).toBe('error');
    expect(errorsOf(looping)).toContain('loop-a was stopped after 0.2 seconds');
    expect(row(next).status).toBe('done');
    const logged = db.prepare('SELECT message FROM error_log WHERE run_id = ?').all(looping) as { message: string }[];
    expect(logged.map((l) => l.message)).toContain('chronicler (loop-a): loop-a was stopped after 0.2 seconds');
  });

  it('sends the token ceiling and the context size to a local model without its own', async () => {
    const id = await start({ graph: graph('quick') });
    await ended(id);
    expect(ollama.chats[0].options).toMatchObject({ num_predict: 4096, num_ctx: 16384 });
  });

  it('is an admin setting anyone can read', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings/run-limits', headers: bearer('u2') })).json()).toEqual({ maxSeconds: 600, maxTokens: 4096, numCtx: 16384 });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/run-limits', headers: bearer('u2'), payload: { maxSeconds: 60 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/run-limits', headers: bearer(), payload: { maxSeconds: 5 } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'PUT', url: '/api/settings/run-limits', headers: bearer(), payload: { maxSeconds: 300 } });
    expect(res.json()).toEqual({ maxSeconds: 300, maxTokens: 4096, numCtx: 16384 });
  });
});

describe('cancelWhenAlone', () => {
  /** Follows a run's event stream over real HTTP; returns a function that drops the connection. */
  async function follow(runId: string) {
    const addr = app.server.address() as { port: number };
    let req!: ReturnType<typeof get>;
    await new Promise<void>((resolve, reject) => {
      req = get({ host: '127.0.0.1', port: addr.port, path: `/api/runs/${runId}/events`, headers: bearer() }, (res) => {
        res.on('data', () => {});
        res.on('error', () => {});
        resolve();
      });
      req.on('error', () => {});
      setTimeout(() => reject(new Error('no stream')), 2000);
    });
    return () => req.destroy();
  }

  beforeAll(async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  it('cancels the run when nobody follows it, and lets go of the GPU', async () => {
    runs.runTiming.aloneMs = 150;
    const id = await start({ canvasId: 'dnd-chronicle', cancelWhenAlone: true });
    const drop = await follow(id);
    await sleep(250);
    expect(row(id).status).toBe('running');
    drop();
    const t0 = Date.now();
    await ended(id);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(row(id).status).toBe('cancelled');
    expect(errorsOf(id)[0]).toMatch(/^Stopped: nobody followed the run/);
    // The GPU is free again.
    const next = await start({ graph: graph('quick') });
    await ended(next);
    expect(row(next).status).toBe('done');
  });

  it('also counts from the start, for a client that never connects', async () => {
    runs.runTiming.aloneMs = 100;
    const id = await start({ canvasId: 'dnd-chronicle', cancelWhenAlone: true });
    await ended(id);
    expect(row(id).status).toBe('cancelled');
  });

  it('keeps going when a new follower comes in time, or without the flag', async () => {
    runs.runTiming.aloneMs = 1500;
    const id = await start({ canvasId: 'dnd-chronicle', cancelWhenAlone: true });
    const plain = await start({ graph: graph('loop-b') });
    (await follow(id))();
    await sleep(100);
    const drop = await follow(id);
    await sleep(1700);
    expect(row(id).status).toBe('running');
    expect(row(plain).status).toBe('running');
    drop();
  });

  it('is listed as a feature', async () => {
    const features = (await app.inject({ method: 'GET', url: '/api/health' })).json().features;
    expect(features).toEqual(expect.arrayContaining(['cancelWhenAlone', 'activity']));
  });
});

describe('Unload', () => {
  const unload = async (payload: Record<string, unknown>, who = 'u1') =>
    (await app.inject({ method: 'POST', url: '/api/memory/unload', headers: bearer(who), payload })).json() as { unloaded: string[]; failed: { model: string; error: string }[]; stoppedRuns: number };

  it('stops the run using the model, then the model is really gone', async () => {
    const id = await start({ canvasId: 'dnd-chronicle' });
    await until(() => ollama.busy.get('loop-a') === 1);
    const mem = (await app.inject({ method: 'GET', url: '/api/memory', headers: bearer() })).json() as ProviderMemory[];
    expect(mem.find((p) => p.providerId === 'ollama')!.models).toEqual([expect.objectContaining({ model: 'loop-a', runs: [{ runId: id, canvasName: 'dnd-chronicle', state: 'running' }] })]);
    const r = await unload({ providerId: 'ollama', model: 'loop-a' });
    expect(r).toEqual({ unloaded: ['loop-a'], failed: [], stoppedRuns: 1 });
    expect(ollama.loaded.has('loop-a')).toBe(false);
    expect(row(id).status).toBe('cancelled');
    expect(errorsOf(id)[0]).toBe('Stopped by Unload');
  });

  it('reports a model Ollama keeps as failed, never as unloaded', async () => {
    ollama.sticky = true;
    const id = await start({ graph: graph('quick') });
    await ended(id);
    const r = await unload({});
    expect(r.unloaded).toEqual([]);
    expect(r.failed).toEqual([{ model: 'quick', error: 'Still loaded: Ollama did not let it go' }]);
  });

  it("doesn't let a user stop another user's run", async () => {
    // u3 runs u2's shared canvas: on u2's own provider, but the run is u3's.
    const id = await start({ canvasId: 'shared' }, 'u3');
    await until(() => ollama.busy.get('loop-own') === 1);
    const r = await unload({ providerId: 'own' }, 'u2');
    expect(r.stoppedRuns).toBe(0);
    expect(r.failed).toEqual([{ model: 'loop-own', error: 'In use by a run of another user (Shared story)' }]);
    expect(row(id).status).toBe('running');
  });
});

describe('Activity: running now', () => {
  it('shows source, block, model and who holds the GPU; a user sees only their own', async () => {
    const holder = await start({ canvasId: 'dnd-chronicle' });
    await until(() => ollama.busy.get('loop-a') === 1);
    const waiting = await start({ graph: graph('quick', 'narrator') }, 'u2');
    await until(async () => !!(await running()).runs.find((r) => r.runId === waiting)?.blocks[0]?.waitingBehind);
    await until(async () => ((await running()).runs.find((r) => r.runId === holder)?.blocks[0]?.tokens ?? 0) > 0);
    const all = await running();
    const h = all.runs.find((r) => r.runId === holder)!;
    expect(h).toMatchObject({ source: 'API: DungeonMind', canvasName: 'dnd-chronicle', owner: 'user_u1', question: 'What happens next?', mine: true });
    expect(h.blocks).toEqual([expect.objectContaining({ label: 'chronicler', model: 'loop-a', state: 'running' })]);
    expect(h.blocks[0].tokens).toBeGreaterThan(0);
    const w = all.runs.find((r) => r.runId === waiting)!;
    expect(w.blocks).toEqual([expect.objectContaining({ label: 'narrator', state: 'waiting', waitingBehind: 'DungeonMind: chronicler' })]);
    const mine = await running('u2');
    expect(mine.runs.map((r) => r.runId)).toEqual([waiting]);
    // Limited tokens can't read it.
    db.prepare("UPDATE api_tokens SET scope = ? WHERE id = 't-u3'").run(JSON.stringify({ canvases: ['dnd-*'], memory: [] }));
    expect((await app.inject({ method: 'GET', url: '/api/activity/running', headers: bearer('u3') })).statusCode).toBe(403);
    db.prepare("UPDATE api_tokens SET scope = NULL WHERE id = 't-u3'").run();
  });

  it('stores the source of a run and shows it in the history', async () => {
    const id = await start({ graph: graph('quick') });
    await ended(id);
    expect(row(id).source).toBe('API: DungeonMind');
    const list = (await app.inject({ method: 'GET', url: '/api/runs', headers: bearer() })).json() as { id: string; source?: string }[];
    expect(list.find((r) => r.id === id)!.source).toBe('API: DungeonMind');
  });

  it("lets an admin stop anyone's run; another user gets 404", async () => {
    const id = await start({ graph: graph('loop-c') }, 'u2');
    await until(() => ollama.busy.get('loop-c') === 1);
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/cancel`, headers: bearer('u3') })).statusCode).toBe(404);
    expect(row(id).status).toBe('running');
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/cancel`, headers: bearer('u1') })).statusCode).toBe(200);
    await ended(id);
    expect(row(id).status).toBe('cancelled');
  });
});

describe('Activity: incoming API calls', () => {
  const calls = async (q = '', who = 'u1') => (await app.inject({ method: 'GET', url: `/api/activity/calls${q}`, headers: bearer(who) })).json() as ApiCall[];

  it('logs the route pattern and status, never the query string, headers or body', async () => {
    activity.clearApiCalls();
    const id = await start({ canvasId: 'dnd-chronicle', question: 'The secret door opens' });
    await app.inject({ method: 'GET', url: `/api/runs/${id}?inputs=1&key=hm_secret`, headers: bearer() });
    await app.inject({ method: 'GET', url: '/api/nothing-here?x=1', headers: bearer() });
    const log = await calls();
    const text = JSON.stringify(log);
    for (const leak of ['hm_secret', 'inputs=1', 'secret door', 'hm_u1', 'Bearer', 'x=1']) expect(text).not.toContain(leak);
    expect(log.find((c) => c.route === '/api/runs/:id' && c.method === 'GET')).toMatchObject({ token: 'DungeonMind', user: 'user_u1', status: 409 });
    expect(log.find((c) => c.route === '/api/runs' && c.method === 'POST')).toMatchObject({ runId: id, canvasName: 'dnd-chronicle', status: 200 });
    expect(log.some((c) => c.status === 404 && c.route === '(no such route)')).toBe(true);
    // Filters: failed only, one token; others see only their own.
    expect((await calls('?failed=1')).every((c) => c.status >= 400)).toBe(true);
    expect(await calls('?token=nobody')).toEqual([]);
    expect((await calls('', 'u2')).every((c) => c.user === 'user_u2')).toBe(true);
  });

  it('skips screen traffic and keeps at most 1,000 lines', async () => {
    activity.clearApiCalls();
    const { sha256 } = await import('../src/crypto.js');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('screen'), 'u1', Date.now() + 60_000);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { hm_session: 'screen' } })).statusCode).toBe(200);
    expect((await calls()).filter((c) => c.route === '/api/auth/me')).toEqual([]);
    for (let i = 0; i < 1010; i++) await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer() });
    expect(await calls('?limit=5000')).toHaveLength(1000);
  });
});

describe('startup', () => {
  it('closes runs left on "running" by the previous process', async () => {
    db.prepare("INSERT INTO runs (id, owner_id, question, status) VALUES ('stale', 'u1', 'q', 'running')").run();
    expect(runs.closeStaleRuns()).toBe(1);
    const res = await app.inject({ method: 'GET', url: '/api/runs/stale', headers: bearer() });
    expect(res.json()).toMatchObject({ status: 'error' });
    expect(res.json().events.map((e: RunEvent) => e.error ?? e.type)).toEqual(['Stopped by a restart', 'run_done']);
  });
});
