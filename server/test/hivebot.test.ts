import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import { ProviderError } from '../src/providers/types.js';
import { edge, fakeDecider, fakeProvider, node } from './helpers.js';

/** What the HiveBot app needs: fallback, warm models, a voice per request, which model answered, managed canvases. */

const jev = { providerId: 'ts', model: 'jev-latest' };
const tiers = { small: { providerId: 'chat', model: 'gemma4:e2b' }, medium: { providerId: 'chat', model: 'omnicoder' }, large: { providerId: 'cloud', model: 'gemini-2.5-flash' } };
const autoGraph = (): CanvasGraph => ({
  nodes: [node('q', 'input'), node('a', 'llm', { auto: { decider: jev, ...tiers } }, 'Auto'), node('o', 'output')],
  edges: [edge('q', 'a'), edge('a', 'o')],
});

describe('S1 — Auto model falls back when a model fails', () => {
  it('a gone model (404) is answered by the next size down, and the run says so', async () => {
    const decider = fakeDecider(() => ({ route: { type: 'choice', choice: 'large', probabilities: { large: 0.9, medium: 0.05, small: 0.05 } } }));
    const chat = fakeProvider((r) => `${r.model} answers`);
    const gone: ResolvedProvider = {
      ...fakeProvider(),
      adapter: {
        listModels: async () => [],
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new ProviderError('HTTP 404: gemini-2.5-flash is no longer available to new users', 404);
        },
      },
    };
    const events: RunEvent[] = [];
    const problems: string[] = [];
    const result = await runGraph(
      autoGraph(),
      'Tell me something deep',
      { resolve: async (id) => (id === 'ts' ? decider : id === 'cloud' ? gone : chat) as ResolvedProvider, emit: (e) => events.push(e as RunEvent), services: { logProblem: (m) => problems.push(m) } },
      new AbortController().signal,
    );
    expect(result.status).toBe('done');
    expect(result.final).toBe('omnicoder answers');
    const note = events.find((e) => e.type === 'node_progress' && /large failed/.test(e.note ?? ''));
    expect(note?.note).toMatch(/large failed \(gemini-2\.5-flash: .*no longer available.*\) → medium: omnicoder/);
    expect(note?.decision?.route).toBe('medium: omnicoder');
    expect(problems[0]).toMatch(/answered with medium/);
  });

  it('a block with a fixed model does not fall back, and a time limit is not a reason to', async () => {
    const { canFallBack } = await import('../src/nodes/index.js');
    expect(canFallBack(new ProviderError('rate limited', 429))).toBe(true);
    expect(canFallBack(new Error('fetch failed'))).toBe(true);
    expect(canFallBack(new Error('qwen was stopped after 600 seconds'))).toBe(false);
    expect(canFallBack(new ProviderError("You can't use x", 403))).toBe(false);
    const broken: ResolvedProvider = { ...fakeProvider(), adapter: { listModels: async () => [], async *stream() { throw new ProviderError('gone', 404); } } };
    const graph = { nodes: [node('q', 'input'), node('l', 'llm', { model: tiers.large }), node('o', 'output')], edges: [edge('q', 'l'), edge('l', 'o')] };
    const r = await runGraph(graph, 'x', { resolve: async () => broken, emit: () => {} }, new AbortController().signal);
    expect(r.status).toBe('error');
  });
});

describe('S4 — which model answered', () => {
  it('takes the last route (after a fallback) and how long the decider took', async () => {
    const { routeInfo } = await import('../src/api/v1.js');
    const ev = (decision: object) => ({ type: 'node_progress', runId: 'r', seq: 0, ts: 0, nodeId: 'a', decision }) as RunEvent;
    expect(routeInfo([ev({ model: 'clef', ms: 412, answers: [], route: 'large: gemini' }), ev({ model: '', ms: 0, answers: [], route: 'medium: omnicoder' })])).toEqual({ route: 'medium: omnicoder', decider_ms: 412 });
    expect(routeInfo([])).toBeUndefined();
  });
});
