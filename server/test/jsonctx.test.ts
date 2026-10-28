import type { RunEvent } from '@hivemind/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGraph } from '../src/engine/run.js';
import { parseJson } from '../src/nodes/index.js';
import { ollamaAdapter } from '../src/providers/ollama.js';
import { chatFrom } from '../src/services/openaiCompat.js';
import { chain, fakeProvider, node } from './helpers.js';

const M = { providerId: 'p', model: 'm' };
const run = async (graph: Parameters<typeof runGraph>[0], provider: ReturnType<typeof fakeProvider>, chat?: Parameters<typeof runGraph>[5]) => {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, 'q', { resolve: async () => provider, emit: (e) => events.push(e as RunEvent) }, new AbortController().signal, {}, chat);
  return { result, events };
};

describe('JSON mode', () => {
  it('strips fences and normalises the JSON', async () => {
    const p = fakeProvider(() => '```json\n{ "a": 1 }\n```');
    const { result } = await run(chain(node('i', 'input'), node('l', 'llm', { model: M, json: true, jsonSchema: '{a:number}' })), p);
    expect(result.final).toBe('{"a":1}');
    expect(p.calls[0].json).toBe(true);
    expect(p.calls[0].messages[0].content).toContain('{a:number}');
  });

  it('repairs bad JSON once', async () => {
    const p = fakeProvider((_, n) => (n === 1 ? '{a: oops' : '{"a":2}'));
    const { result } = await run(chain(node('i', 'input'), node('l', 'llm', { model: M, json: true })), p);
    expect(result.final).toBe('{"a":2}');
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1].messages.at(-1)!.content).toMatch(/not valid JSON/);
  });

  it('fails after two bad answers', async () => {
    const p = fakeProvider(() => 'nope');
    const { events } = await run(chain(node('i', 'input'), node('l', 'llm', { model: M, json: true })), p);
    expect(events.find((e) => e.type === 'error')?.error).toBe('Invalid JSON after repair');
  });

  it('parses plain and fenced text', () => {
    expect(parseJson(' {"x":[1]} ')).toEqual({ x: [1] });
    expect(parseJson('Here:\n```\n{"y":true}\n```')).toEqual({ y: true });
  });
});

describe('context size', () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = async (numCtx?: number) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
      bodies.push(JSON.parse(String(init!.body)));
      return new Response('{"message":{"content":"hi"},"done":true}\n');
    });
    for await (const _ of ollamaAdapter({ id: 'o', kind: 'ollama', preset: 'ollama', baseUrl: 'http://x' }).stream({ model: 'm', messages: [{ role: 'user', content: 'q' }], numCtx }, new AbortController().signal));
    return bodies[0].options as Record<string, unknown>;
  };

  it('sends num_ctx only when set', async () => {
    expect((await capture(32768)).num_ctx).toBe(32768);
    expect(await capture()).not.toHaveProperty('num_ctx');
  });

  it('clamps the block setting', async () => {
    const p = fakeProvider();
    await run(chain(node('i', 'input'), node('l', 'llm', { model: M, numCtx: 999999 })), p);
    expect(p.calls[0].numCtx).toBe(131072);
  });
});

describe('chat history', () => {
  const messages = [
    { role: 'system', content: 'Be brief' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'How are you?' },
  ];

  it('splits system, history and the question', () => {
    expect(chatFrom(messages)).toEqual({ question: 'How are you?', system: 'Be brief', history: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }] });
  });

  it('fills {{history}} and {{system}}', async () => {
    const c = chatFrom(messages);
    const { result } = await run(chain(node('i', 'input'), node('t', 'template', { prompt: '{{system}}|{{history}}|{{question}}' })), fakeProvider(), c);
    expect(result.final).toBe('Be brief|User: Hi\n\nAssistant: Hello|q');
  });

  it('sends real messages with useMessages', async () => {
    const p = fakeProvider();
    const c = chatFrom(messages);
    await run(chain(node('i', 'input'), node('l', 'llm', { model: M, useMessages: true })), p, c);
    expect(p.calls[0].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});
