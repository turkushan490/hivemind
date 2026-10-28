import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { runGraph, type ResolvedProvider, type UsageRecord } from '../src/engine/run.js';
import { edge, fakeDecider, node } from './helpers.js';

const jev = { providerId: 'ts', model: 'jev-latest' };
const spamGraph = (questions: any[], targets: string[], threshold?: number): CanvasGraph => ({
  nodes: [
    node('q', 'input'),
    node('d', 'decide', { model: jev, questions, ...(threshold !== undefined && { threshold }) }),
    ...targets.map((t, i) => node(`t${i}`, 'template', { prompt: `ran ${t}` }, t)),
  ],
  edges: [edge('q', 'd'), ...targets.map((_, i) => edge('d', `t${i}`))],
});

async function run(graph: CanvasGraph, provider: ResolvedProvider, question = 'BUY CRYPTO NOW at my profile') {
  const events: RunEvent[] = [];
  const usage: UsageRecord[] = [];
  const result = await runGraph(
    graph,
    question,
    { resolve: async () => provider, emit: (e) => events.push(e as RunEvent), record: { usage: (u) => usage.push(u), winner: () => {} } },
    new AbortController().signal,
  );
  const ran = (label: string) => events.some((e) => e.type === 'node_done' && e.label === label);
  const skipped = (label: string) => events.some((e) => e.type === 'node_skipped' && graph.nodes.find((n) => n.id === e.nodeId)?.label === label);
  return { result, events, usage, ran, skipped };
}

const NOUL = [{ name: 'spam', type: 'noul', instructions: 'Is this spam?' }];
const CHOICE = [{ name: 'wants', type: 'choice', instructions: 'What do they want?', options: [{ name: 'ask', description: 'Ask a question' }, { name: 'promote', description: 'Sell something' }], safe: 'ask' }];

describe('Decide block', () => {
  it('a noul at or above the threshold takes the yes branch; no is skipped', async () => {
    const p = fakeDecider(() => ({ spam: { type: 'noul', p: 0.96 } }));
    const r = await run(spamGraph(NOUL, ['yes', 'no', 'log']), p);
    expect(r.ran('yes')).toBe(true);
    expect(r.skipped('no')).toBe(true);
    expect(r.ran('log')).toBe(true); // not a branch name: always runs
    expect(p.calls[0].state).toBe('BUY CRYPTO NOW at my profile');
    expect(p.calls[0].questions.spam).toEqual({ type: 'noul', instructions: 'Is this spam?' });
    const out = JSON.parse(r.events.find((e) => e.type === 'node_done' && e.nodeId === 'd')!.text!);
    expect(out.answers.spam).toMatchObject({ type: 'noul', p: 0.96, decision: 'yes' });
    expect(out.summary).toBe('spam 96%');
  });

  it('a noul under the threshold is no', async () => {
    const r = await run(spamGraph(NOUL, ['yes', 'no'], 0.6), fakeDecider(() => ({ spam: { type: 'noul', p: 0.55 } })));
    expect(r.ran('no')).toBe(true);
    expect(r.skipped('yes')).toBe(true);
  });

  it('a sure choice takes its option branch', async () => {
    const r = await run(spamGraph(CHOICE, ['ask', 'promote', 'fallback']), fakeDecider(() => ({ wants: { type: 'choice', choice: 'promote', probabilities: { promote: 0.9, ask: 0.1 } } })));
    expect(r.ran('promote')).toBe(true);
    expect(r.skipped('ask')).toBe(true);
    expect(r.skipped('fallback')).toBe(true);
  });

  it('an unsure choice follows the fallback branch, or else the safe option', async () => {
    const unsure = () => fakeDecider(() => ({ wants: { type: 'choice', choice: 'promote', probabilities: { promote: 0.52, ask: 0.48 } } }));
    const withFallback = await run(spamGraph(CHOICE, ['ask', 'promote', 'fallback']), unsure());
    expect(withFallback.ran('fallback')).toBe(true);
    expect(withFallback.skipped('promote')).toBe(true);
    const safe = await run(spamGraph(CHOICE, ['ask', 'promote']), unsure());
    expect(safe.ran('ask')).toBe(true);
    expect(safe.skipped('promote')).toBe(true);
  });

  it('"question: value" labels branch on another question', async () => {
    const qs = [...NOUL, ...CHOICE];
    const r = await run(
      spamGraph(qs, ['spam: no', 'wants: promote']),
      fakeDecider(() => ({ spam: { type: 'noul', p: 0.1 }, wants: { type: 'choice', choice: 'promote', probabilities: { promote: 0.95, ask: 0.05 } } })),
    );
    expect(r.ran('spam: no')).toBe(true);
    expect(r.ran('wants: promote')).toBe(true);
  });

  it('emits the decision for the bars and records cost in usage', async () => {
    const r = await run(spamGraph(NOUL, ['yes']), fakeDecider(() => ({ spam: { type: 'noul', p: 0.96 } })));
    const ev = r.events.find((e) => e.type === 'node_progress' && e.decision)!;
    expect(ev.decision).toMatchObject({ model: 'jev-1.14.0', ms: 120, threshold: 0.6, route: 'yes', answers: [{ name: 'spam', type: 'noul', p: 0.96 }] });
    expect(r.usage).toEqual([expect.objectContaining({ nodeType: 'decide', model: 'jev-latest', inputTokens: 1000, cost: (1000 * 0.042) / 1e6 })]);
    expect(r.result.cost).toBeCloseTo((1000 * 0.042) / 1e6);
  });

  it('a chat model as decision model fails with a clear message', async () => {
    const chat: ResolvedProvider = { ...fakeDecider(() => ({})), adapter: { listModels: async () => [], stream: fakeDecider(() => ({})).adapter.stream } };
    const r = await run(spamGraph(NOUL, ['yes']), chat);
    expect(r.events.find((e) => e.type === 'error')?.error).toMatch(/not a decision model/);
  });

  it('box questions send the picture the block before made', async () => {
    const p = fakeDecider(() => ({ mug: { type: 'box', box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.5 } } }));
    const graph: CanvasGraph = {
      nodes: [node('q', 'input'), node('t', 'template', { prompt: 'A kitchen ![image](hm-file:outputs/kitchen.png)' }), node('d', 'decide', { model: jev, questions: [{ name: 'mug', type: 'box', instructions: 'the coffee mug' }] })],
      edges: [edge('q', 't'), edge('t', 'd')],
    };
    const events: RunEvent[] = [];
    await runGraph(graph, 'x', { resolve: async () => p, emit: (e) => events.push(e as RunEvent), services: { readFile: (path) => Buffer.from(`png:${path}`) } }, new AbortController().signal);
    expect(p.calls[0].images?.[0].data.toString()).toBe('png:outputs/kitchen.png');
    expect(p.calls[0].state).toBe('A kitchen');
    expect(events.find((e) => e.decision)?.decision?.image).toBe('outputs/kitchen.png');
  });
});
