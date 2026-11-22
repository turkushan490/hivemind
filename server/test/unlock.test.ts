import type { Canvas } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let mem: typeof import('../src/services/memoryFiles.js');

/** A screen login (session cookie): only that can use unlock mode, never an API token. */
const screen = { cookies: { hm_session: 'screen' } };
const get = (url: string, auth: object = screen) => app.inject({ method: 'GET', url, ...auth });
const send = (method: 'POST' | 'PUT', url: string, payload: object, auth: object = screen) => app.inject({ method, url, payload, ...auth });

beforeAll(async () => {
  ({ app, db } = await testApp('unlock'));
  mem = await import('../src/services/memoryFiles.js');
  const { sha256 } = await import('../src/crypto.js');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('screen'), 'u1', Date.now() + 3_600_000);
});
afterAll(() => app.close());

describe('unlock mode', () => {
  it('an API token can never unlock', async () => {
    expect((await send('POST', '/api/unlock', { on: true }, { headers: bearer() })).statusCode).toBe(403);
    expect((await get('/api/unlock', { headers: bearer() })).json()).toEqual({ allowed: false, unlocked: false });
  });

  it('turning it on makes the hidden Prompt maker and hidden memory, outside the normal memory', async () => {
    mem.write('u1', 'notes/normal.md', 'normal note');
    expect((await send('POST', '/api/unlock', { on: true })).json()).toEqual({ allowed: true, unlocked: true });
    const list = (await get('/api/canvases')).json() as Canvas[];
    const pm = list.find((c) => c.name === 'Prompt maker')!;
    expect(pm).toMatchObject({ hidden: true, folder: 'Unlocked' });
    expect(pm.nodes.find((n) => n.id === 'm')!.config.model).toBeUndefined(); // no Colibri in tests
    // The hidden memory has prompts/good.md; the normal tree never shows it, the hidden tree never shows normal notes.
    const hiddenTree = (await get('/api/memory-files/tree?hidden=1')).json() as { files: { path: string }[] };
    expect(hiddenTree.files.map((f) => f.path)).toEqual(['prompts/good.md']);
    expect(mem.tree('u1').map((f) => f.path)).toEqual(['notes/normal.md']);
    expect(mem.search('u1', 'Prompt maker')).toEqual([]);
  });

  it('hidden workflows and memory are gone while locked, and for API tokens even when unlocked', async () => {
    const pm = ((await get('/api/canvases')).json() as Canvas[]).find((c) => c.name === 'Prompt maker')!;
    // Unlocked, but an API token (T3, robots): not there.
    expect(((await get('/api/canvases', { headers: bearer() })).json() as Canvas[]).some((c) => c.hidden)).toBe(false);
    expect((await get(`/api/canvases/${pm.id}`, { headers: bearer() })).statusCode).toBe(404);
    expect((await get('/api/memory-files/tree?hidden=1', { headers: bearer() })).statusCode).toBe(403);

    await send('POST', '/api/unlock', { on: false });
    expect(((await get('/api/canvases')).json() as Canvas[]).some((c) => c.hidden)).toBe(false);
    expect((await get(`/api/canvases/${pm.id}`)).statusCode).toBe(404);
    expect((await get('/api/memory-files/tree?hidden=1')).statusCode).toBe(403);
    expect((await send('PUT', '/api/canvases', { name: 'x', nodes: [], edges: [], hidden: true })).statusCode).toBe(403);
    expect((await send('PUT', `/api/canvases/${pm.id}`, { name: 'overwrite', nodes: [], edges: [] })).statusCode).toBe(404);
    // Deleting while locked leaves it alone.
    await app.inject({ method: 'DELETE', url: `/api/canvases/${pm.id}`, ...screen });
    expect(db.prepare('SELECT count(*) AS n FROM canvases WHERE id = ?').get(pm.id)).toEqual({ n: 1 });
  });

  it('a hidden workflow writes the hidden memory, never the normal one; its runs only show while unlocked', async () => {
    await send('POST', '/api/unlock', { on: true });
    const g = chain(node('i', 'input'), node('w', 'writeMemory', { memoryPath: 'secret/a.md', memoryMode: 'replace' }), node('o', 'output'));
    const c = (await send('PUT', '/api/canvases', { name: 'Secret', ...g, hidden: true })).json() as Canvas;
    expect(c.hidden).toBe(true);
    const start = await send('POST', '/api/runs', { canvasId: c.id, question: 'hidden text' });
    const { runId } = start.json() as { runId: string };
    for (let i = 0; i < 200 && (await get(`/api/runs/${runId}`)).statusCode !== 200; i++) await new Promise((r) => setTimeout(r, 10));
    expect(mem.read('u1', ['secret/a.md'], 'hidden')[0].content).toBe('hidden text');
    expect(mem.read('u1', ['secret/a.md'])[0].content).toBeUndefined();
    expect(((await get('/api/runs')).json() as { id: string }[]).some((r) => r.id === runId)).toBe(true);
    await send('POST', '/api/unlock', { on: false });
    expect(((await get('/api/runs')).json() as { id: string }[]).some((r) => r.id === runId)).toBe(false);
    expect((await get(`/api/runs/${runId}`)).statusCode).toBe(404);
  });
});
