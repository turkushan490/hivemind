import type { RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGraph } from '../src/engine/run.js';
import { checkVars } from '../src/engine/vars.js';
import { fillTemplate } from '../src/nodes/actions.js';
import { bearer, chain, fakeProvider, node, runAndWait, testApp } from './helpers.js';

const run = async (graph: Parameters<typeof runGraph>[0], vars: Record<string, string>, provider = fakeProvider()) => {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, 'x', { resolve: async () => provider, emit: (e) => events.push(e as RunEvent) }, new AbortController().signal, vars);
  return { result, events, provider };
};

describe('run variables', () => {
  it('fills {{vars.name}} in a template block', async () => {
    const { result } = await run(chain(node('i', 'input'), node('g', 'template', { prompt: 'Hi {{vars.name}}' })), { name: 'Turks' });
    expect(result.final).toBe('Hi Turks');
  });

  it('makes an unknown var empty, and never fills text that came in', async () => {
    const { result } = await run(chain(node('i', 'input'), node('g', 'template', { prompt: '[{{vars.nope}}] {{ vars.a }}' })), { a: '{{vars.b}}', b: 'B' });
    expect(result.final).toBe('[] {{vars.b}}');
  });

  it('fills system and prompt of a model block', async () => {
    const { provider } = await run(chain(node('i', 'input'), node('l', 'llm', { model: { providerId: 'p', model: 'm' }, system: 'You run {{vars.ruleset}}', prompt: 'Party: {{vars.party}}' })), {
      ruleset: 'srd51',
      party: 'Turks',
    });
    expect(provider.calls[0].messages).toEqual([
      { role: 'system', content: 'You run srd51' },
      { role: 'user', content: 'Party: Turks' },
    ]);
  });

  it('JSON-escapes vars in a JSON webhook body', () => {
    const out = fillTemplate('{"say": "{{vars.line}}"}', { question: 'q', inputs: [], vars: { line: 'He said "hi"\n' } });
    expect(JSON.parse(out)).toEqual({ say: 'He said "hi"\n' });
  });

  it('checks the limits', () => {
    expect(checkVars(undefined)).toEqual({});
    expect(checkVars({ a_1: 'x' })).toEqual({ a_1: 'x' });
    expect(() => checkVars({ 'bad-key': 'x' })).toThrow(/not a valid name/);
    expect(() => checkVars({ a: 1 })).toThrow(/object of strings/);
    expect(() => checkVars(['x'])).toThrow(/object of strings/);
    expect(() => checkVars(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'x'])))).toThrow(/64/);
    expect(() => checkVars({ big: 'x'.repeat(1024 * 1024 + 1) })).toThrow(/1 MB/);
  });
});

describe('vars over the API', () => {
  let app: FastifyInstance;
  let db: Awaited<ReturnType<typeof testApp>>['db'];
  const graph = chain(node('i', 'input'), node('g', 'template', { prompt: 'Hi {{vars.name}}' }, 'greet'), node('o', 'output'));
  beforeAll(async () => {
    ({ app, db } = await testApp('vars'));
    db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('t-vars', 'u1', 'Vars test', ?)").run(JSON.stringify(graph));
  });
  afterAll(() => app?.close());

  it('POST /api/runs fills vars and stores them on the run', async () => {
    const run = await runAndWait(app, { canvasId: 't-vars', question: 'x', vars: { name: 'Turks' } });
    expect(run.final).toBe('Hi Turks');
    const row = db.prepare('SELECT vars FROM runs WHERE id = ?').get(run.id) as { vars: string };
    expect(JSON.parse(row.vars)).toEqual({ name: 'Turks' });
  });

  it('refuses bad vars with 400', async () => {
    for (const vars of [{ 'no spaces': 'x' }, { a: 5 }, 'text']) {
      const res = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer(), payload: { canvasId: 't-vars', question: 'x', vars } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/vars/);
    }
  });

  it('/v1 passes hivemind_vars through', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: bearer(),
      payload: { model: 't-vars', messages: [{ role: 'user', content: 'x' }], hivemind_vars: { name: 'Esvahanna' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('Hi Esvahanna');
    const bad = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 't-vars', messages: [{ role: 'user', content: 'x' }], hivemind_vars: { a: 1 } } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists the vars feature on /api/health', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toContain('vars');
  });
});
