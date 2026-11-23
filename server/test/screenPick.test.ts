import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chain, edge, node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await testApp('screenpick'));
});
afterAll(async () => {
  await app?.close();
});

// The HiveBot shape: a router by {{vars.character}} with a template per character.
const graph = (() => {
  const g = chain(node('in', 'input'), node('desk', 'router', { routeBy: '{{vars.character}}' }));
  g.nodes.push(node('jev', 'template', { prompt: 'jev: {{question}}' }, 'jev'), node('ultron', 'template', { prompt: 'ultron: {{question}}' }, 'ultron'), node('out', 'output'));
  g.edges.push(edge('desk', 'jev'), edge('desk', 'ultron'), edge('jev', 'out'), edge('ultron', 'out'));
  return g;
})();

describe('a HiveBot workflow run from the screen', () => {
  it('picks the character from the name in the question when none is given', async () => {
    const r = await runAndWait(app, { graph, question: 'ultron make a website about paper' });
    expect(r.final).toBe('ultron: make a website about paper');
  });

  it('a given character still wins', async () => {
    const r = await runAndWait(app, { graph, question: 'ultron make a website', vars: { character: 'jev' } });
    expect(r.final).toBe('jev: ultron make a website');
  });
});
