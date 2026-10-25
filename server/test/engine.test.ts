import { councilGraph, type RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../src/engine/graph.js';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import type { ChatRequest } from '../src/providers/types.js';

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
  });

  it('hides model names from reviewers', async () => {
    const { provider } = await run(councilGraph([ref('alpha'), ref('beta')], ref('judge'), true));
    const review = provider.calls.find((c) => c.messages[0].content.startsWith('You review'))!;
    expect(review.messages[1].content).toContain('Answer A');
    expect(review.messages[1].content).not.toContain('### alpha');
  });
});
