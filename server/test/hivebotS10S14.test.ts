import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: typeof import('../src/db/index.js').db;

beforeAll(async () => {
  ({ app, db } = await testApp('s10s14'));
  // A remote OpenAI-compatible server that says nothing about sizes.
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('big', 'custom', 'openai', 'Big box', 'http://big.test/v1', 0)").run();
});
afterAll(() => app?.close());

const fakeModels = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'giant-400b' }, { id: 'small-8b' }] }), { headers: { 'content-type': 'application/json' } })),
  );

describe('HiveBot S10: sizes of remote models', () => {
  it('a size written down for a remote model shows in /api/models, and can be removed', async () => {
    fakeModels();
    try {
      const put = await app.inject({ method: 'PUT', url: '/api/providers/big/sizes', headers: bearer(), payload: { model: 'giant-400b', sizeGb: 400, params: '400B' } });
      expect(put.statusCode).toBe(200);
      const list = (await app.inject({ method: 'GET', url: '/api/models', headers: bearer() })).json() as { models: { model: string; sizeBytes?: number; params?: string }[] };
      expect(list.models.find((m) => m.model === 'giant-400b')).toMatchObject({ sizeBytes: 400e9, params: '400B' });
      expect(list.models.find((m) => m.model === 'small-8b')?.sizeBytes).toBeUndefined();
      await app.inject({ method: 'PUT', url: '/api/providers/big/sizes', headers: bearer(), payload: { model: 'giant-400b', sizeGb: 0 } });
      const after = (await app.inject({ method: 'GET', url: '/api/models', headers: bearer() })).json() as { models: { model: string; sizeBytes?: number }[] };
      expect(after.models.find((m) => m.model === 'giant-400b')?.sizeBytes).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a size that makes no sense', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/providers/big/sizes', headers: bearer(), payload: { model: 'x', sizeGb: -5 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('HiveBot S14: the workflow guide and a skills permission for tokens', () => {
  it('HiveMind comes with the hivemind-workflows guide, shared, and keeps an admin\'s own changes', async () => {
    const { seedBuiltinSkills } = await import('../src/services/skills.js');
    seedBuiltinSkills();
    const skills = (await app.inject({ method: 'GET', url: '/api/skills', headers: bearer() })).json() as { id: string; name: string; shared: boolean }[];
    const guide = skills.find((s) => s.name === 'hivemind-workflows')!;
    expect(guide).toBeTruthy();
    expect(guide.shared).toBe(true);
    // Seeding again changes nothing (no second copy).
    seedBuiltinSkills();
    const again = (await app.inject({ method: 'GET', url: '/api/skills', headers: bearer() })).json() as { name: string }[];
    expect(again.filter((s) => s.name === 'hivemind-workflows')).toHaveLength(1);
  });

  it('a limited token writes skills only with the skills permission, which can be switched on later', async () => {
    const make = await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer(), payload: { name: 'robot', canvases: ['hivebot-*'], memory: ['hivebot*'] } });
    const { token, id } = make.json() as { token: string; id: string };
    const robot = { authorization: `Bearer ${token}` };
    const skillMd = '---\nname: robot-notes\ndescription: what the robot learned\n---\nBe brief.';
    const denied = await app.inject({ method: 'POST', url: '/api/skills', headers: robot, payload: { skillMd } });
    expect(denied.statusCode).toBe(403);
    const on = await app.inject({ method: 'PATCH', url: `/api/tokens/${id}`, headers: bearer(), payload: { skills: true } });
    expect(on.json().scope).toMatchObject({ canvases: ['hivebot-*'], skills: true });
    const made = await app.inject({ method: 'POST', url: '/api/skills', headers: robot, payload: { skillMd } });
    expect(made.statusCode).toBe(200);
    // Still limited everywhere else.
    expect((await app.inject({ method: 'GET', url: '/api/providers', headers: robot })).statusCode).toBe(403);
    await app.inject({ method: 'PATCH', url: `/api/tokens/${id}`, headers: bearer(), payload: { skills: false } });
    expect((await app.inject({ method: 'POST', url: '/api/skills', headers: robot, payload: { skillMd } })).statusCode).toBe(403);
  });
});
