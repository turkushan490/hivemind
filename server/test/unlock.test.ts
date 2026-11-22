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
    expect((await get('/api/unlock', { headers: bearer() })).json()).toMatchObject({ allowed: false, unlocked: false });
  });

  it('needs a PIN: set it first, a wrong one is refused, changing it needs the old one, 5 wrong tries block', async () => {
    expect((await send('POST', '/api/unlock', { on: true })).statusCode).toBe(409);
    expect((await send('POST', '/api/unlock/pin', { pin: '12' })).statusCode).toBe(400);
    expect((await send('POST', '/api/unlock/pin', { pin: '1234' })).statusCode).toBe(200);
    expect((await send('POST', '/api/unlock/pin', { pin: '9999' })).statusCode).toBe(403); // no old PIN
    expect((await send('POST', '/api/unlock/pin', { pin: '4321', old: '1234' })).statusCode).toBe(200);
    expect((await send('POST', '/api/unlock', { on: true, pin: '1234' })).statusCode).toBe(403);
    for (let i = 0; i < 4; i++) await send('POST', '/api/unlock', { on: true, pin: 'nope' });
    expect((await send('POST', '/api/unlock', { on: true, pin: '4321' })).statusCode).toBe(429);
    const { setUnlocked } = await import('../src/services/unlock.js');
    void setUnlocked;
  });

  it('locks by itself after 12 hours, and on log out', async () => {
    const unlock = await import('../src/services/unlock.js');
    const { setSetting } = await import('../src/db/index.js');
    setSetting('user:u1:unlocked', String(Date.now() - unlock.UNLOCK_MS - 1000));
    expect((await get('/api/unlock')).json()).toMatchObject({ unlocked: false });
    unlock.setUnlocked({ id: 'u1' }, true);
    const { sha256 } = await import('../src/crypto.js');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('other'), 'u1', Date.now() + 3_600_000);
    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { hm_session: 'other' } });
    expect((await get('/api/unlock')).json()).toMatchObject({ unlocked: false });
  });

  it('turning it on makes the hidden Prompt maker and hidden memory, outside the normal memory', async () => {
    mem.write('u1', 'notes/normal.md', 'normal note');
    // (the block from the test above is in memory: start fresh)
    const unlock = await import('../src/services/unlock.js');
    unlock.setUnlocked({ id: 'u1' }, true);
    expect((await get('/api/unlock')).json()).toMatchObject({ allowed: true, unlocked: true, hasPin: true });
    (await import('../src/api/unlock.js')).ensureUnlockedStart({ id: 'u1', username: 'user_u1', role: 'admin' } as never);
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
    (await import('../src/services/unlock.js')).setUnlocked({ id: 'u1' }, true);
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
