import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let bm25: typeof import('../src/services/memory.js').bm25;

beforeAll(async () => {
  ({ app, db } = await testApp('memsearch'));
  ({ bm25 } = await import('../src/services/memory.js'));
});
afterAll(() => app?.close());

const RULES = [
  { text: 'Prone: a prone creature has disadvantage on attack rolls.', tags: ['condition'] },
  { text: 'Grapple: make an Athletics check contested by the target’s Athletics or Acrobatics. A grappled creature’s speed becomes 0.' },
  { text: 'Fireball: a bright streak flashes to a point you choose, then blossoms into an explosion of flame. 8d6 fire damage.' },
];

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: bearer(), payload: payload as object });

describe('memory import + search', () => {
  it('imports entries and finds the grapple rule first', async () => {
    const imp = await post('/api/memory/keys/rules:test/import', { replace: true, entries: RULES });
    expect(imp.statusCode).toBe(200);
    expect(imp.json()).toEqual({ imported: 3, key: 'rules:test' });
    const res = await post('/api/memory/keys/rules:test/search', { query: 'how does grapple work?', limit: 3 });
    expect(res.statusCode).toBe(200);
    const hits = res.json() as { text: string; score: number; at: string }[];
    expect(hits[0].text).toMatch(/^Grapple/);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits.every((h) => typeof h.at === 'string')).toBe(true);
    // Stemming: "grappled" finds it too.
    const stem = (await post('/api/memory/keys/rules:test/search', { query: 'grappled', limit: 1 })).json();
    expect(stem[0].text).toMatch(/^Grapple/);
  });

  it('replace wipes the key first', async () => {
    await post('/api/memory/keys/rules:wipe/import', { entries: RULES });
    await post('/api/memory/keys/rules:wipe/import', { replace: true, entries: [{ text: 'Only this one' }] });
    const n = db.prepare("SELECT COUNT(*) AS n FROM memory WHERE key = 'rules:wipe'").get() as { n: number };
    expect(n.n).toBe(1);
    const keys = (await app.inject({ method: 'GET', url: '/api/memory/keys', headers: bearer() })).json() as { key: string; pinned: boolean }[];
    expect(keys.find((k) => k.key === 'rules:wipe')?.pinned).toBe(true);
  });

  it('refuses imports that are too big with 413', async () => {
    const many = await post('/api/memory/keys/big/import', { entries: Array.from({ length: 20_001 }, () => ({ text: 'x' })) });
    expect(many.statusCode).toBe(413);
    const huge = await post('/api/memory/keys/big/import', { entries: [{ text: 'x'.repeat(21 * 1024 * 1024) }] });
    expect(huge.statusCode).toBe(413);
  });

  it('answers 404 for a key with nothing in it, 400 without a query', async () => {
    expect((await post('/api/memory/keys/nope/search', { query: 'x' })).statusCode).toBe(404);
    expect((await post('/api/memory/keys/rules:test/search', {})).statusCode).toBe(400);
  });

  it('a normal save still trims to 500, an imported key keeps everything', async () => {
    const { memoryFor } = await import('../src/services/memory.js');
    const mem = memoryFor('u1');
    for (let i = 0; i < 505; i++) mem.save('chat', `turn ${i}`);
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory WHERE key = 'chat'").get() as { n: number }).n).toBe(500);
    await post('/api/memory/keys/rules:big/import', { entries: Array.from({ length: 600 }, (_, i) => ({ text: `rule ${i}` })) });
    mem.save('rules:big', 'one more');
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory WHERE key = 'rules:big'").get() as { n: number }).n).toBe(601);
  });

  it('a Memory block in search mode looks up the query from vars', async () => {
    const graph = chain(node('q', 'input'), node('m', 'memory', { key: 'rules:{{vars.ruleset}}', mode: 'search', query: '{{vars.actions}}', limit: 1 }, 'rules'), node('o', 'output'));
    const run = await runAndWait(app, { graph, question: 'turn', vars: { ruleset: 'test', actions: 'I cast fireball at the goblins' } });
    expect(run.status).toBe('done');
    expect(run.outputs?.rules.text, run.outputs?.rules.text).toContain('Fireball');
    expect(run.outputs?.rules.text).not.toContain('Grapple');
  });
});

describe('BM25 fallback (no FTS5)', () => {
  it('ranks the matching row first and leaves out rows without a match', () => {
    const hits = bm25(RULES, 'grapple athletics', 5);
    expect(hits[0].text).toMatch(/^Grapple/);
    expect(hits).toHaveLength(1);
    expect(bm25(RULES, '', 5)).toEqual([]);
  });
});
