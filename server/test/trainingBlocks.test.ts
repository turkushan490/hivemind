import type { RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { runGraph } from '../src/engine/run.js';
import type { NodeServices } from '../src/nodes/index.js';
import { chain, edge, fakeProvider, node } from './helpers.js';

const M = { providerId: 'p', model: 'teacher' };

/** A fake of the run's training services, recording what the blocks asked for. */
function fakeTraining() {
  const added: { dataset: string; items: { input?: string; output?: string }[]; review?: boolean }[] = [];
  const started: unknown[] = [];
  const deployed: unknown[] = [];
  const training: NonNullable<NodeServices['training']> = {
    addExamples: (dataset, items, opts) => {
      added.push({ dataset, items, review: opts.review });
      return { name: dataset, added: items.length, items: items.length, pending: opts.review ? items.length : 0 };
    },
    sample: () => [
      { input: 'Capital of France?', output: 'Paris', system: null },
      { input: '2+2?', output: '4', system: null },
    ],
    startTrain: (opts) => (started.push(opts), { id: 'job1', name: opts.name, rows: 42, state: 'waiting' }),
    deploy: (pattern, model) => (deployed.push({ pattern, model }), { canvases: 2, blocks: 5 }),
  };
  return { training, added, started, deployed };
}

const run = async (graph: Parameters<typeof runGraph>[0], provider: ReturnType<typeof fakeProvider>, training?: NodeServices['training']) => {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, 'Hello?', { resolve: async () => provider, emit: (e) => events.push(e as RunEvent), services: { training } }, new AbortController().signal);
  return { result, events, error: events.find((e) => e.type === 'error')?.error };
};

describe('training blocks', () => {
  it('Generate examples: the teacher writes them in batches and they go into the dataset', async () => {
    const f = fakeTraining();
    let n = 0;
    const p = fakeProvider(() => JSON.stringify({ examples: Array.from({ length: 10 }, () => ({ input: `q${++n}`, output: `a${n}` })) }));
    const { result } = await run(chain(node('i', 'input'), node('g', 'generate', { model: M, prompt: 'Friendly answers', count: 15, dataset: 'Style' }), node('o', 'output')), p, f.training);
    expect(f.added[0].dataset).toBe('Style');
    expect(f.added[0].items).toHaveLength(15);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1].messages.at(-1)!.content).toContain("don't repeat");
    expect(result.final).toContain('Added 15 to "Style"');
  });

  it('Add to dataset: the question is the input, the answer wired in the output', async () => {
    const f = fakeTraining();
    await run(chain(node('i', 'input'), node('l', 'llm', { model: M }), node('d', 'dataset', { dataset: 'Good', review: true }), node('o', 'output')), fakeProvider(() => 'Hi there!'), f.training);
    expect(f.added[0]).toEqual({ dataset: 'Good', items: [{ input: 'Hello?', output: 'Hi there!' }], review: true });
  });

  it('Train: queues a job and the run goes on', async () => {
    const f = fakeTraining();
    const { result } = await run(chain(node('i', 'input'), node('t', 'train', { dataset: 'Good', trainBase: 'unsloth/Qwen3.5-2B', trainName: 'My-Model:v1', epochs: 3 }), node('o', 'output')), fakeProvider(), f.training);
    expect(f.started[0]).toMatchObject({ dataset: 'Good', base: 'unsloth/Qwen3.5-2B', name: 'my-model:v1', epochs: 3 });
    expect(result.final).toContain('Job job1');
  });

  it('Evaluate: every model answers, the judge grades against the reference, best first', async () => {
    const f = fakeTraining();
    const p = fakeProvider((req) => (req.model === 'judge' ? '{"scores": [9, 3]}' : `${req.model} says hi`));
    const graph = chain(node('i', 'input'), node('e', 'evaluate', { model: { providerId: 'p', model: 'judge' }, models: [{ providerId: 'p', model: 'good' }, { providerId: 'p', model: 'bad' }], dataset: 'Tests', count: 2 }), node('o', 'output'));
    const { result } = await run(graph, p, f.training);
    expect(p.calls.filter((c) => c.model === 'judge')).toHaveLength(2);
    expect(result.final).toMatch(/🏆 good \| 9\.0/);
    expect(result.final!.indexOf('good')).toBeLessThan(result.final!.indexOf('bad'));
  });

  it('Deploy: puts the model into the matching canvases', async () => {
    const f = fakeTraining();
    const { result } = await run(chain(node('i', 'input'), node('d', 'deploy', { model: { providerId: 'p', model: 'my-model:v1' }, canvasPattern: 'dnd-*' }), node('o', 'output')), fakeProvider(), f.training);
    expect(f.deployed[0]).toEqual({ pattern: 'dnd-*', model: { providerId: 'p', model: 'my-model:v1' } });
    expect(result.final).toContain('5 AI model blocks in 2 canvases');
  });

  it('without training rights (viewer, limited token) the blocks fail clearly', async () => {
    const { error } = await run(chain(node('i', 'input'), node('l', 'llm', { model: M }), node('d', 'dataset', { dataset: 'x' }), node('o', 'output')), fakeProvider());
    expect(error).toMatch(/user who may train/);
  });

  it('a check catches missing settings before the run', async () => {
    const graph = { nodes: [node('i', 'input'), node('t', 'train', { dataset: 'x' }), node('o', 'output')], edges: [edge('i', 't'), edge('t', 'o')] };
    await expect(runGraph(graph, 'q', { resolve: async () => fakeProvider(), emit: () => {} }, new AbortController().signal)).rejects.toThrow(/base model/);
  });
});
