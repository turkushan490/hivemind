import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];

beforeAll(async () => {
  ({ app, db } = await testApp('decroutes'));
  const { seedProviders } = await import('../src/api/providers.js');
  seedProviders('http://ollama:11434', '', 'ts-secret-key');
  seedProviders('http://ollama:11434', '', 'ts-secret-key');
});
afterAll(() => app?.close());
afterEach(() => vi.unstubAllGlobals());

describe('decision provider routes', () => {
  it('TYPESAFE_API_KEY seeds Jev once, with the key stored encrypted', () => {
    const rows = db.prepare("SELECT kind, api_key_enc FROM providers WHERE preset = 'typesafe'").all() as { kind: string; api_key_enc: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('decision');
    expect(rows[0].api_key_enc).not.toContain('ts-secret-key');
  });

  it('Test runs the spam example', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.typesafe.ai')) return real(url, init);
      if (String(url).endsWith('/v1/models')) return Response.json({ models: [{ name: 'jev-latest' }] });
      return Response.json({ model: 'jev-1.14.0', answers: { spam: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 500 } });
    });
    const res = await app.inject({ method: 'POST', url: '/api/providers/typesafe/test-decision', headers: bearer() });
    expect(res.statusCode).toBe(200);
    expect(res.json().answers.spam).toEqual({ type: 'noul', p: 0.97 });
  });

  it('a 4xx from the API is shown and logged to Problems', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad key', { status: 401 }));
    const res = await app.inject({ method: 'POST', url: '/api/providers/typesafe/test-decision', headers: bearer() });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/HTTP 401/);
    const logged = db.prepare("SELECT message FROM error_log WHERE source = 'provider' ORDER BY id DESC").get() as { message: string };
    expect(logged.message).toMatch(/TypeSafe \(Jev\) test failed/);
  });

  it('decision models are listed with kind "decision"', async () => {
    vi.stubGlobal('fetch', async (url: string) => (String(url).endsWith('/v1/models') ? Response.json({ models: [] }) : Response.json({ models: [] })));
    const res = await app.inject({ method: 'GET', url: '/api/providers/typesafe/models?fresh=1', headers: bearer() });
    expect(res.json().every((m: { kind: string }) => m.kind === 'decision')).toBe(true);
  });
});

describe('Decide in a real run', () => {
  const graph = {
    nodes: [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
      { id: 'd', type: 'decide', label: 'guard', position: { x: 0, y: 0 }, config: { model: { providerId: 'typesafe', model: 'jev-latest' }, questions: [{ name: 'spam', type: 'noul', instructions: 'Spam?' }] } },
    ],
    edges: [{ id: 'e', source: 'q', target: 'd' }],
  };
  const start = async () => {
    const { runAndWait } = await import('./helpers.js');
    return runAndWait(app, { graph, question: 'buy now' });
  };

  it('records the Jev call in run_usage with its cost', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/v1/models') ? Response.json({ models: [{ name: 'jev-latest' }] }) : Response.json({ model: 'jev-1.14.0', answers: { spam: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 2000 } }),
    );
    const run = await start();
    expect(run.status).toBe('done');
    const u = db.prepare("SELECT node_type, model, input_tokens, cost FROM run_usage WHERE run_id = ?").get(run.id) as Record<string, unknown>;
    expect(u).toMatchObject({ node_type: 'decide', model: 'jev-latest', input_tokens: 2000 });
    expect(u.cost).toBeCloseTo((2000 * 0.042) / 1e6);
  });

  it('a 4xx is shown on the block and logged to Problems', async () => {
    vi.stubGlobal('fetch', async (url: string) => (String(url).endsWith('/v1/models') ? Response.json({ models: [] }) : new Response('{"detail":"invalid key"}', { status: 401 })));
    const run = await start();
    expect(run.status).toBe('error');
    expect(run.events.find((e) => e.type === 'error')?.error).toMatch(/HTTP 401/);
    const logged = db.prepare("SELECT message FROM error_log WHERE source = 'run' AND run_id = ?").get(run.id) as { message: string };
    expect(logged.message).toMatch(/guard.*HTTP 401/);
  });

  it('a decision provider without a key is refused when added', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/providers', headers: bearer(), payload: { preset: 'typesafe' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/needs an API key/);
  });
});
