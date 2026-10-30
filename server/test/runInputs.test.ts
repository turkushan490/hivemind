import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;
let scoped: { authorization: string };
/** Every /api/chat request the fake Ollama got. */
const chats: { model: string; messages: { role: string; content: string }[] }[] = [];

beforeAll(async () => {
  const t = await testApp('runinputs');
  app = t.app;
  t.db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://ollama.test:11434', 0)").run();
  const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer(), payload: { name: 'DungeonMind', canvases: ['dnd-*'], memory: [] } });
  scoped = { authorization: `Bearer ${res.json().token}` };
  const graph = chain(
    node('i', 'input'),
    node('narrate', 'llm', { model: { providerId: 'ollama', model: 'qwen3:8b' }, system: 'You are the DM.', prompt: 'Narrate: {{question}}' }, 'narration'),
    node('state', 'llm', { model: { providerId: 'ollama', model: 'qwen3:8b' }, prompt: 'State of: {{inputs}}' }, 'state'),
    node('o', 'output'),
  );
  await app.inject({ method: 'PUT', url: '/api/canvases/dnd-narrate', headers: bearer(), payload: { name: 'narrate', ...graph } });
});
afterAll(() => app?.close());
afterEach(() => {
  chats.length = 0;
});

/** A fake Ollama that answers "<model> says hi" and records what it was sent. */
function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [] });
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(String(init.body));
      chats.push(body);
      return new Response(`${JSON.stringify({ message: { content: `${body.model} says hi` }, done: false })}\n${JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 3 })}\n`);
    }
    return Response.json({ error: 'unexpected' }, { status: 404 });
  });
}

describe('per-run model override and the messages each block sent', () => {
  it('models: a node id wins over "*", also for a limited token; ?inputs=1 shows the exact messages', async () => {
    fakeOllama();
    const start = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: scoped,
      payload: { canvasId: 'dnd-narrate', question: 'the door opens', models: { '*': { providerId: 'ollama', model: 'gemma3:4b' }, state: { providerId: 'ollama', model: 'dm-small:v1' } } },
    });
    expect(start.statusCode).toBe(200);
    const id = start.json().runId as string;
    let run: Record<string, any> = {};
    for (let i = 0; i < 200; i++) {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${id}?inputs=1`, headers: scoped });
      if (r.statusCode === 200) {
        run = r.json();
        break;
      }
      await new Promise((x) => setTimeout(x, 10));
    }
    expect(run.status).toBe('done');
    expect(chats.map((c) => c.model)).toEqual(['gemma3:4b', 'dm-small:v1']);
    expect(run.outputs.narration).toMatchObject({
      nodeId: 'narrate',
      text: 'gemma3:4b says hi',
      providerId: 'ollama',
      model: 'gemma3:4b',
      messages: [
        { role: 'system', content: 'You are the DM.' },
        { role: 'user', content: 'Narrate: the door opens' },
      ],
    });
    expect(run.outputs.state.messages).toEqual(chats[1].messages);
    // The stored canvas is untouched, and without ?inputs=1 nothing of it shows (nor in the events).
    expect(((await app.inject({ method: 'GET', url: '/api/canvases/dnd-narrate', headers: bearer() })).json().nodes[1].config.model.model)).toBe('qwen3:8b');
    const plain = (await app.inject({ method: 'GET', url: `/api/runs/${id}`, headers: scoped })).json();
    expect(plain.outputs.narration.messages).toBeUndefined();
    expect(plain.events.some((e: { sent?: unknown }) => e.sent)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toEqual(expect.arrayContaining(['modelOverride', 'nodeInputs']));
  });

  it('without models the canvas runs with its own; a bad override is a 400', async () => {
    fakeOllama();
    const run = await runAndWait(app, { canvasId: 'dnd-narrate', question: 'x' });
    expect(run.status).toBe('done');
    expect(chats.map((c) => c.model)).toEqual(['qwen3:8b', 'qwen3:8b']);
    const bad = (models: unknown) => app.inject({ method: 'POST', url: '/api/runs', headers: bearer(), payload: { canvasId: 'dnd-narrate', question: 'x', models } });
    expect((await bad({ nope: { providerId: 'ollama', model: 'm' } })).json().error).toMatch(/no block "nope"/);
    expect((await bad({ '*': { model: 'm' } })).statusCode).toBe(400);
    expect((await bad(['x'])).statusCode).toBe(400);
  });
});
