import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { councilGraph, type CanvasGraph, type CanvasNode } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { runGraph, type ResolvedProvider, type UsageRecord, type WinnerRecord } from '../src/engine/run.js';
import { splitBest } from '../src/nodes/index.js';
import { LiveText } from '../src/services/openaiCompat.js';
import { callCost, knownPrice } from '../src/services/pricing.js';
import type { ChatRequest } from '../src/providers/types.js';

/** Answers "<model>: ok"; the judge adds a BEST line; no prices from the provider (like OpenAI). */
function provider(judgeReply = 'Merged answer\n\nBEST: 2'): ResolvedProvider {
  return {
    local: false,
    hostKey: 'h',
    modelInfo: async () => undefined,
    adapter: {
      listModels: async () => [],
      async *stream(req: ChatRequest) {
        const text = req.model === 'judge' ? judgeReply : `${req.model}: ok`;
        for (const piece of text.match(/[\s\S]{1,4}/g)!) yield { type: 'token' as const, text: piece };
        yield { type: 'done' as const, inputTokens: 1000, outputTokens: 500, genMs: 2000 };
      },
    },
  };
}

async function run(graph: CanvasGraph, p = provider()) {
  const usage: UsageRecord[] = [];
  const winners: WinnerRecord[] = [];
  const result = await runGraph(graph, 'Q?', { resolve: async () => p, emit: () => {}, record: { usage: (u) => usage.push(u), winner: (w) => winners.push(w) } }, new AbortController().signal);
  return { result, usage, winners };
}

const ref = (model: string) => ({ providerId: 'openai', model });

describe('pricing', () => {
  it('matches the longest known model name', () => {
    expect(knownPrice('gpt-4o-mini-2024-07-18')).toEqual({ input: 0.15, output: 0.6 });
    expect(knownPrice('gpt-4o')).toEqual({ input: 2.5, output: 10 });
    expect(knownPrice('openai/gpt-4.1-mini')).toEqual({ input: 0.4, output: 1.6 });
    expect(knownPrice('claude-opus-4-5-20251101')).toEqual({ input: 5, output: 25 });
    expect(knownPrice('claude-opus-4-20250514')).toEqual({ input: 15, output: 75 });
    expect(knownPrice('llama3.2:3b')).toBeUndefined();
  });

  it('counts free models as 0 and prefers provider prices', () => {
    expect(callCost({ free: true }, 'gpt-4o', 1e6, 1e6)).toBe(0);
    expect(callCost({ price: { input: 1, output: 1 } }, 'gpt-4o', 1e6, 1e6)).toBe(2);
    expect(callCost(undefined, 'gpt-4o', 1e6, 1e6)).toBe(12.5);
    expect(callCost(undefined, 'mystery-model', 1e6, 1e6)).toBeUndefined();
  });
});

describe('usage and winners', () => {
  it('records every model call with tokens, cost and speed, and the judge pick', async () => {
    const { result, usage, winners } = await run(councilGraph([ref('gpt-4o'), ref('gpt-4o-mini')], ref('judge')));
    expect(result.final).toBe('Merged answer');
    expect(usage).toHaveLength(3);
    const mini = usage.find((u) => u.model === 'gpt-4o-mini')!;
    expect(mini).toMatchObject({ nodeId: 'm2', nodeType: 'llm', providerId: 'openai', inputTokens: 1000, outputTokens: 500, genMs: 2000 });
    expect(mini.cost).toBeCloseTo((1000 * 0.15 + 500 * 0.6) / 1e6);
    expect(usage.find((u) => u.model === 'judge')!.cost).toBeUndefined();
    expect(result.cost).toBeCloseTo((1000 * 2.5 + 500 * 10 + 1000 * 0.15 + 500 * 0.6) / 1e6);
    expect(winners).toEqual([{ nodeId: 'j', nodeType: 'judge', winnerNodeId: 'm2', winnerLabel: 'gpt-4o-mini', winnerModel: 'gpt-4o-mini', contenders: ['gpt-4o', 'gpt-4o-mini'] }]);
  });

  it('records no winner when the judge names none', async () => {
    const { result, winners } = await run(councilGraph([ref('a'), ref('b')], ref('judge')), provider('Just an answer'));
    expect(result.final).toBe('Just an answer');
    expect(winners).toEqual([]);
  });

  it('records the Vote winner', async () => {
    const nodes: CanvasNode[] = [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
      { id: 'a', type: 'llm', position: { x: 0, y: 0 }, config: { model: ref('a') } },
      { id: 'b', type: 'llm', position: { x: 0, y: 0 }, config: { model: ref('b') } },
      { id: 'v', type: 'vote', position: { x: 0, y: 0 }, config: { models: [ref('B')] } },
      { id: 'out', type: 'output', position: { x: 0, y: 0 }, config: {} },
    ];
    const edges = [['q', 'a'], ['q', 'b'], ['a', 'v'], ['b', 'v'], ['v', 'out']].map(([source, target]) => ({ id: `${source}${target}`, source, target }));
    // The voter "B" answers "B: ok", i.e. it votes B.
    const { winners, result } = await run({ nodes, edges });
    expect(result.final).toBe('b: ok');
    expect(winners[0]).toMatchObject({ nodeType: 'vote', winnerNodeId: 'b', contenders: ['a', 'b'] });
  });

  it('takes the BEST line off the judge answer in any common shape', () => {
    expect(splitBest('Answer.\n\n**BEST: 3**')).toEqual({ text: 'Answer.', best: 3 });
    expect(splitBest('Answer.\nBest answer: Answer 1')).toEqual({ text: 'Answer.', best: 1 });
    expect(splitBest('The best way is X.')).toEqual({ text: 'The best way is X.', best: undefined });
  });
});

describe('LiveText', () => {
  const stream = (pieces: string[], final: string) => {
    const l = new LiveText();
    const out = pieces.map((p) => l.push(p)).join('');
    return out + l.finish(final);
  };
  it('streams text and never sends the BEST line', () => {
    expect(stream(['Hel', 'lo\nwor', 'ld\n\n', 'BE', 'ST: ', '2'], 'Hello\nworld')).toBe('Hello\nworld\n\n');
    expect(stream(['Be', 'tter ', 'now'], 'Better now')).toBe('Better now');
    expect(stream(['a', 'b'], 'ab')).toBe('ab');
    expect(stream([], 'all at the end')).toBe('all at the end');
  });
});

describe('stats report', () => {
  it('sums cost per day, provider and model, and builds the leaderboard', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hm-stats-'));
    const { db } = await import('../src/db/index.js');
    const { statsReport } = await import('../src/api/stats.js');
    db.prepare("INSERT INTO users (id, username, pw_hash) VALUES ('u', 'u1', 'x'), ('o', 'o1', 'x')").run();
    db.prepare("INSERT INTO providers (id, preset, kind, name, base_url) VALUES ('openai', 'openai', 'openai', 'OpenAI', 'x')").run();
    const add = db.prepare('INSERT INTO run_usage (run_id, owner_id, node_id, node_type, provider_id, model, input_tokens, output_tokens, cost, gen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    add.run('r1', 'u', 'm1', 'llm', 'openai', 'gpt-4o', 100, 50, 0.01, 1000);
    add.run('r1', 'u', 'm2', 'llm', 'ollama', 'llama3', 100, 200, 0, 4000);
    add.run('r2', 'u', 'm1', 'llm', 'openai', 'gpt-4o', 100, 50, 0.02, 1000);
    add.run('r3', 'u', 'm1', 'llm', 'custom', 'mystery', 10, 10, null, null);
    add.run('r9', 'o', 'm1', 'llm', 'openai', 'gpt-4o', 1, 1, 5, null);
    const win = db.prepare('INSERT INTO run_winners (run_id, owner_id, node_id, node_type, winner_node, winner_label, winner_model, contenders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    win.run('r1', 'u', 'j', 'judge', 'm1', 'gpt-4o', 'gpt-4o', JSON.stringify(['gpt-4o', 'llama3']));
    win.run('r2', 'u', 'j', 'judge', 'm2', 'llama3', 'llama3', JSON.stringify(['gpt-4o', 'llama3']));
    win.run('r3', 'u', 'v', 'vote', 'm1', 'gpt-4o', 'gpt-4o', JSON.stringify(['gpt-4o', 'llama3', 'mistral']));

    const r = statsReport('u', 30);
    expect(r.totals).toMatchObject({ runs: 3, calls: 4, unpricedCalls: 1, inputTokens: 310, outputTokens: 310 });
    expect(r.totals.cost).toBeCloseTo(0.03);
    expect(r.byDay).toHaveLength(1);
    expect(r.byProvider[0]).toMatchObject({ providerId: 'openai', name: 'OpenAI', calls: 2 });
    const gpt = r.byModel.find((m) => m.model === 'gpt-4o')!;
    expect(gpt).toMatchObject({ calls: 2, priced: true, tokensPerSec: 50 });
    expect(r.byModel.find((m) => m.model === 'llama3')!.tokensPerSec).toBe(50);
    expect(r.byModel.find((m) => m.model === 'mystery')!.priced).toBe(false);
    expect(r.leaderboard[0]).toEqual({ model: 'gpt-4o', wins: 2, contests: 3, winRate: 2 / 3 });
    expect(r.leaderboard.find((l) => l.model === 'mistral')).toEqual({ model: 'mistral', wins: 0, contests: 1, winRate: 0 });
    // Everyone (admin view) includes the other user's run.
    expect(statsReport(undefined, 30).totals.runs).toBe(4);
  });
});
