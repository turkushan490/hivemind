import type { CanvasGraph, RunEvent, RunLimits } from '@hivemind/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, runGraph, withHostLock, type ResolvedProvider } from '../src/engine/run.js';
import { ollamaAdapter } from '../src/providers/ollama.js';
import type { ChatRequest } from '../src/providers/types.js';

import { chain, node } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake provider on one GPU. Model "hang" never answers (but stops when its signal aborts), "deaf" never answers
 * and ignores its signal; any other model answers after `delay` ms. Records when each call starts and ends.
 */
function gpu(opts: { local?: boolean; delay?: number } = {}) {
  const log: string[] = [];
  const calls: ChatRequest[] = [];
  const p: ResolvedProvider & { calls: ChatRequest[]; log: string[] } = {
    calls,
    log,
    local: opts.local ?? true,
    hostKey: 'gpu',
    modelInfo: async () => undefined,
    adapter: {
      listModels: async () => [],
      async *stream(req: ChatRequest, signal: AbortSignal) {
        calls.push(req);
        log.push(`start ${req.model}`);
        try {
          if (req.model === 'deaf') await new Promise(() => {});
          if (req.model === 'hang') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          await sleep(opts.delay ?? 0);
          yield { type: 'token' as const, text: `${req.model}: ok` };
          yield { type: 'done' as const, inputTokens: 10, outputTokens: 2 };
        } finally {
          log.push(`end ${req.model}`);
        }
      },
    },
  };
  return p;
}

const M = (model: string) => ({ providerId: 'p', model });
const one = (model: string, config: Record<string, unknown> = {}, label?: string): CanvasGraph =>
  chain(node('i', 'input'), node('l', 'llm', { model: M(model), ...config }, label), node('o', 'output'));

async function go(graph: CanvasGraph, provider: ResolvedProvider, limits: Partial<RunLimits> = {}, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, 'q', { resolve: async () => provider, emit: (e) => events.push(e as RunEvent), limits: { ...DEFAULT_LIMITS, ...limits } }, signal);
  return { result, events, errors: events.filter((e) => e.type === 'error').map((e) => e.error) };
}

describe('time limit per model call', () => {
  it('fails a model that never answers, and the next queued run starts', async () => {
    const p = gpu();
    const [a, b, c] = await Promise.all([
      go(one('hang'), p, { maxSeconds: 0.15 }),
      go(one('deaf'), p, { maxSeconds: 0.15 }),
      go(one('quick'), p, { maxSeconds: 0.15 }),
    ]);
    expect(a.result.status).toBe('error');
    expect(a.errors).toContain('hang was stopped after 0.15 seconds');
    // A provider that ignores the abort still can't hold the GPU.
    expect(b.errors).toContain('deaf was stopped after 0.15 seconds');
    expect(c.result.status).toBe('done');
    // One at a time on the GPU, in order.
    expect(p.log.indexOf('start deaf')).toBeGreaterThan(p.log.indexOf('end hang'));
    expect(p.log.indexOf('start quick')).toBeGreaterThan(p.log.indexOf('start deaf'));
    // The time-out is not retried as "only thought".
    expect(p.calls.filter((x) => x.model === 'hang')).toHaveLength(1);
  });

  it('does not count time waiting in the queue', async () => {
    const p = gpu({ delay: 200 });
    const runs = await Promise.all([go(one('a'), p, { maxSeconds: 0.35 }), go(one('b'), p, { maxSeconds: 0.35 })]);
    // b waited ~200 ms for a, then took ~200 ms itself: over 0.35 s in total, but its call is under.
    expect(runs.map((r) => r.result.status)).toEqual(['done', 'done']);
  });

  it("uses the block's own maxSeconds over the setting", async () => {
    const p = gpu({ delay: 150 });
    expect((await go(one('slow'), p, { maxSeconds: 0.05 })).errors).toContain('slow was stopped after 0.05 seconds');
    expect((await go(one('slow', { maxSeconds: 10 }), p, { maxSeconds: 0.05 })).result.status).toBe('done');
  });

  it('applies to cloud providers too', async () => {
    const p = gpu({ local: false });
    expect((await go(one('hang'), p, { maxSeconds: 0.05 })).errors).toContain('hang was stopped after 0.05 seconds');
  });
});

describe('token ceiling and context size', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives local models the run limits when the block has none, cloud models nothing', async () => {
    const local = gpu();
    await go(one('m'), local, { maxTokens: 4096, numCtx: 16384 });
    expect(local.calls[0]).toMatchObject({ maxTokens: 4096, numCtx: 16384 });
    const own = gpu();
    await go(one('m', { maxTokens: 100, numCtx: 8192 }), own);
    expect(own.calls[0]).toMatchObject({ maxTokens: 100, numCtx: 8192 });
    const cloud = gpu({ local: false });
    await go(one('m'), cloud);
    expect(cloud.calls[0].maxTokens).toBeUndefined();
    expect(cloud.calls[0].numCtx).toBeUndefined();
  });

  /** The real Ollama adapter on a fake server: each /api/chat answers with the next list of lines. */
  const ollama = (answers: object[][]) => {
    const bodies: { options: Record<string, unknown>; think?: boolean }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(answers[bodies.length - 1].map((l) => JSON.stringify(l)).join('\n') + '\n');
    });
    const p: ResolvedProvider = { adapter: ollamaAdapter({ id: 'o', kind: 'ollama', preset: 'ollama', baseUrl: 'http://x' }), local: true, hostKey: 'x', modelInfo: async () => undefined };
    return { p, bodies };
  };

  it('sends num_predict and num_ctx to Ollama, and notes when the ceiling stopped the answer', async () => {
    const { p, bodies } = ollama([[{ message: { content: 'a long answer' } }, { done: true, done_reason: 'length', eval_count: 4096 }]]);
    const { result, events } = await go(one('m'), p);
    expect(bodies[0].options).toMatchObject({ num_predict: 4096, num_ctx: 16384 });
    expect(result.final).toBe('a long answer');
    expect(events.some((e) => e.type === 'node_progress' && e.note === 'Stopped at the 4096-token limit')).toBe(true);
  });

  it('asks again without thinking when a thinking model hit the ceiling with no answer', async () => {
    const { p, bodies } = ollama([
      [{ message: { thinking: 'hmm '.repeat(5) } }, { done: true, done_reason: 'length' }],
      [{ message: { content: 'the answer' } }, { done: true, done_reason: 'stop' }],
    ]);
    const { result, events } = await go(one('m'), p);
    expect(result.final).toBe('the answer');
    expect(bodies[1].think).toBe(false);
    const notes = events.filter((e) => e.type === 'node_progress').map((e) => e.note);
    expect(notes).toEqual(['Stopped at the 4096-token limit', 'Only thought, no answer — asking again without thinking']);
  });
});

describe('stopping a run that waits for the GPU', () => {
  it('ends a waiting job at once and keeps the queue in order', async () => {
    const order: string[] = [];
    let free!: () => void;
    const holder = withHostLock('q', () => new Promise<void>((r) => (free = () => (order.push('holder done'), r()))), { label: 'holder' });
    await sleep(5);
    const c1 = new AbortController();
    const c3 = new AbortController();
    const w1 = withHostLock('q', async () => void order.push('w1'), { signal: c1.signal });
    const w2 = withHostLock('q', async () => {
      order.push('w2 start');
      await sleep(30);
      order.push('w2 end');
    });
    const w3 = withHostLock('q', async () => void order.push('w3'), { signal: c3.signal });
    c1.abort();
    await expect(w1).rejects.toThrow('Cancelled');
    await sleep(20);
    // Nobody got in while the holder still runs.
    expect(order).toEqual([]);
    free();
    await Promise.all([holder, w2, w3]);
    expect(order).toEqual(['holder done', 'w2 start', 'w2 end', 'w3']);
  });

  it('stops a waiting run right away, and the run behind it waits for the holder', async () => {
    const p = gpu();
    const c = new AbortController();
    const first = go(one('hang'), p, { maxSeconds: 0.4 });
    await sleep(10);
    const t0 = Date.now();
    const waiting = go(one('b'), p, {}, c.signal);
    const behind = go(one('c'), p);
    await sleep(10);
    c.abort('Stopped by Unload');
    const w = await waiting;
    expect(Date.now() - t0).toBeLessThan(200);
    expect(w.result.status).toBe('cancelled');
    expect(w.errors[0]).toBe('Stopped by Unload');
    expect(p.log).not.toContain('start c');
    const [f, b] = await Promise.all([first, behind]);
    expect(f.result.status).toBe('error');
    expect(b.result.status).toBe('done');
    expect(p.log).toEqual(['start hang', 'end hang', 'start c', 'end c']);
  });
});
