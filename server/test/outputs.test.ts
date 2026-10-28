import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeOutputs } from '../src/services/runOutputs.js';
import { bearer, edge, node, runAndWait, testApp } from './helpers.js';

describe('per-node outputs', () => {
  let app: FastifyInstance;
  beforeAll(async () => ({ app } = await testApp('outputs')));
  afterAll(() => app?.close());

  it('gives the text of every labelled block, and label on node_done', async () => {
    const graph = {
      nodes: [
        node('i', 'input'),
        node('n2', 'template', { prompt: 'The dirge crawls under the skin of {{vars.foe}}' }, 'narration'),
        node('n3', 'template', { prompt: '{"deltas":[]}' }, 'state'),
        node('n4', 'template', { prompt: 'again' }, 'state'),
        node('n5', 'template', { prompt: 'no label' }),
      ],
      edges: [edge('i', 'n2'), edge('n2', 'n3'), edge('n2', 'n4'), edge('i', 'n5')],
    };
    const run = await runAndWait(app, { graph, question: 'go', vars: { foe: 'the hag' } });
    expect(run.outputs!.narration).toEqual({ nodeId: 'n2', type: 'template', text: 'The dirge crawls under the skin of the hag' });
    expect(run.outputs!.state.text).toBe('{"deltas":[]}');
    expect(run.outputs!['state#2'].nodeId).toBe('n4');
    expect(run.outputs!.n5.text).toBe('no label');
    expect(run.events.find((e) => e.type === 'node_done' && e.nodeId === 'n2')?.label).toBe('narration');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toContain('nodeOutputs');
  });

  it('leaves out failed and skipped blocks', () => {
    const out = nodeOutputs([
      { type: 'node_done', nodeId: 'a', nodeType: 'llm', label: 'ok', text: 'yes' },
      { type: 'error', nodeId: 'b', error: 'boom' },
      { type: 'node_skipped', nodeId: 'c' },
    ] as never);
    expect(Object.keys(out)).toEqual(['ok']);
  });

  it('answers 404 for an unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope', headers: bearer() });
    expect(res.statusCode).toBe(404);
  });
});
