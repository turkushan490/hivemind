import { seesPictures, type CanvasGraph, type RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { pictureLinks, READ_PICTURE, runGraph, withDescriptions, type ResolvedProvider } from '../src/engine/run.js';
import type { ChatRequest } from '../src/providers/types.js';

/** A provider whose models answer with what they got: "<model> saw N pictures: <last user message>". */
function provider(vision: Record<string, boolean>, refuse: string[] = []): ResolvedProvider & { calls: ChatRequest[] } {
  const p = {
    calls: [] as ChatRequest[],
    local: true,
    hostKey: 'host',
    modelInfo: async (model: string) => ({ providerId: 'p', model, name: model, free: true, ...(model in vision && { vision: vision[model] }) }),
    adapter: {
      listModels: async () => [],
      async *stream(req: ChatRequest) {
        p.calls.push(req);
        const last = req.messages.at(-1)!;
        if (last.images?.length && refuse.includes(req.model)) throw new Error('HTTP 400: image input is not supported');
        if (last.content === READ_PICTURE) {
          yield { type: 'token' as const, text: 'A terminal showing "TypeError: x is undefined" on line 12.' };
        } else {
          yield { type: 'token' as const, text: `${req.model} saw ${last.images?.length ?? 0} pictures: ${last.content}` };
        }
        yield { type: 'done' as const, inputTokens: 1, outputTokens: 1 };
      },
    },
  };
  return p;
}

const graph = (model: string, pictures?: 'direct'): CanvasGraph =>
  ({
    nodes: [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
      { id: 'a', type: 'llm', position: { x: 1, y: 0 }, config: { model: { providerId: 'p', model }, prompt: '{{question}}', ...(pictures && { pictures }) } },
      { id: 'o', type: 'output', position: { x: 2, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'q', target: 'a' },
      { id: 'e2', source: 'a', target: 'o' },
    ],
  }) as never;

const QUESTION = 'Fix this error ![shot](hm-file:uploads/shot.png)';

async function run(model: string, p: ReturnType<typeof provider>, opts: { reader?: string; pictures?: 'direct' } = {}) {
  const notes: string[] = [];
  const r = await runGraph(
    graph(model, opts.pictures),
    QUESTION,
    {
      resolve: async () => p,
      emit: (e) => (e as RunEvent).type === 'node_progress' && notes.push((e as { note: string }).note),
      services: { readFile: () => Buffer.from([0x89, 0x50, 1, 2]) },
      ...(opts.reader && { pictureReader: async () => ({ providerId: 'p', model: opts.reader! }) }),
    },
    new AbortController().signal,
  );
  return { r, notes };
}

describe('pictures', () => {
  it('knows which models see', () => {
    expect(seesPictures('gemini-2.5-flash')).toBe(true);
    expect(seesPictures('gpt-4o-mini')).toBe(true);
    expect(seesPictures('claude-sonnet-4')).toBe(true);
    expect(seesPictures('openai/gpt-oss-120b')).toBe(false);
    expect(seesPictures('qwen3-coder-30b')).toBe(false);
    expect(seesPictures('hf.co/x/OmniCoder-9B-GGUF:Q4_K_M')).toBe(false);
    // What the provider says wins over the name.
    expect(seesPictures('gemma4:e2b', { vision: false })).toBe(false);
    expect(seesPictures('mystery', { vision: true })).toBe(true);
  });

  it('finds and replaces the picture links of the last question', () => {
    const msgs = [{ role: 'user' as const, content: QUESTION }];
    expect(pictureLinks(msgs)).toEqual([{ all: '![shot](hm-file:uploads/shot.png)', name: 'shot', path: 'uploads/shot.png' }]);
    const out = withDescriptions(msgs, new Map([['uploads/shot.png', 'an error']]), 'gemma4:e2b');
    expect(out[0].content).toBe('Fix this error [Picture "shot", described by gemma4:e2b:\nan error\n]');
  });

  it('a model that sees gets the picture itself', async () => {
    const p = provider({ 'gemma4:e2b': true });
    const { r } = await run('gemma4:e2b', p, { reader: 'gemma4:e2b' });
    expect(r.final).toContain('saw 1 pictures');
    expect(p.calls).toHaveLength(1);
  });

  it('a model that cannot see gets the picture reader\'s description instead', async () => {
    const p = provider({ omnicoder: false, 'gemma4:e2b': true });
    const { r, notes } = await run('omnicoder', p, { reader: 'gemma4:e2b' });
    expect(r.status).toBe('done');
    expect(r.final).toContain('omnicoder saw 0 pictures');
    expect(r.final).toContain('described by gemma4:e2b');
    expect(r.final).toContain('TypeError: x is undefined');
    expect(notes.some((n) => /can't see pictures — gemma4:e2b describes/.test(n))).toBe(true);
    // The reader got the picture, the coder only text.
    expect(p.calls[0].model).toBe('gemma4:e2b');
    expect(p.calls[0].messages[0].images).toHaveLength(1);
    expect(p.calls[1].messages.some((m) => m.images?.length)).toBe(false);
  });

  it('a model that refuses pictures it was thought to see gets the description on the second try', async () => {
    const p = provider({ 'gemma4:e2b': true }, ['qwen3.6:35b']);
    const { r, notes } = await run('qwen3.6:35b', p, { reader: 'gemma4:e2b' });
    expect(r.final).toContain('described by gemma4:e2b');
    expect(notes.some((n) => /picture reader describes them/.test(n))).toBe(true);
  });

  it('"send the picture straight to this model" skips the reader', async () => {
    const p = provider({ omnicoder: false, 'gemma4:e2b': true });
    const { r } = await run('omnicoder', p, { reader: 'gemma4:e2b', pictures: 'direct' });
    expect(r.final).toContain('omnicoder saw 1 pictures');
  });

  it('without a reader, a model that cannot see is still asked with the text', async () => {
    const p = provider({ omnicoder: false }, ['omnicoder']);
    const { r, notes } = await run('omnicoder', p);
    expect(r.final).toContain('omnicoder saw 0 pictures');
    expect(notes.some((n) => /asking with the text only/.test(n))).toBe(true);
  });
});
