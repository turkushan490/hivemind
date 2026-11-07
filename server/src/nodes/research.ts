import type { ModelRef } from '@hivemind/shared';
import type { NodeContext, NodeDefinition } from './index.js';
import { answers, fill, labelled, parseJson, researchList } from './index.js';

/**
 * Research blocks. Deep search looks a question up on the web in rounds: it reads a few sites, then decides (with a
 * decision model when there is one, else its own model) whether that is enough, whether to read more sites of the
 * same search, or to search with better words. Review panel lets several different models, picked at random from a
 * pool, each give their view of the same text.
 */

export interface Site {
  url: string;
  title: string;
  query: string;
  text: string;
}

const err = (message: string) => new Error(message);
const SITE_CHARS = 5000;

const NEXT_STEPS = {
  enough: 'The sites read so far answer the question well enough; stop searching',
  more_sites: 'The search words are right, but read a few more sites of the same search',
  many_more_sites: 'The search words are right, but the answer is spread out: read many more sites of the same search',
  new_query: 'These sites miss the point: search again with different words',
} as const;
type NextStep = keyof typeof NEXT_STEPS;

/** What has been read so far, short: for the decision and for a new search. */
const digest = (question: string, sites: Site[]) =>
  `Question: ${question}\n\nSites read so far (${sites.length}):\n${sites.map((s, i) => `${i + 1}. ${s.title} (${s.url}) [search: ${s.query}]\n${s.text.slice(0, 400)}`).join('\n\n')}`.slice(0, 40_000);

/** What to do next, by the decision model (one choice question) or the block's own model (JSON). */
async function nextStep(ctx: NodeContext, question: string, sites: Site[]): Promise<NextStep> {
  const decider = ctx.node.config.decider;
  if (decider) {
    const r = await ctx.decide({ state: digest(question, sites), questions: { next: { type: 'choice', instructions: 'What should the research do next?', criteria: NEXT_STEPS } } }, decider);
    const a = r.answers.next;
    if (a?.type === 'choice' && a.choice in NEXT_STEPS) return a.choice as NextStep;
    return 'enough';
  }
  const reply = await ctx.callModel([
    { role: 'system', content: `You steer a web research. Choose the next step: ${Object.entries(NEXT_STEPS).map(([k, v]) => `"${k}": ${v}`).join('; ')}. Reply with only JSON {"next": "<step>"}.` },
    { role: 'user', content: digest(question, sites) },
  ]);
  try {
    const j = parseJson(reply) as { next?: string };
    if (j.next && j.next in NEXT_STEPS) return j.next as NextStep;
  } catch {}
  const word = (Object.keys(NEXT_STEPS) as NextStep[]).find((k) => reply.includes(k));
  return word ?? 'enough';
}

/** Better search words, from what was found (and what was missing). */
async function betterQuery(ctx: NodeContext, question: string, sites: Site[], tried: string[]): Promise<string | undefined> {
  const reply = await ctx.callModel([
    {
      role: 'system',
      content:
        'You write web search queries. The searches tried so far did not find what the question needs. Write one new, different query (other words, a more specific name, a synonym, a site or language that would have it). Reply with only the query.',
    },
    { role: 'user', content: `${digest(question, sites)}\n\nSearches tried: ${tried.map((t) => `"${t}"`).join(', ')}` },
  ]);
  const q = reply.split('\n').map((l) => l.replace(/^["'\s-]+|["'\s]+$/g, '')).find(Boolean)?.slice(0, 300);
  return q && !tried.some((t) => t.toLowerCase() === q.toLowerCase()) ? q : undefined;
}

const DEEP_SEARCH: NodeDefinition = {
  usesModel: true,
  async execute(ctx) {
    const { search, readPage } = ctx.services;
    if (!search || !readPage) throw err('Web search is not available here');
    const c = ctx.node.config;
    const prev = answers(ctx.inputs);
    const input = prev.length ? prev[prev.length - 1].text : ctx.question;
    // A list of things to look up (leads from an analysis), or one search: the question or what is wired in.
    const starts = (c.searchList ? researchList(input) : [input.trim().slice(0, 300)]).filter(Boolean).slice(0, 5);
    if (!starts.length) {
      ctx.progress('Nothing to look up');
      return JSON.stringify({ question: ctx.question, queries: [], items: [] });
    }
    const batchSize = Math.max(1, Math.min(10, c.pageBatch ?? 5));
    const maxPages = Math.max(1, Math.min(40, c.maxPages ?? 15));
    const maxRounds = Math.max(1, Math.min(8, c.maxRounds ?? 4));
    const perStart = Math.max(batchSize, Math.floor(maxPages / starts.length));
    const sites: Site[] = [];
    const seen = new Set<string>();
    const tried: string[] = [];
    for (const start of starts) {
      let query = start;
      let want = batchSize;
      let budget = perStart;
      tried.push(query);
      for (let round = 1; round <= maxRounds && budget > 0 && sites.length < maxPages; round++) {
        if (ctx.signal?.aborted) throw err('Cancelled');
        const take = Math.min(want, budget, maxPages - sites.length);
        ctx.progress(`Round ${round}: searching "${query.slice(0, 60)}"`);
        // Enough results to skip the sites already read (DuckDuckGo goes several pages deep).
        const found = await search(query, { source: c.source, count: Math.min(40, seen.size + take + 5) }).catch(() => []);
        const fresh = found.filter((r) => !seen.has(r.url)).slice(0, take);
        for (const r of fresh) seen.add(r.url);
        const read = await Promise.all(
          fresh.map(async (r) => {
            const text = await readPage(r.url, SITE_CHARS).catch(() => '');
            // A page that can't be read still counts with its search snippet.
            return { url: r.url, title: r.title, query, text: text || r.text } satisfies Site;
          }),
        );
        sites.push(...read.filter((s) => s.text.trim()));
        budget -= fresh.length;
        ctx.progress(`Round ${round}: read ${read.length} site${read.length === 1 ? '' : 's'} (${sites.length} in all)`);
        if (budget <= 0 || sites.length >= maxPages || round === maxRounds) break;
        const step = fresh.length ? await nextStep(ctx, ctx.question, sites) : 'new_query';
        ctx.progress(`Next: ${step.replace(/_/g, ' ')}`);
        if (step === 'enough') break;
        if (step === 'more_sites') want = batchSize;
        if (step === 'many_more_sites') want = batchSize * 3;
        if (step === 'new_query') {
          const q = await betterQuery(ctx, ctx.question, sites, tried);
          if (!q) break;
          query = q;
          tried.push(q);
          want = batchSize;
        }
      }
    }
    ctx.progress(`${sites.length} site${sites.length === 1 ? '' : 's'} read with ${tried.length} search${tried.length === 1 ? '' : 'es'}`);
    return JSON.stringify({ question: ctx.question, queries: tried, items: sites });
  },
};

// ---- Review panel ----

/** count different models from the pool, in a random order (Fisher-Yates). */
export function pickRandom<T>(pool: T[], count: number, random = Math.random): T[] {
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(1, count));
}

const short = (m: ModelRef) => m.model.split('/').pop()!.replace(/:latest$/, '');

const PANEL: NodeDefinition = {
  usesModel: false,
  minModels: 2,
  async execute(ctx) {
    const c = ctx.node.config;
    const pool = (c.models ?? []).filter((m) => m?.providerId && m.model && (!ctx.allowedModel || ctx.allowedModel(m)));
    if (pool.length < 2) throw err('Review panel needs at least 2 models in its pool that you may use');
    const count = Math.max(1, Math.min(pool.length, c.count ?? 2));
    const order = pickRandom(pool, pool.length);
    const chosen = order.slice(0, count);
    const spare = order.slice(count);
    const material = labelled(answers(ctx.inputs)) || ctx.question;
    const system = c.system ? fill(c.system, ctx, material) : 'You review material for a research question: what does it say that matters, how reliable is it, and what is missing or contradicts other sources?';
    const user = c.prompt ? fill(c.prompt, ctx, material) : `Question: ${ctx.question}\n\n${material}`;
    ctx.progress(`Reviewers: ${chosen.map(short).join(', ')}`);
    // Each reviewer works on its own; one that fails is replaced by a model from the rest of the pool.
    const results = await Promise.all(
      chosen.map(async (first) => {
        let m: ModelRef | undefined = first;
        while (m) {
          try {
            const text = await ctx.callModel(
              [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              m,
            );
            return { model: m, text };
          } catch (e) {
            const next = spare.shift();
            ctx.progress(`${short(m)} failed (${(e as Error).message.slice(0, 80)})${next ? ` → ${short(next)}` : ''}`);
            m = next;
          }
        }
        return undefined;
      }),
    );
    const done = results.filter((r): r is { model: ModelRef; text: string } => !!r && !!r.text.trim());
    if (!done.length) throw err('Every reviewer failed');
    return done.map((r) => `### Reviewer: ${short(r.model)}\n${r.text.trim()}`).join('\n\n');
  },
};

export const RESEARCH_NODES: Record<'deepSearch' | 'panel', NodeDefinition> = {
  deepSearch: DEEP_SEARCH,
  panel: PANEL,
};
