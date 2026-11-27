import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import { ollamaAdapter } from '../src/providers/ollama.js';
import { biggerBudget, stripThink, thinkSplitter } from '../src/providers/think.js';
import type { ChatRequest, StreamChunk } from '../src/providers/types.js';

/**
 * A fake Ollama with a "thinking" vision model that ignores think: false (like huihui_ai/qwen3-vl-abliterated:8b):
 * it streams thinking first and only answers when num_predict leaves room after 3000 tokens of thinking.
 * "leaky" writes its thinking into the answer as <think>…</think>, in pieces; "mute" never answers.
 */
let server: Server;
let base = '';
const calls: { model: string; think?: boolean; numPredict?: number }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      const b = JSON.parse(body) as { model: string; think?: boolean; options?: { num_predict?: number } };
      const numPredict = b.options?.num_predict;
      calls.push({ model: b.model, think: b.think, numPredict });
      const line = (o: object) => res.write(`${JSON.stringify(o)}\n`);
      res.setHeader('content-type', 'application/x-ndjson');
      if (b.model === 'leaky') {
        for (const c of ['<thi', 'nk>The user wants a cat', '.</th', 'ink>\n\n', 'A grey cat ', 'on a sofa.']) line({ message: { role: 'assistant', content: c } });
        line({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 40 });
        return res.end();
      }
      line({ message: { role: 'assistant', content: '', thinking: 'Let me look at the picture. ' } });
      line({ message: { role: 'assistant', content: '', thinking: 'There is a cat… ' } });
      if (b.model === 'mute' || (numPredict ?? 0) < 4000) {
        line({ done: true, done_reason: 'length', prompt_eval_count: 10, eval_count: numPredict ?? 0 });
        return res.end();
      }
      line({ message: { role: 'assistant', content: 'A grey cat on a sofa.' } });
      line({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3100 });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const adapter = () => ollamaAdapter({ id: 'o', kind: 'ollama', preset: 'ollama', baseUrl: base });
async function collect(model: string, maxTokens?: number) {
  const out: StreamChunk[] = [];
  const req: ChatRequest = { model, messages: [{ role: 'user', content: 'what is this?' }], think: false, maxTokens };
  for await (const c of adapter().stream(req, new AbortController().signal)) out.push(c);
  return out;
}
const answer = (chunks: StreamChunk[]) => chunks.map((c) => (c.type === 'token' ? c.text : '')).join('');
const notes = (chunks: StreamChunk[]) => chunks.flatMap((c) => (c.type === 'note' ? [c.text] : []));

describe('thinking models that ignore think: false', () => {
  it('budget: 4× and at most 8192', () => {
    expect(biggerBudget(1500)).toBe(6000);
    expect(biggerBudget(2048)).toBe(8192);
    expect(biggerBudget(4096)).toBe(8192);
    expect(biggerBudget(8192)).toBeUndefined();
    expect(biggerBudget(undefined)).toBe(8192);
  });

  it('leaked <think>…</think> is split off as thinking, also in pieces', () => {
    expect(stripThink('<think>hmm</think>\n\nA cat')).toBe('A cat');
    expect(stripThink('<think>never closed')).toBe('');
    expect(stripThink('A cat')).toBe('A cat');
    const s = thinkSplitter();
    const got = [...['<th', 'ink>a', 'b</thi', 'nk> Answer'].flatMap((t) => s.push(t)), ...s.flush()];
    expect(got.filter((c) => c.type === 'thinking').map((c) => (c as { text: string }).text).join('')).toBe('ab');
    expect(answer(got)).toBe('Answer');
    const plain = thinkSplitter();
    expect(answer([...plain.push('Hello <think> is text here'), ...plain.flush()])).toBe('Hello <think> is text here');
  });

  it('the Ollama provider asks once more with a bigger num_predict when only thinking came back', async () => {
    calls.length = 0;
    const chunks = await collect('huihui_ai/qwen3-vl-abliterated:8b', 1500);
    expect(calls.map((c) => c.numPredict)).toEqual([1500, 6000]);
    expect(calls.every((c) => c.think === false)).toBe(true);
    expect(answer(chunks)).toBe('A grey cat on a sofa.');
    expect(notes(chunks)[0]).toMatch(/only thought and gave no answer — asking once more with 6000 tokens/);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', budget: 6000, outputTokens: 1500 + 3100 });
  });

  it('only once: a model that never answers gets a note, not a silent empty answer', async () => {
    calls.length = 0;
    const chunks = await collect('mute', 2048);
    expect(calls.map((c) => c.numPredict)).toEqual([2048, 8192]);
    expect(answer(chunks)).toBe('');
    expect(notes(chunks).at(-1)).toMatch(/only thought and gave no answer, also with 8192 tokens/);
  });

  it('thinking written into the answer is left out of it', async () => {
    calls.length = 0;
    const chunks = await collect('leaky', 1500);
    expect(calls).toHaveLength(1);
    expect(answer(chunks)).toBe('A grey cat on a sofa.');
    expect(chunks.some((c) => c.type === 'thinking' && c.text.includes('wants a cat'))).toBe(true);
  });
});

describe('the engine with a thinking picture reader', () => {
  const provider = (): ResolvedProvider =>
    ({
      local: true,
      hostKey: 'h',
      modelInfo: async (model: string) => ({ providerId: 'o', model, name: model, free: true, vision: model !== 'coder' }),
      adapter: {
        ...adapter(),
        // The coder can't see and answers with what it was asked; the readers are the fake Ollama.
        async *stream(req: ChatRequest, signal: AbortSignal) {
          if (req.model !== 'coder') return yield* adapter().stream(req, signal);
          yield { type: 'token' as const, text: `coder got: ${req.messages.at(-1)!.content}` };
          yield { type: 'done' as const };
        },
      },
    }) as never;
  const graph = (model: string): CanvasGraph =>
    ({
      nodes: [
        { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
        { id: 'a', type: 'llm', position: { x: 1, y: 0 }, config: { model: { providerId: 'o', model }, prompt: '{{question}}', think: false, maxTokens: 1500 } },
        { id: 'o', type: 'output', position: { x: 2, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 'a' },
        { id: 'e2', source: 'a', target: 'o' },
      ],
    }) as never;
  const run = async (model: string, reader: string) => {
    const said: string[] = [];
    const r = await runGraph(
      graph(model),
      'What is in it? ![pic](hm-file:uploads/cat.png)',
      {
        resolve: async () => provider(),
        emit: (e) => (e as RunEvent).type === 'node_progress' && said.push((e as { note: string }).note),
        services: { readFile: () => Buffer.from([0x89, 0x50, 1, 2]) },
        pictureReader: async () => ({ providerId: 'o', model: reader }),
      },
      new AbortController().signal,
    );
    return { r, said };
  };

  it('readPicture: the reader that only thought is asked again with a bigger budget and its description is used', async () => {
    calls.length = 0;
    const { r, said } = await run('coder', 'huihui_ai/qwen3-vl-abliterated:8b');
    expect(r.final).toContain('A grey cat on a sofa.');
    expect(calls.map((c) => c.numPredict)).toEqual([1500, 6000]);
    expect(said.some((n) => /only thought and gave no answer — asking once more with 6000/.test(n))).toBe(true);
  });

  it('readPicture: a reader that never answers says so instead of an empty description', async () => {
    const { said } = await run('coder', 'mute');
    expect(said.some((n) => /mute could not read pic: it only thought/.test(n))).toBe(true);
  });

  it('a normal call to a thinking model gets its answer after the bigger retry', async () => {
    calls.length = 0;
    const { r } = await run('huihui_ai/qwen3-vl-abliterated:8b', 'huihui_ai/qwen3-vl-abliterated:8b');
    expect(r.status).toBe('done');
    expect(r.final).toBe('A grey cat on a sofa.');
  });

  it('the engine itself retries for providers that do not (Colibri, OpenAI-compatible)', async () => {
    const budgets: (number | undefined)[] = [];
    const p = {
      local: true,
      hostKey: 'h',
      modelInfo: async (model: string) => ({ providerId: 'c', model, name: model, free: true }),
      adapter: {
        listModels: async () => [],
        async *stream(req: ChatRequest) {
          budgets.push(req.maxTokens);
          yield { type: 'thinking' as const, text: 'hmm' };
          if ((req.maxTokens ?? 0) >= 4000) yield { type: 'token' as const, text: '<think>more</think>Done.' };
          yield { type: 'done' as const, ...((req.maxTokens ?? 0) < 4000 && { stopped: 'length' as const }) };
        },
      },
    };
    const said: string[] = [];
    const r = await runGraph(graph('qwen36'), 'hi', { resolve: async () => p as never, emit: (e) => (e as RunEvent).type === 'node_progress' && said.push((e as { note: string }).note) }, new AbortController().signal);
    expect(budgets).toEqual([1500, 6000]);
    expect(r.final).toBe('Done.');
    expect(said.some((n) => /qwen36 only thought and gave no answer — asking once more with 6000/.test(n))).toBe(true);
  });
});
