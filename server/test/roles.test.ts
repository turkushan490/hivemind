import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasGraph } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let app: FastifyInstance;
const routes: { method: string; url: string }[] = [];
let VIEWER_WRITES: Set<string>;
const bearer = (who: string) => ({ authorization: `Bearer hm_${who}` });

const echo = (prefix: string): CanvasGraph => ({
  nodes: [
    { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
    { id: 't', type: 'template', position: { x: 0, y: 0 }, config: { prompt: `${prefix} {{question}}` } },
    { id: 'out', type: 'output', position: { x: 0, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'a', source: 'q', target: 't' },
    { id: 'b', source: 't', target: 'out' },
  ],
});

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hm-roles-'));
  const { buildApp } = await import('../src/app.js');
  ({ VIEWER_WRITES } = await import('../src/api/auth.js'));
  const { db } = await import('../src/db/index.js');
  const { sha256 } = await import('../src/crypto.js');
  for (const [id, role] of [
    ['admin', 'admin'],
    ['user', 'user'],
    ['viewer', 'viewer'],
  ]) {
    db.prepare('INSERT INTO users (id, username, pw_hash, role) VALUES (?, ?, ?, ?)').run(id, `${id}1`, 'x', role);
    db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES (?, ?, 't', ?, 'hm_')").run(`t-${id}`, id, sha256(`hm_${id}`));
  }
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph, shared) VALUES ('shared1', 'user', 'Shared echo', ?, 1)").run(JSON.stringify(echo('Shared:')));
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph, shared) VALUES ('private1', 'user', 'Private echo', ?, 0)").run(JSON.stringify(echo('Private:')));
  app = await buildApp({ logger: false, web: false, onRoute: (r) => [r.method].flat().forEach((m) => routes.push({ method: m, url: r.url })) });
  await app.ready();
});
afterAll(() => app?.close());

describe('roles', () => {
  it('refuses every write route to viewers, except their short list', async () => {
    const writes = routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
    expect(writes.length).toBeGreaterThan(30);
    for (const r of writes) {
      const url = r.url.replace(/:(\w+)\?/g, 'x').replace(/:(\w+)/g, 'x');
      const res = await app.inject({ method: r.method as 'POST', url, headers: { ...bearer('viewer'), 'content-type': 'application/json' }, payload: '{}' });
      const allowed = VIEWER_WRITES.has(`${r.method} ${r.url}`);
      expect({ route: `${r.method} ${r.url}`, forbidden: res.statusCode === 403 }).toEqual({ route: `${r.method} ${r.url}`, forbidden: !allowed });
    }
  });

  it('every route on the viewer list exists', () => {
    const all = new Set(routes.map((r) => `${r.method} ${r.url}`));
    for (const w of VIEWER_WRITES) expect(all.has(w), w).toBe(true);
  });

  it('shows viewers shared canvases only, and runs them as saved', async () => {
    const list = (await app.inject({ url: '/api/canvases', headers: bearer('viewer') })).json() as { id: string; mine: boolean; ownerName?: string }[];
    expect(list.map((c) => c.id)).toEqual(['shared1']);
    expect(list[0]).toMatchObject({ mine: false, ownerName: 'user1' });

    // A graph in the body is ignored: the saved canvas runs.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: bearer('viewer'),
      payload: { model: 'shared-echo', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.json().choices[0].message.content).toBe('Shared: hi');
    const private1 = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer('viewer'), payload: { question: 'x', canvasId: 'private1' } });
    expect(private1.statusCode).toBe(404);
    const adhoc = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer('viewer'), payload: { question: 'x', graph: echo('x') } });
    expect(adhoc.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer('viewer'), payload: { question: 'x', canvasId: 'shared1', graph: echo('Hacked') } });
    expect(ok.statusCode).toBe(200);
  });

  it('keeps settings for admins and lets admins manage roles', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer('user'), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/canvases/c-user', headers: bearer('user'), payload: { name: 'Mine', nodes: [], edges: [] } })).statusCode).toBe(200);
    const patched = await app.inject({ method: 'PATCH', url: '/api/users/user', headers: bearer('admin'), payload: { role: 'viewer' } });
    expect(patched.json().role).toBe('viewer');
    expect((await app.inject({ method: 'PUT', url: '/api/canvases/c-user', headers: bearer('user'), payload: { name: 'Mine', nodes: [], edges: [] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/admin', headers: bearer('admin'), payload: { role: 'user' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/user', headers: bearer('admin'), payload: { role: 'boss' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/user', headers: bearer('user'), payload: { role: 'admin' } })).statusCode).toBe(403);
  });
});
