import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../src/engine/graph.js';
import { runGraph, type ResolvedProvider, type WinnerRecord } from '../src/engine/run.js';
import { edge, fakeDecider, fakeProvider, node } from './helpers.js';

const jev = { providerId: 'ts', model: 'jev-latest' };
// Jev likes the answer that says "four".
const scorer = () => fakeDecider((req) => ({ quality: { type: 'score', score: req.state.includes('four') ? 2.8 : 0.9, probabilities: { 0: 0.1, 3: 0.9 } } }));

function graph(kind: 'judge' | 'vote', config: Record<string, unknown>): CanvasGraph {
  return {
    nodes: [
      node('q', 'input'),
      node('a', 'template', { prompt: 'It is five' }, 'Alpha'),
      node('b', 'template', { prompt: 'It is four' }, 'Beta'),
      node('j', kind, config),
      node('o', 'output'),
    ],
    edges: [edge('q', 'a'), edge('q', 'b'), edge('a', 'j'), edge('b', 'j'), edge('j', 'o')],
  };
}

async function go(g: CanvasGraph, chat = fakeProvider()) {
  const decider = scorer();
  const events: RunEvent[] = [];
  const winners: WinnerRecord[] = [];
  const result = await runGraph(
    g,
    'What is 2+2?',
    { resolve: async (id) => (id === 'ts' ? decider : chat) as ResolvedProvider, emit: (e) => events.push(e as RunEvent), record: { usage: () => {}, winner: (w) => winners.push(w) } },
    new AbortController().signal,
  );
  return { result, events, winners, decider, chat };
}

describe('Jev scoring in Judge and Vote', () => {
  it('Vote with only Jev: the best score wins, no model call', async () => {
    const g = graph('vote', { jevScore: jev });
    expect(() => validateGraph(g)).not.toThrow();
    const r = await go(g);
    expect(r.result.final).toBe('It is four');
    expect(r.chat.calls).toHaveLength(0);
    expect(r.winners[0].winnerNodeId).toBe('b');
    expect(r.decider.calls).toHaveLength(2);
    expect(r.decider.calls[0].questions.quality).toMatchObject({ type: 'score', instructions: 'How well does the Answer answer the Question?' });
    const bars = r.events.find((e) => e.decision)!.decision!;
    expect(bars.answers.map((a) => a.name)).toEqual(['Beta', 'Alpha']);
  });

  it('Vote with voters: Jev breaks a tie', async () => {
    let n = 0;
    const r = await go(graph('vote', { jevScore: jev, models: [{ providerId: 'chat', model: 'v1' }, { providerId: 'chat', model: 'v2' }] }), fakeProvider(() => (n++ % 2 ? 'B' : 'A')));
    expect(r.result.final).toBe('It is four');
  });

  it('Judge reads the answers best first, with their Jev scores', async () => {
    const r = await go(graph('judge', { model: { providerId: 'chat', model: 'judge' }, jevScore: jev }));
    const prompt = r.chat.calls[0].messages.at(-1)!.content;
    expect(prompt.indexOf('Answer 1 (Beta, Jev score 2.80/3)')).toBeGreaterThan(-1);
    expect(prompt.indexOf('Beta')).toBeLessThan(prompt.indexOf('Alpha'));
  });
});
