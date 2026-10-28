import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../src/engine/graph.js';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import { edge, fakeDecider, fakeProvider, node } from './helpers.js';

const jev = { providerId: 'ts', model: 'jev-latest' };
const tiers = { small: { providerId: 'chat', model: 'qwen3:4b' }, medium: { providerId: 'chat', model: 'gemini-flash' }, large: { providerId: 'chat', model: 'claude-big' } };

async function go(graph: CanvasGraph, probs: Record<string, number>, question = 'What is 2+2?') {
  const decider = fakeDecider(() => {
    const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    return { route: { type: 'choice', choice, probabilities: probs } };
  });
  const chat = fakeProvider();
  const events: RunEvent[] = [];
  const result = await runGraph(graph, question, { resolve: async (id) => (id === 'ts' ? decider : chat) as ResolvedProvider, emit: (e) => events.push(e as RunEvent) }, new AbortController().signal);
  return { result, events, decider, chat };
}

const autoGraph = (extra = {}): CanvasGraph => ({
  nodes: [node('q', 'input'), node('a', 'llm', { auto: { decider: jev, ...tiers }, ...extra }, 'Auto'), node('o', 'output')],
  edges: [edge('q', 'a'), edge('a', 'o')],
});

describe('Auto model (Jev router)', () => {
  it('validates without a fixed model, but needs a size', () => {
    expect(() => validateGraph(autoGraph())).not.toThrow();
    const bad = autoGraph();
    bad.nodes[1].config.auto = { decider: jev };
    expect(() => validateGraph(bad)).toThrow(/at least one size/);
  });

  it('asks the size question with the guide’s descriptions and calls the picked model', async () => {
    const r = await go(autoGraph(), { small: 0.97, medium: 0.02, large: 0.01 });
    const q = r.decider.calls[0].questions.route as { type: string; criteria: Record<string, string> };
    expect(q.type).toBe('choice');
    expect(q.criteria.small).toMatch(/^Trivial: arithmetic/);
    expect(Object.keys(q.criteria)).toEqual(['small', 'medium', 'large']);
    expect(r.decider.calls[0].state).toBe('What is 2+2?');
    expect(r.chat.calls.map((c) => c.model)).toEqual(['qwen3:4b']);
    expect(r.result.final).toBe('qwen3:4b: ok');
    const ev = r.events.find((e) => e.decision);
    expect(ev?.decision?.route).toBe('small: qwen3:4b');
    expect(ev?.note).toBe('→ small: qwen3:4b');
  });

  it('moves up one size when the top pick is under the threshold', async () => {
    const r = await go(autoGraph(), { small: 0.15, medium: 0.55, large: 0.3 });
    expect(r.chat.calls[0].model).toBe('claude-big');
    expect(r.events.find((e) => e.decision)?.note).toMatch(/Only 55% sure — one size up → large/);
  });

  it('stays on large when large is unsure, and a custom threshold is used', async () => {
    expect((await go(autoGraph(), { small: 0.1, medium: 0.4, large: 0.5 })).chat.calls[0].model).toBe('claude-big');
    expect((await go(autoGraph({ threshold: 0.5 }), { small: 0.1, medium: 0.55, large: 0.35 })).chat.calls[0].model).toBe('gemini-flash');
  });

  it('skips sizes that are not filled in', async () => {
    const g = autoGraph();
    g.nodes[1].config.auto = { decider: jev, small: tiers.small, large: tiers.large };
    const r = await go(g, { small: 0.4, large: 0.6 });
    expect(Object.keys((r.decider.calls[0].questions.route as any).criteria)).toEqual(['small', 'large']);
    expect(r.chat.calls[0].model).toBe('claude-big');
  });
});

describe('Router: decide with Jev', () => {
  const routerGraph: CanvasGraph = {
    nodes: [
      node('q', 'input'),
      node('r', 'router', { decideWith: 'jev', decider: jev }, 'Route'),
      node('c', 'template', { prompt: 'coding' }, 'Coding'),
      node('k', 'template', { prompt: 'cooking' }, 'Cooking'),
    ],
    edges: [edge('q', 'r'), edge('r', 'c'), edge('r', 'k')],
  };

  it('picks the branch with one choice question over the block names, no LLM call', async () => {
    const r = await go(routerGraph, { Coding: 0.1, Cooking: 0.9 }, 'How long do I boil an egg?');
    expect((r.decider.calls[0].questions.route as any).criteria).toEqual({ Coding: 'Coding', Cooking: 'Cooking' });
    expect(r.chat.calls).toHaveLength(0);
    expect(r.events.some((e) => e.type === 'node_skipped' && e.nodeId === 'c')).toBe(true);
    expect(r.events.some((e) => e.type === 'node_done' && e.nodeId === 'k')).toBe(true);
    expect(r.events.find((e) => e.decision)?.decision?.route).toBe('Cooking');
  });

  it('validates without the LLM model', () => {
    expect(() => validateGraph(routerGraph)).not.toThrow();
  });
});
