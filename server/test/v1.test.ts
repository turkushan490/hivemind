import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasGraph } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completion, findCanvas, modelList, questionFrom, slugify, streamSource, usageOf } from '../src/services/openaiCompat.js';

describe('OpenAI mapping', () => {
  it('takes the last user message with text as the question', () => {
    expect(
      questionFrom([
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url' }] },
      ]),
    ).toBe('second');
    expect(questionFrom([{ role: 'user', content: 'a' }, { role: 'user', content: '  ' }])).toBe('a');
    expect(() => questionFrom([])).toThrow(/non-empty/);
    expect(() => questionFrom([{ role: 'system', content: 'x' }])).toThrow(/No user message/);
  });

  it('finds a canvas by id, slug, name or prefixed id', () => {
    const rows = [
      { id: 'abc123', name: 'Kitchen Council' },
      { id: 'zzz', name: 'Café Helper' },
    ];
    expect(findCanvas(rows, 'abc123')?.id).toBe('abc123');
    expect(findCanvas(rows, 'kitchen-council')?.id).toBe('abc123');
    expect(findCanvas(rows, 'hivemind/abc123')?.id).toBe('abc123');
    expect(findCanvas(rows, 'cafe-helper')?.id).toBe('zzz');
    expect(findCanvas(rows, 'Café Helper')?.id).toBe('zzz');
    expect(findCanvas(rows, 'nope')).toBeUndefined();
    expect(slugify('  Hello, World!  ')).toBe('hello-world');
  });

  it('lists canvases as models', () => {
    const list = modelList([{ id: 'c1', name: 'My Canvas', updatedAt: '2026-01-01 10:00:00' }]);
    expect(list.object).toBe('list');
    expect(list.data[0]).toMatchObject({ id: 'c1', object: 'model', owned_by: 'hivemind', name: 'My Canvas', slug: 'my-canvas', created: 1767261600 });
  });

  it('streams only from the single block feeding the Final answer', () => {
    const g = (edges: [string, string][]): CanvasGraph => ({
      nodes: ['q', 'a', 'b', 'out'].map((id) => ({ id, type: id === 'q' ? 'input' : id === 'out' ? 'output' : 'llm', position: { x: 0, y: 0 }, config: {} })),
      edges: edges.map(([source, target]) => ({ id: `${source}-${target}`, source, target })),
    });
    expect(streamSource(g([['q', 'a'], ['a', 'out']]))).toBe('a');
    expect(streamSource(g([['q', 'a'], ['q', 'b'], ['a', 'out'], ['b', 'out']]))).toBeUndefined();
    expect(streamSource(g([['q', 'out']]))).toBeUndefined();
  });

  it('builds a completion with usage from node events', () => {
    const usage = usageOf([
      { type: 'node_done', tokens: 5, inputTokens: 10 } as never,
      { type: 'node_done', tokens: 3 } as never,
      { type: 'token', tokens: 99 } as never,
    ]);
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
    const c = completion('r1', 'm', 'hello', usage);
    expect(c.choices[0].message).toEqual({ role: 'assistant', content: 'hello' });
    expect(c.object).toBe('chat.completion');
  });
});

describe('/v1 routes', () => {
  let app: FastifyInstance;
  const token = 'hm_testtoken';

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hm-v1-'));
    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const { db } = await import('../src/db/index.js');
    const { sha256 } = await import('../src/crypto.js');
    const { v1Routes } = await import('../src/api/v1.js');
    db.prepare("INSERT INTO users (id, username, pw_hash, role) VALUES ('u1', 'tester', 'x', 'admin')").run();
    db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES ('t1', 'u1', 'test', ?, 'hm_test')").run(sha256(token));
    // A canvas without models: the template block echoes the question.
    const graph: CanvasGraph = {
      nodes: [
        { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
        { id: 't', type: 'template', position: { x: 0, y: 0 }, config: { prompt: 'You said: {{question}}' } },
        { id: 'out', type: 'output', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 't' },
        { id: 'e2', source: 't', target: 'out' },
      ],
    };
    db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('c1', 'u1', 'Echo Test', ?)").run(JSON.stringify(graph));
    app = Fastify();
    await app.register(cookie);
    v1Routes(app);
    await app.ready();
  });
  afterAll(() => app?.close());

  const auth = { authorization: `Bearer ${token}` };

  it('refuses requests without a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer hm_wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });

  it('lists the canvases', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { id: string }) => m.id)).toEqual(['c1']);
  });

  it('answers a chat completion with the canvas output', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'echo-test', messages: [{ role: 'user', content: 'hello there' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('You said: hello there');
  });

  it('streams a chat completion as SSE chunks ending in [DONE]', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth,
      payload: { model: 'c1', stream: true, messages: [{ role: 'user', content: 'ping' }] },
    });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const datas = res.body
      .split('\n\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    expect(datas.at(-1)).toBe('[DONE]');
    const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('You said: ping');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });

  it('gives OpenAI-style errors for unknown canvases and missing messages', async () => {
    const a = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: { model: 'nope', messages: [{ role: 'user', content: 'x' }] } });
    expect(a.statusCode).toBe(404);
    expect(a.json().error.code).toBe('model_not_found');
    const b = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: { model: 'c1', messages: [] } });
    expect(b.statusCode).toBe(400);
  });
});
