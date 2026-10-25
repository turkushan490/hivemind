import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicAdapter } from '../src/providers/anthropic.js';
import { ollamaAdapter } from '../src/providers/ollama.js';
import { openaiAdapter } from '../src/providers/openai.js';
import type { StreamChunk } from '../src/providers/types.js';

/** A Response whose body arrives in awkward pieces, to test line splitting. */
function streamed(text: string, pieceSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += pieceSize) c.enqueue(bytes.slice(i, i + pieceSize));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(it: AsyncIterable<StreamChunk>) {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const req = { model: 'm', messages: [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hi' }] };
const signal = new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('openai-compatible adapter', () => {
  it('streams tokens and usage from SSE', async () => {
    const fetch = vi.fn(async () =>
      streamed(
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
          'data: [DONE]\n\n',
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const chunks = await collect(openaiAdapter({ id: 'x', kind: 'openai', preset: 'groq', baseUrl: 'https://api.example/v1/', apiKey: 'k' }).stream(req, signal));
    expect(chunks).toEqual([
      { type: 'token', text: 'Hel' },
      { type: 'token', text: 'lo' },
      { type: 'done', inputTokens: 5, outputTokens: 2 },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('marks OpenRouter :free models and converts prices', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        data: [
          { id: 'meta/llama:free', name: 'Llama (free)', pricing: { prompt: '0', completion: '0' } },
          { id: 'openai/gpt', pricing: { prompt: '0.000002', completion: '0.000008' } },
        ],
      }),
    );
    const models = await openaiAdapter({ id: 'or', kind: 'openai', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' }).listModels();
    expect(models[0].free).toBe(true);
    expect(models[1].free).toBe(false);
    expect(models[1].price).toEqual({ input: 2, output: 8 });
  });

  it('throws a readable error on HTTP failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 429 }));
    await expect(collect(openaiAdapter({ id: 'x', kind: 'openai', preset: 'openrouter', baseUrl: 'https://x' }).stream(req, signal))).rejects.toThrow(/429 rate limited/);
  });
});

describe('ollama adapter', () => {
  it('reports loading when the model is not in VRAM, then streams NDJSON', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/api/ps')
        ? Response.json({ models: [] })
        : streamed('{"message":{"content":"Hi"},"done":false}\n{"message":{"content":"!"},"done":false}\n{"done":true,"prompt_eval_count":3,"eval_count":2}\n'),
    );
    const chunks = await collect(ollamaAdapter({ id: 'o', kind: 'ollama', preset: 'ollama', baseUrl: 'http://ollama:11434' }).stream(req, signal));
    expect(chunks).toEqual([{ type: 'loading' }, { type: 'token', text: 'Hi' }, { type: 'token', text: '!' }, { type: 'done', inputTokens: 3, outputTokens: 2 }]);
  });
});

describe('ollama system-message fallback', () => {
  it('retries with the system prompt folded into the user message when the template rejects it', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'm' }] });
      const body = JSON.parse(init!.body as string);
      bodies.push(body);
      if (body.messages[0].role === 'system') return new Response('{"error":"System message must be at the beginning."}', { status: 500 });
      return streamed('{"message":{"thinking":"hmm"},"done":false}\n{"message":{"content":"ok"},"done":false}\n{"done":true,"eval_count":1,"eval_duration":500000000}\n');
    });
    const chunks = await collect(ollamaAdapter({ id: 'o', kind: 'ollama', preset: 'ollama', baseUrl: 'http://o' }).stream(req, signal));
    expect(bodies[1].messages).toEqual([{ role: 'user', content: 'sys\n\nhi' }]);
    expect(chunks).toEqual([{ type: 'thinking', text: 'hmm' }, { type: 'token', text: 'ok' }, { type: 'done', inputTokens: undefined, outputTokens: 1, genMs: 500 }]);
  });
});

describe('anthropic adapter', () => {
  it('moves the system prompt out of messages and streams text deltas', async () => {
    const fetch = vi.fn(async () =>
      streamed(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Yo"}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const chunks = await collect(anthropicAdapter({ id: 'a', kind: 'anthropic', preset: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k' }).stream(req, signal));
    expect(chunks).toEqual([{ type: 'token', text: 'Yo' }, { type: 'done', inputTokens: 9, outputTokens: 1 }]);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
