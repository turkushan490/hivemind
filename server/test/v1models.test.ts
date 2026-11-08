import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/providers/types.js';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: typeof import('../src/db/index.js').db;

const WRITE_FILE = { type: 'function', function: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } };
const ASK = { model: 'cloud/coder-1', messages: [{ role: 'system', content: 'You are an agent.' }, { role: 'system', content: 'Use tools.' }, { role: 'user', content: 'create hello.txt with the text hi' }], tools: [WRITE_FILE] };

/** An OpenAI-compatible server: lists one model, and answers every chat with a write_file call (split over two chunks). */
let lastBody: Record<string, unknown> | undefined;
function fakeCloud() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'coder-1', context_length: 32000 }] }), { headers: { 'content-type': 'application/json' } });
      lastBody = JSON.parse(String(init?.body));
      const sse = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"hello.txt",' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"hi"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } },
      ]
        .map((d) => `data: ${JSON.stringify(d)}\n\n`)
        .join('');
      return new Response(`${sse}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
}

beforeAll(async () => {
  ({ app, db } = await testApp('v1models', [['u1', 'admin'], ['u2', 'user']]));
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('cloud', 'custom', 'openai', 'Cloud', 'http://cloud.test/v1', 0)").run();
});
afterAll(() => app?.close());
afterEach(() => vi.unstubAllGlobals());

describe('/v1 single models for coding agents', () => {
  it('lists the provider models next to the canvases, with tool support', async () => {
    fakeCloud();
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer() });
    const m = (res.json() as { data: { id: string; hivemind?: { tools: boolean } }[] }).data.find((x) => x.id === 'cloud/coder-1');
    expect(m?.hivemind).toMatchObject({ kind: 'model', provider: 'cloud', tools: true, contextLength: 32000 });
  });

  it('answers a tool call (not streamed), with the system messages merged into one', async () => {
    fakeCloud();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: ASK });
    expect(res.statusCode).toBe(200);
    const choice = res.json().choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"hi"}' } }]);
    expect(res.json().usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 12 });
    const sent = lastBody!.messages as { role: string; content: string }[];
    expect(sent.filter((x) => x.role === 'system')).toEqual([{ role: 'system', content: 'You are an agent.\n\nUse tools.' }]);
    expect((lastBody!.tools as unknown[]).length).toBe(1);
    // Counted in the stats like a run.
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_usage WHERE node_type = 'api' AND model = 'coder-1'").get()).toMatchObject({ n: 1 });
  });

  it('streams the tool call in pieces as OpenAI does', async () => {
    fakeCloud();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { ...ASK, stream: true } });
    const chunks = res.body
      .split('\n\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)));
    const deltas = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(deltas[0]).toMatchObject({ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file' } });
    expect(deltas.map((d: { function: { arguments?: string } }) => d.function.arguments ?? '').join('')).toBe('{"path":"hello.txt","content":"hi"}');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('is off for people who did not switch it on (default off for non-admins), and refuses what can\'t fit', async () => {
    fakeCloud();
    const off = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer('u2'), payload: ASK });
    expect(off.statusCode).toBe(403);
    const big = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { ...ASK, messages: [{ role: 'user', content: 'x'.repeat(200_000) }] } });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.code).toBe('context_length_exceeded');
  });
});

describe('tool messages for each provider', () => {
  let msgs: ChatMessage[];
  let types: typeof import('../src/providers/types.js');
  // Loaded after the test app set its data folder (v1Models opens the database).
  beforeAll(async () => {
    types = await import('../src/providers/types.js');
    const { toChatMessages } = await import('../src/services/v1Models.js');
    msgs = toChatMessages([
    { role: 'system', content: 'a' },
    { role: 'user', content: 'make it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'system', content: 'b' },
    ]);
  });

  it('keeps one system message at the start and the tool turns', () => {
    expect(msgs[0]).toEqual({ role: 'system', content: 'a\n\nb' });
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(msgs[3]).toMatchObject({ role: 'tool', toolCallId: 'c1', toolName: 'write_file', content: 'ok' });
  });

  it('OpenAI, Ollama and Anthropic each get them in their own format', () => {
    const { anthropicMessages, ollamaMessages, openaiMessages } = types;
    expect(openaiMessages(msgs)[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x"}' } }] });
    expect(openaiMessages(msgs)[3]).toEqual({ role: 'tool', content: 'ok', tool_call_id: 'c1', name: 'write_file' });
    expect(ollamaMessages(msgs)[2]).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'x' } } }] });
    expect(ollamaMessages(msgs)[3]).toMatchObject({ role: 'tool', content: 'ok', tool_name: 'write_file' });
    const a = anthropicMessages(msgs.slice(1));
    expect(a[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write_file', input: { path: 'x' } }] });
    expect(a[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] });
  });
});
