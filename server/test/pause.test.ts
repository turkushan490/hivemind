import type { ActivityRunning, CanvasGraph, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, chain, edge, node, testApp } from './helpers.js';

/** The Pause block: a run stops there until a person answers (Continue, Reject or Stop). */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let runs: typeof import('../src/events/runs.js');

const chats: string[] = [];
function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string; messages: { content: string }[] };
      chats.push(body.model);
      return new Response(`${JSON.stringify({ message: { content: `${body.model}: ${body.messages.at(-1)!.content}` } })}\n${JSON.stringify({ done: true })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
}

const M = (model: string) => ({ providerId: 'ollama', model });
const row = (id: string) => db.prepare('SELECT status, final, events FROM runs WHERE id = ?').get(id) as { status: string; final: string | null; events: string | null };
const events = (id: string) => JSON.parse(row(id).events ?? '[]') as RunEvent[];
async function until(fn: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (fn()) return;
  throw new Error('Timed out waiting');
}
async function start(graph: CanvasGraph, who = 'u1', extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer(who), payload: { question: 'Make it', graph, ...extra } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { runId: string }).runId;
}
const resume = (id: string, body: Record<string, unknown>, who = 'u1') => app.inject({ method: 'POST', url: `/api/runs/${id}/resume`, headers: bearer(who), payload: body });
const paused = (id: string) => until(() => row(id).status === 'paused');
const ended = (id: string) => until(() => !['running', 'paused'].includes(row(id).status));

/** input → template → Pause → LLM → output, plus a "rejected" branch → its own output. */
function reviewGraph(): CanvasGraph {
  return {
    nodes: [
      node('q', 'input'),
      node('draft', 'template', { prompt: 'Draft: {{question}}' }),
      node('p', 'pause', { title: 'Check the draft' }),
      node('go', 'llm', { model: M('writer') }, 'publish'),
      node('fix', 'template', { prompt: 'FIX {{inputs}}' }, 'rejected'),
      node('o', 'output'),
    ],
    edges: [edge('q', 'draft'), edge('draft', 'p'), edge('p', 'go'), edge('p', 'fix'), edge('go', 'o'), edge('fix', 'o')],
  };
}

beforeAll(async () => {
  ({ app, db } = await testApp('pause', [
    ['u1', 'admin'],
    ['u2', 'user'],
    ['u3', 'user'],
  ]));
  runs = await import('../src/events/runs.js');
  db.prepare("UPDATE users SET profile_id = 'everything'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
});
beforeEach(() => {
  fakeOllama();
  chats.length = 0;
});
afterEach(async () => {
  for (const r of runs.activeRuns({ id: 'u1', role: 'admin' })) runs.cancelRun(r.runId, { id: 'u1', role: 'admin' });
  await until(() => runs.activeRuns({ id: 'u1', role: 'admin' }).length === 0);
  vi.unstubAllGlobals();
  delete process.env.RUN_TIMEOUT_MINUTES;
});
afterAll(() => app?.close());

describe('Pause', () => {
  it('stops the run at the block; Continue with edited text sends the edited text on', async () => {
    const id = await start(reviewGraph(), 'u2');
    await paused(id);
    const act = (await app.inject({ method: 'GET', url: '/api/activity/running', headers: bearer('u2') })).json() as ActivityRunning;
    const mine = act.runs.find((r) => r.runId === id)!;
    expect(mine.paused?.[0]).toMatchObject({ nodeId: 'p', title: 'Check the draft', input: 'Draft: Make it' });
    expect(chats).toEqual([]);
    expect((await resume(id, { action: 'continue', text: 'Draft: better' }, 'u2')).statusCode).toBe(200);
    await ended(id);
    expect(row(id).status).toBe('done');
    expect(row(id).final).toContain('Draft: better');
    expect(row(id).final).not.toContain('Draft: Make it');
    const types = events(id).map((e) => e.type);
    expect(types).toContain('paused');
    expect(types).toContain('resumed');
    // The rejected branch was skipped.
    expect(events(id).find((e) => e.nodeId === 'fix')?.type).toBe('node_skipped');
  });

  it('Reject goes out the "rejected" branch with the comment', async () => {
    const id = await start(reviewGraph());
    await paused(id);
    await resume(id, { action: 'reject', comment: 'Too long' });
    await ended(id);
    expect(row(id).final).toMatch(/^FIX [\s\S]*Rejected by the reviewer: Too long/);
    expect(chats).toEqual([]);
  });

  it('Reject without a rejected branch ends the run; Stop cancels it', async () => {
    const plain = chain(node('q', 'input'), node('p', 'pause'), node('go', 'llm', { model: M('writer') }), node('o', 'output'));
    const a = await start(plain);
    await paused(a);
    await resume(a, { action: 'reject', comment: 'No' });
    await ended(a);
    expect(row(a).status).toBe('error');
    expect(events(a).find((e) => e.type === 'error' && e.nodeId === 'p')?.error).toBe('Rejected: No');
    const b = await start(plain);
    await paused(b);
    await resume(b, { action: 'stop' });
    await ended(b);
    expect(row(b).status).toBe('cancelled');
    expect(chats).toEqual([]);
  });

  it("another user can't resume it; an admin can; a limited token can resume its own run", async () => {
    const id = await start(reviewGraph(), 'u2');
    await paused(id);
    expect((await resume(id, { action: 'continue' }, 'u3')).statusCode).toBe(404);
    expect(row(id).status).toBe('paused');
    expect((await resume(id, { action: 'continue' }, 'u1')).statusCode).toBe(200);
    await ended(id);

    db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('dnd-review', 'u3', 'dnd-review', ?)").run(JSON.stringify(reviewGraph()));
    db.prepare('UPDATE api_tokens SET scope = ? WHERE id = ?').run(JSON.stringify({ canvases: ['dnd-*'], memory: [] }), 't-u3');
    const res = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer('u3'), payload: { question: 'x', canvasId: 'dnd-review' } });
    expect(res.statusCode, res.body).toBe(200);
    const own = (res.json() as { runId: string }).runId;
    await paused(own);
    expect((await resume(own, { action: 'continue' }, 'u3')).statusCode).toBe(200);
    await ended(own);
    expect(row(own).status).toBe('done');
    db.prepare('UPDATE api_tokens SET scope = NULL WHERE id = ?').run('t-u3');
  });

  it('holds no GPU lock: a run on the same local GPU goes on while it waits', async () => {
    const waiting = await start(chain(node('q', 'input'), node('p', 'pause'), node('l', 'llm', { model: M('later') }), node('o', 'output')));
    await paused(waiting);
    const other = await start(chain(node('q', 'input'), node('l', 'llm', { model: M('now') }), node('o', 'output')), 'u2');
    await ended(other);
    expect(row(other).status).toBe('done');
    expect(row(waiting).status).toBe('paused');
    await resume(waiting, { action: 'continue' });
    await ended(waiting);
    expect(chats).toEqual(['now', 'later']);
  });

  it("time spent paused doesn't count towards the run's time limit", async () => {
    process.env.RUN_TIMEOUT_MINUTES = String(0.4 / 60);
    const id = await start(chain(node('q', 'input'), node('p', 'pause'), node('l', 'llm', { model: M('writer') }), node('o', 'output')));
    await paused(id);
    await sleep(700);
    expect(row(id).status).toBe('paused');
    await resume(id, { action: 'continue' });
    await ended(id);
    expect(row(id).status).toBe('done');
  });

  it("cancelWhenAlone doesn't stop a paused run", async () => {
    runs.runTiming.aloneMs = 100;
    try {
      const id = await start(chain(node('q', 'input'), node('p', 'pause'), node('l', 'llm', { model: M('writer') }), node('o', 'output')), 'u1', { cancelWhenAlone: true });
      await paused(id);
      await sleep(300);
      expect(row(id).status).toBe('paused');
      runs.runTiming.aloneMs = 30_000;
      await resume(id, { action: 'continue' });
      await ended(id);
      expect(row(id).status).toBe('done');
    } finally {
      runs.runTiming.aloneMs = 30_000;
    }
  });

  it('a timeout answers for the person', async () => {
    const id = await start(chain(node('q', 'input'), node('p', 'pause', { timeoutMinutes: 0.003, onTimeout: 'reject' }), node('l', 'llm', { model: M('writer') }), node('o', 'output')));
    await ended(id);
    expect(events(id).find((e) => e.type === 'error' && e.nodeId === 'p')?.error).toBe('Rejected: Nobody answered in time');
  });

  it('a restart closes paused runs', async () => {
    db.prepare("INSERT INTO runs (id, owner_id, question, status, events) VALUES ('old-paused', 'u1', 'x', 'paused', '[]')").run();
    expect(runs.closeStaleRuns()).toBeGreaterThanOrEqual(1);
    expect(row('old-paused').status).toBe('error');
    expect(events('old-paused').find((e) => e.type === 'error')?.error).toBe('Stopped by a restart');
  });
});
