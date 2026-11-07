import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import type { NodeServices } from '../src/nodes/index.js';
import { pickRandom, type Site } from '../src/nodes/research.js';
import { ProviderError } from '../src/providers/types.js';
import { TEMPLATES } from '../../web/src/canvas/templates.js';
import { chain, fakeDecider, fakeProvider, node } from './helpers.js';

/** Deep search (rounds that decide what to do next) and the Review panel (random reviewers). */

/** A fake web: each query has its own list of sites; pages read as "page of <url>". */
function fakeWeb(results: Record<string, string[]>) {
  const searched: { q: string; count: number }[] = [];
  const read: string[] = [];
  const services: NodeServices = {
    search: async (q, opts) => {
      searched.push({ q, count: opts.count ?? 5 });
      return (results[q] ?? []).slice(0, opts.count ?? 5).map((url) => ({ title: `Title ${url}`, url, text: `snippet ${url}` }));
    },
    readPage: async (url) => {
      read.push(url);
      return `page of ${url}`;
    },
  };
  return { services, searched, read };
}

const sites = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `https://${prefix}.test/${i + 1}`);

async function run(graph: CanvasGraph, providers: Record<string, ResolvedProvider>, services: NodeServices, question = 'Which colours does the Air Max 90 come in?') {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, question, { resolve: async (id) => providers[id], emit: (e) => events.push(e as RunEvent), services }, new AbortController().signal);
  return { result, events, notes: events.filter((e) => e.type === 'node_progress').map((e) => e.note ?? '') };
}

describe('Deep search', () => {
  const llm = { providerId: 'chat', model: 'fast' };
  const jev = { providerId: 'ts', model: 'jev' };

  it('reads a round, and on "search with other words" lets its model write a new query, then stops on "enough"', async () => {
    const web = fakeWeb({ 'Which colours does the Air Max 90 come in?': sites('shop', 8), 'air max 90 colorways list': sites('blog', 8) });
    let round = 0;
    const decider = fakeDecider(() => ({ next: { type: 'choice', choice: ++round === 1 ? 'new_query' : 'enough', probabilities: {} } }));
    const chat = fakeProvider(() => 'air max 90 colorways list');
    const g = chain(node('q', 'input'), node('d', 'deepSearch', { model: llm, decider: jev, pageBatch: 3, maxPages: 15 }), node('o', 'output'));
    const { result, notes } = await run(g, { chat, ts: decider }, web.services);
    const out = JSON.parse(result.final!) as { queries: string[]; items: Site[] };
    expect(out.queries).toEqual(['Which colours does the Air Max 90 come in?', 'air max 90 colorways list']);
    expect(out.items.map((s) => s.url)).toEqual([...sites('shop', 3), ...sites('blog', 3)]);
    expect(out.items[0].text).toBe('page of https://shop.test/1');
    expect(notes).toContain('Next: new query');
    expect(notes).toContain('Next: enough');
  });

  it('"more sites" goes on with the same search and never reads a site twice', async () => {
    const web = fakeWeb({ shoes: sites('shop', 20) });
    let round = 0;
    const decider = fakeDecider(() => ({ next: { type: 'choice', choice: ++round < 3 ? (round === 1 ? 'more_sites' : 'many_more_sites') : 'enough', probabilities: {} } }));
    const g = chain(node('q', 'input'), node('d', 'deepSearch', { model: llm, decider: jev, pageBatch: 2, maxPages: 12 }), node('o', 'output'));
    const { result } = await run(g, { chat: fakeProvider(), ts: decider }, web.services, 'shoes');
    const urls = (JSON.parse(result.final!) as { items: Site[] }).items.map((s) => s.url);
    // 2, then 2 more, then 6 more (three times the batch) = 10, all different.
    expect(urls).toHaveLength(10);
    expect(new Set(urls).size).toBe(10);
    expect(web.searched.every((s) => s.q === 'shoes')).toBe(true);
  });

  it('without a decision model its own model decides (JSON)', async () => {
    const web = fakeWeb({ shoes: sites('shop', 5) });
    const chat = fakeProvider(() => '{"next": "enough"}');
    const g = chain(node('q', 'input'), node('d', 'deepSearch', { model: llm, pageBatch: 2 }), node('o', 'output'));
    const { result } = await run(g, { chat }, web.services, 'shoes');
    expect((JSON.parse(result.final!) as { items: Site[] }).items).toHaveLength(2);
    expect(chat.calls[0].messages[0].content).toMatch(/steer a web research/);
  });

  it('looks up a list: each lead gets its share of the sites', async () => {
    const web = fakeWeb({ 'is it blue': sites('a', 5), 'is it red': sites('b', 5) });
    const g = chain(node('q', 'input'), node('t', 'template', { prompt: 'is it blue\nis it red' }), node('d', 'deepSearch', { model: llm, decider: jev, searchList: true, pageBatch: 2, maxPages: 4, maxRounds: 1 }), node('o', 'output'));
    const { result } = await run(g, { chat: fakeProvider(), ts: fakeDecider(() => ({})) }, web.services);
    const out = JSON.parse(result.final!) as { queries: string[]; items: Site[] };
    expect(out.queries).toEqual(['is it blue', 'is it red']);
    expect(out.items.map((s) => s.url)).toEqual([...sites('a', 2), ...sites('b', 2)]);
  });
});

describe('Review panel', () => {
  const pool = ['a', 'b', 'c', 'd'].map((m) => ({ providerId: 'chat', model: m }));

  it('picks different models at random', () => {
    const picks = Array.from({ length: 40 }, () => pickRandom(pool, 2).map((m) => m.model).join(''));
    expect(picks.every((p) => p.length === 2 && p[0] !== p[1])).toBe(true);
    expect(new Set(picks).size).toBeGreaterThan(3);
  });

  it('two reviewers answer; one that fails is replaced from the pool', async () => {
    const chat: ResolvedProvider = {
      ...fakeProvider(),
      adapter: {
        listModels: async () => [],
        async *stream(req) {
          if (req.model === 'a') throw new ProviderError('rate limited', 429);
          yield { type: 'token' as const, text: `${req.model} says fine` };
          yield { type: 'done' as const };
        },
      },
    };
    const g = chain(node('q', 'input'), node('p', 'panel', { models: pool, count: 2 }), node('o', 'output'));
    for (let i = 0; i < 5; i++) {
      const { result } = await run(g, { chat }, {});
      const reviewers = [...result.final!.matchAll(/### Reviewer: (\w)/g)].map((m) => m[1]);
      expect(reviewers).toHaveLength(2);
      expect(new Set(reviewers).size).toBe(2);
      expect(reviewers).not.toContain('a');
    }
  });
});

describe('Deep research workflow', () => {
  it('reviews every site with 2 AIs, keeps it in memory, follows up, and answers', async () => {
    const fast = { providerId: 'chat', model: 'fast' };
    const strong = { providerId: 'chat', model: 'strong' };
    const t = TEMPLATES.find((x) => x.id === 'deep-research')!;
    const graph = t.build({ text: [fast, { providerId: 'chat', model: 'other' }], judge: strong, decision: { providerId: 'ts', model: 'jev' } });
    const question = 'Is the Air Max 90 Infrared blue or red?';
    const web = fakeWeb({ [question]: sites('shop', 6), 'infrared colour official nike': sites('nike', 4) });
    const memory: string[] = [];
    const services: NodeServices = {
      ...web.services,
      memory: {
        recall: () => [],
        save: (_key, text) => void memory.push(text),
        search: (_key, _q, limit) => memory.slice(0, limit).map((text) => ({ text, score: 1, at: 'now' })),
      },
    };
    const chat = fakeProvider((req) => {
      const sys = req.messages[0].content;
      if (/follow-up web searches/.test(sys)) return 'infrared colour official nike';
      if (/final answer of a web research/.test(sys)) return 'It is red (Infrared), see sources.';
      return `Source: noted by ${req.model}`;
    });
    const decider = fakeDecider(() => ({ next: { type: 'choice', choice: 'enough', probabilities: {} } }));
    const { result, events } = await run(graph, { chat, ts: decider }, services, question);
    expect(result.status, JSON.stringify(events.filter((e) => e.type === 'error'))).toBe('done');
    expect(result.final).toBe('It is red (Infrared), see sources.');
    // 5 sites in the first round + 3 follow-ups, each reviewed by 2 AIs and kept in memory.
    expect(memory).toHaveLength(8);
    expect(memory.every((m) => (m.match(/### Reviewer:/g) ?? []).length === 2)).toBe(true);
    expect(web.searched.map((s) => s.q)).toContain('infrared colour official nike');
  });
});
