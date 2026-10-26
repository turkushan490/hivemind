import { councilGraph, type CanvasGraph, type CanvasNode, type RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../src/engine/graph.js';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import type { ChatRequest } from '../src/providers/types.js';
import type { NodeServices } from '../src/nodes/index.js';

/** Fake provider: answers "<model>: <last user message start>", optionally failing or slow. */
function fake(opts: { local?: boolean; fail?: string; delay?: number } = {}): ResolvedProvider & { calls: ChatRequest[]; active: number; maxActive: number } {
  const p = {
    calls: [] as ChatRequest[],
    active: 0,
    maxActive: 0,
    local: !!opts.local,
    hostKey: 'host',
    modelInfo: async () => ({ providerId: 'p', model: 'x', name: 'x', free: false, price: { input: 1, output: 2 } }),
    adapter: {
      listModels: async () => [],
      async *stream(req: ChatRequest) {
        p.calls.push(req);
        p.active++;
        p.maxActive = Math.max(p.maxActive, p.active);
        try {
          if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
          if (req.model === opts.fail) throw new Error('boom');
          for (const w of [`${req.model}:`, ' ok']) yield { type: 'token' as const, text: w };
          yield { type: 'done' as const, inputTokens: 10, outputTokens: 2 };
        } finally {
          p.active--;
        }
      },
    },
  };
  return p;
}

const ref = (model: string) => ({ providerId: 'p', model });

async function run(graph = councilGraph([ref('a'), ref('b'), ref('c')], ref('judge')), provider = fake()) {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, 'What is 2+2?', { resolve: async () => provider, emit: (e) => events.push(e as RunEvent) }, new AbortController().signal);
  return { result, events, provider };
}

describe('validateGraph', () => {
  it('orders a council graph', () => {
    const order = validateGraph(councilGraph([ref('a'), ref('b')], ref('j')));
    expect(order[0]).toBe('q');
    expect(order.at(-1)).toBe('out');
    expect(order.indexOf('j')).toBeGreaterThan(order.indexOf('m2'));
  });

  it('rejects cycles and missing models', () => {
    const g = councilGraph([ref('a')], ref('j'));
    expect(() => validateGraph({ ...g, edges: [...g.edges, { id: 'back', source: 'j', target: 'm1' }] })).toThrow(/cycle/);
    g.nodes[1].config.model = undefined;
    expect(() => validateGraph(g)).toThrow(/no model/);
  });
});

describe('runGraph', () => {
  it('runs question → 3 models → judge → output', async () => {
    const { result, events, provider } = await run();
    expect(result.status).toBe('done');
    expect(result.final).toBe('judge: ok');
    // The judge got all three answers.
    const judgeCall = provider.calls.find((c) => c.model === 'judge')!;
    expect(judgeCall.messages[0].role).toBe('system');
    for (const m of ['a: ok', 'b: ok', 'c: ok']) expect(judgeCall.messages[1].content).toContain(m);
    expect(events[0].type).toBe('run_start');
    expect(events.at(-1)!.type).toBe('run_done');
    expect(events.filter((e) => e.type === 'node_done')).toHaveLength(6);
    // 4 model calls × (10 in × $1 + 2 out × $2) / 1M
    expect(result.cost).toBeCloseTo((4 * 14) / 1e6);
  });

  it('keeps going when one model fails', async () => {
    const { result, events, provider } = await run(undefined, fake({ fail: 'b' }));
    expect(result.status).toBe('done');
    expect(events.some((e) => e.type === 'error' && e.nodeId === 'm2')).toBe(true);
    const judgeCall = provider.calls.find((c) => c.model === 'judge')!;
    expect(judgeCall.messages[1].content).not.toContain('b: ok');
  });

  it('treats an empty answer as a failure, so the judge never gets it', async () => {
    const p = fake();
    const inner = p.adapter.stream;
    p.adapter.stream = async function* (req) {
      if (req.model === 'b') {
        yield { type: 'thinking' as const, text: 'hmm…' };
        yield { type: 'done' as const };
        return;
      }
      yield* inner(req, new AbortController().signal);
    };
    const { result, events, provider } = await run(undefined, p);
    expect(result.status).toBe('done');
    expect(events.find((e) => e.type === 'error' && e.nodeId === 'm2')?.error).toMatch(/no answer/);
    expect(provider.calls.find((c) => c.model === 'judge')!.messages[1].content).not.toContain('### Answer 2 (b)');
  });

  it('reports loading with the expected time, the moment the model is ready, and remembers the real load time', async () => {
    const recorded: { model: string; loadMs?: number }[] = [];
    const p = fake({ local: true });
    p.stats = { expectLoad: () => ({ ms: 9000, estimated: false }), record: (model, s) => recorded.push({ model, ...s }) };
    p.adapter.stream = async function* () {
      yield { type: 'loading' as const };
      yield { type: 'token' as const, text: 'ok' };
      yield { type: 'done' as const, outputTokens: 1, loadMs: 8700 };
    };
    const graph = councilGraph([ref('a')], ref('a'));
    const { events } = await run(graph, p);
    const m1 = events.filter((e) => e.nodeId === 'm1').map((e) => e.type);
    expect(m1).toEqual(['node_queued', 'node_start', 'model_loading', 'model_ready', 'token', 'node_done']);
    expect(events.find((e) => e.type === 'node_start' && e.nodeId === 'm1')?.local).toBe(true);
    expect(events.find((e) => e.type === 'model_loading')?.expectedMs).toBe(9000);
    expect(events.find((e) => e.type === 'model_ready')?.warm).toBe(false);
    expect(events.find((e) => e.type === 'node_done' && e.nodeId === 'm1')?.loadMs).toBe(8700);
    expect(recorded[0]).toMatchObject({ model: 'a', loadMs: 8700 });
  });

  it('asks a local model again without thinking when it only thought', async () => {
    const p = fake({ local: true });
    const asks: (boolean | undefined)[] = [];
    p.adapter.stream = async function* (req) {
      asks.push(req.think);
      if (req.think === false) yield { type: 'token' as const, text: 'answer' };
      else yield { type: 'thinking' as const, text: 'hmm hmm hmm' };
      yield { type: 'done' as const };
    };
    const { result, events } = await run(councilGraph([ref('a')], ref('a')), p);
    expect(asks).toEqual([undefined, false, undefined, false]);
    expect(result.final).toBe('answer');
    expect(events.some((e) => e.type === 'node_progress' && /without thinking/.test(e.note ?? ''))).toBe(true);
  });

  it('fails the run when the judge fails', async () => {
    const { result } = await run(undefined, fake({ fail: 'judge' }));
    expect(result.status).toBe('error');
    expect(result.final).toBeUndefined();
  });

  it('runs local models one at a time, cloud models in parallel', async () => {
    const local = await run(undefined, fake({ local: true, delay: 20 }));
    expect(local.provider.maxActive).toBe(1);
    expect(local.events.some((e) => e.type === 'node_queued')).toBe(true);
    const cloud = await run(undefined, fake({ delay: 20 }));
    expect(cloud.provider.maxActive).toBe(3);
    // Local with "run at the same time" switched on: no queue.
    const together = fake({ local: true, delay: 20 });
    together.exclusive = false;
    const par = await run(undefined, together);
    expect(par.provider.maxActive).toBe(3);
    expect(par.events.some((e) => e.type === 'node_queued')).toBe(false);
  });

  it('hides model names from reviewers', async () => {
    const { provider } = await run(councilGraph([ref('alpha'), ref('beta')], ref('judge'), true));
    const review = provider.calls.find((c) => c.messages[0].content.startsWith('You review'))!;
    expect(review.messages[1].content).toContain('Answer A');
    expect(review.messages[1].content).not.toContain('### alpha');
  });
});

describe('logic and data blocks', () => {
  const n = (id: string, type: CanvasNode['type'], config: CanvasNode['config'] = {}, label?: string): CanvasNode => ({ id, type, label, position: { x: 0, y: 0 }, config });
  const e = (a: string, b: string) => ({ id: `${a}->${b}`, source: a, target: b });
  async function go(graph: CanvasGraph, provider = fake(), services: NodeServices = {}) {
    const events: RunEvent[] = [];
    const result = await runGraph(graph, 'Q?', { resolve: async () => provider, emit: (x) => events.push(x as RunEvent), services }, new AbortController().signal);
    return { result, events, provider };
  }

  it('Router runs only the branch it picks and skips the rest', async () => {
    const p = fake();
    p.adapter.stream = async function* (req) {
      if (req.messages.some((m) => m.content.includes('Options:'))) yield { type: 'token' as const, text: 'Option 2' };
      else yield { type: 'token' as const, text: `${req.model} answer` };
      yield { type: 'done' as const };
    };
    const graph = {
      nodes: [n('q', 'input'), n('r', 'router', { model: ref('router') }), n('a', 'llm', { model: ref('a') }, 'Coding'), n('b', 'llm', { model: ref('b') }, 'Cooking'), n('o', 'output')],
      edges: [e('q', 'r'), e('r', 'a'), e('r', 'b'), e('a', 'o'), e('b', 'o')],
    };
    const { result, events } = await go(graph, p);
    expect(result.final).toBe('b answer');
    expect(events.find((x) => x.type === 'node_skipped')?.nodeId).toBe('a');
    expect(events.some((x) => x.type === 'node_progress' && x.note === 'Route: Cooking')).toBe(true);
  });

  it('Debate runs every model for every round and shows each final answer', async () => {
    const graph = {
      nodes: [n('q', 'input'), n('d', 'debate', { models: [ref('x'), ref('y')], rounds: 2 }), n('o', 'output')],
      edges: [e('q', 'd'), e('d', 'o')],
    };
    const { result, provider, events } = await go(graph);
    expect(provider.calls).toHaveLength(4);
    // Round 2 sees the other model's round-1 answer.
    expect(provider.calls[2].messages.at(-1)!.content).toContain('y: ok');
    expect(result.final).toContain('### x (after 2 rounds)');
    expect(events.filter((x) => x.type === 'node_progress').map((x) => x.note)).toContain('Round 2 of 2 · y');
  });

  it('Debate needs two models', () => {
    expect(() => validateGraph({ nodes: [n('q', 'input'), n('d', 'debate', { models: [ref('x')] })], edges: [e('q', 'd')] })).toThrow(/at least 2 models/);
  });

  it('Vote passes on the answer most voters pick', async () => {
    const p = fake();
    p.adapter.stream = async function* (req) {
      if (req.messages.some((m) => m.content.includes('Which is best'))) yield { type: 'token' as const, text: 'B' };
      else yield { type: 'token' as const, text: `${req.model} says hi` };
      yield { type: 'done' as const };
    };
    const graph = {
      nodes: [n('q', 'input'), n('a', 'llm', { model: ref('a') }), n('b', 'llm', { model: ref('b') }), n('v', 'vote', { models: [ref('v1'), ref('v2')] }), n('o', 'output')],
      edges: [e('q', 'a'), e('q', 'b'), e('a', 'v'), e('b', 'v'), e('v', 'o')],
    };
    const { result } = await go(graph, p);
    expect(result.final).toBe('b says hi');
  });

  it('Vote retries once when a voter names a letter that does not exist', async () => {
    const p = fake();
    let tries = 0;
    p.adapter.stream = async function* (req) {
      const last = req.messages.at(-1)!.content;
      if (last.includes('Which is best')) yield { type: 'token' as const, text: tries++ === 0 ? 'C' : 'B' };
      else yield { type: 'token' as const, text: `${req.model} says hi` };
      yield { type: 'done' as const };
    };
    const graph = {
      nodes: [n('q', 'input'), n('a', 'llm', { model: ref('a') }), n('b', 'llm', { model: ref('b') }), n('v', 'vote', { models: [ref('v1')] }), n('o', 'output')],
      edges: [e('q', 'a'), e('q', 'b'), e('a', 'v'), e('b', 'v'), e('v', 'o')],
    };
    const { result } = await go(graph, p);
    // First reply "C" is not a valid letter, so the voter is asked once more.
    expect(tries).toBe(2);
    expect(result.final).toBe('b says hi');
  });

  it('Template, File, Search and Memory feed text into a model', async () => {
    const saved: string[] = [];
    const services: NodeServices = {
      search: async (q) => [{ title: 'Octopus', url: 'https://x', text: `facts about ${q}` }],
      memory: { recall: () => [{ text: 'earlier note', at: 'yesterday' }], save: (_k, t) => saved.push(t) },
    };
    const graph = {
      nodes: [
        n('q', 'input'),
        n('f', 'file', { text: 'file content', fileName: 'notes.txt' }),
        n('s', 'search'),
        n('m', 'memory', { key: 'k' }),
        n('t', 'template', { prompt: 'Topic: {{question}}' }),
        n('l', 'llm', { model: ref('a') }),
        n('save', 'memory', { key: 'k', mode: 'save' }),
        n('o', 'output'),
      ],
      edges: [e('q', 'f'), e('q', 's'), e('q', 'm'), e('q', 't'), e('f', 'l'), e('s', 'l'), e('m', 'l'), e('t', 'l'), e('l', 'save'), e('save', 'o')],
    };
    const { result, provider } = await go(graph, fake(), services);
    const prompt = provider.calls[0].messages.at(-1)!.content;
    for (const part of ['file content', 'facts about Q?', 'earlier note', 'Topic: Q?']) expect(prompt).toContain(part);
    expect(result.final).toBe('a: ok');
    expect(saved[0]).toBe('Q: Q?\nA: a: ok');
  });
});

describe('files and images', () => {
  const n = (id: string, type: CanvasNode['type'], config: CanvasNode['config'] = {}): CanvasNode => ({ id, type, position: { x: 0, y: 0 }, config });
  const e = (a: string, b: string) => ({ id: `${a}->${b}`, source: a, target: b });

  it('Save file writes the website from an answer and shows it on the block and the run', async () => {
    const p = fake();
    p.adapter.stream = async function* () {
      yield { type: 'token' as const, text: 'Here you go:\n```html\n<!doctype html><h1>Hi</h1>\n```\nEnjoy.' };
      yield { type: 'done' as const };
    };
    const written: { path: string; data: string }[] = [];
    const services: NodeServices = { saveFile: (path, data) => (written.push({ path, data: String(data) }), { path, kind: 'html' }) };
    const events: RunEvent[] = [];
    const graph = { nodes: [n('q', 'input'), n('a', 'llm', { model: ref('a') }), n('s', 'save', { fileName: 'site' }), n('o', 'output')], edges: [e('q', 'a'), e('a', 's'), e('s', 'o')] };
    const result = await runGraph(graph, 'Make a site', { resolve: async () => p, emit: (x) => events.push(x as RunEvent), services }, new AbortController().signal);
    expect(written).toEqual([{ path: 'outputs/site.html', data: '<!doctype html><h1>Hi</h1>' }]);
    expect(events.find((x) => x.type === 'node_done' && x.nodeId === 's')?.files).toEqual([{ path: 'outputs/site.html', kind: 'html' }]);
    expect(events.find((x) => x.type === 'run_done')?.files).toHaveLength(1);
    expect(result.final).toContain('Enjoy.');
  });

  it('Image draws what the block before it wrote, frees the GPU first and saves the picture', async () => {
    const p = fake({ local: true });
    const drawn: string[] = [];
    p.adapter.image = async (req, _s, progress) => {
      drawn.push(req.prompt);
      progress('Step 1/8');
      return [{ data: Buffer.from('png'), ext: 'png' }];
    };
    const freed: string[] = [];
    const services: NodeServices = {
      saveFile: (path) => ({ path, kind: 'image' }),
      freeGpu: async (host) => void freed.push(host),
    };
    const events: RunEvent[] = [];
    const graph = { nodes: [n('q', 'input'), n('w', 'llm', { model: ref('writer') }), n('i', 'image', { model: ref('sdxl') }), n('o', 'output')], edges: [e('q', 'w'), e('w', 'i'), e('i', 'o')] };
    const result = await runGraph(graph, 'a cat', { resolve: async () => p, emit: (x) => events.push(x as RunEvent), services }, new AbortController().signal);
    expect(drawn).toEqual(['writer: ok']);
    expect(freed.length).toBeGreaterThan(0);
    expect(result.final).toMatch(/^!\[image\]\(hm-file:outputs\/image-.*\.png\)/);
    expect(events.some((x) => x.type === 'node_progress' && x.note === 'Step 1/8')).toBe(true);
  });
});
