import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, chain, edge, node, testApp } from './helpers.js';

/** A run a restart stopped goes on where it was: finished blocks and For each items are not run again. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let runs: typeof import('../src/events/runs.js');
let api: typeof import('../src/api/runs.js');

const asked: string[] = [];
function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: { content: string }[] };
      asked.push(body.model);
      return new Response(`${JSON.stringify({ message: { content: `${body.model} says ${body.messages.at(-1)!.content.slice(0, 30)}` } })}\n${JSON.stringify({ done: true })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
}

const M = (model: string) => ({ providerId: 'ollama', model });
const row = (id: string) => db.prepare('SELECT status, final, events, checkpoint FROM runs WHERE id = ?').get(id) as { status: string; final: string | null; events: string | null; checkpoint: string | null };
async function until(fn: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (fn()) return;
  throw new Error('Timed out waiting');
}

/** Puts a run on "running" with this progress, as if the server had just been restarted in the middle of it. */
function stopped(id: string, graph: CanvasGraph, state: object) {
  const meta = { userId: 'u1', providerUserId: 'u1', graph, question: 'Go', vars: {}, source: 'Screen' };
  db.prepare("INSERT INTO runs (id, owner_id, question, status, checkpoint) VALUES (?, 'u1', 'Go', 'running', ?)").run(
    id,
    JSON.stringify({ meta, state: { outputs: {}, failed: [], skipped: [], blocked: [], loops: {}, ...state }, events: [{ type: 'run_start', runId: id, seq: 0, ts: 1, graph }] }),
  );
}

beforeAll(async () => {
  ({ app, db } = await testApp('resume'));
  runs = await import('../src/events/runs.js');
  api = await import('../src/api/runs.js');
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
});
beforeEach(() => {
  fakeOllama();
  asked.length = 0;
});
afterAll(() => app?.close());

describe('going on after a restart', () => {
  it('stores the progress while the run goes, and drops it when it ends', async () => {
    const graph = chain(node('q', 'input'), node('a', 'llm', { model: M('first') }), node('p', 'pause'), node('b', 'llm', { model: M('second') }), node('o', 'output'));
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer(), payload: { question: 'Go', graph } });
    const id = (res.json() as { runId: string }).runId;
    await until(() => row(id).status === 'paused');
    const cp = JSON.parse(row(id).checkpoint!);
    expect(Object.keys(cp.state.outputs).sort()).toEqual(['a', 'q']);
    expect(cp.meta.question).toBe('Go');
    expect(cp.events.some((e: RunEvent) => e.type === 'token')).toBe(false);
    runs.resumeRun(id, { id: 'u1', role: 'admin' }, { action: 'continue' });
    await until(() => row(id).status === 'done');
    expect(row(id).checkpoint).toBeNull();
  });

  it('skips the blocks that had finished', async () => {
    const graph = chain(node('q', 'input'), node('a', 'llm', { model: M('first') }), node('b', 'llm', { model: M('second') }), node('o', 'output'));
    stopped('r-blocks', graph, { outputs: { q: 'Go', a: 'first says (done before the restart)' } });
    expect(runs.closeStaleRuns()).toBe(0);
    expect(api.resumeStoppedRuns()).toBe(1);
    await until(() => row('r-blocks').status === 'done');
    expect(asked).toEqual(['second']);
    expect(row('r-blocks').final).toContain('second says');
    const events = JSON.parse(row('r-blocks').events!) as RunEvent[];
    expect(events.filter((e) => e.type === 'run_start')).toHaveLength(1);
  });

  it('goes on with a For each at its next item', async () => {
    const graph: CanvasGraph = {
      nodes: [node('q', 'input'), node('list', 'template', { prompt: 'one\ntwo\nthree' }), node('each', 'foreach'), node('w', 'llm', { model: M('worker'), prompt: 'Do {{inputs}}' }), node('all', 'collect'), node('o', 'output')],
      edges: [edge('q', 'list'), edge('list', 'each'), edge('each', 'w'), edge('w', 'all'), edge('all', 'o')],
    };
    stopped('r-loop', graph, { outputs: { q: 'Go', list: 'one\ntwo\nthree' }, loops: { each: { results: ['### Item 1: one\nworker says (before)'], ok: 1 } } });
    expect(api.resumeStoppedRuns()).toBe(1);
    await until(() => row('r-loop').status === 'done');
    expect(asked).toEqual(['worker', 'worker']);
    expect(row('r-loop').final).toMatch(/Item 1: one\nworker says \(before\)[\s\S]*Item 2: two[\s\S]*Item 3: three/);
  });

  it('a run whose user is gone is closed', async () => {
    const graph = chain(node('q', 'input'), node('o', 'output'));
    stopped('r-gone', graph, {});
    db.prepare("UPDATE runs SET checkpoint = json_set(checkpoint, '$.meta.userId', 'nobody') WHERE id = 'r-gone'").run();
    api.resumeStoppedRuns();
    expect(row('r-gone').status).toBe('error');
    expect(row('r-gone').checkpoint).toBeNull();
  });
});
