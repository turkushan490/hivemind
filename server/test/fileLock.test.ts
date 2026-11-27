import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

/** Lock or unlock one of your own files by hand (only while unlocked). */
let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let unlock: typeof import('../src/services/unlock.js');
const me = { cookies: { hm_session: 'me' } };
const other = { cookies: { hm_session: 'other' } };

beforeAll(async () => {
  ({ app, db } = await testApp('filelock', [
    ['u1', 'admin'],
    ['u2', 'admin'],
  ]));
  unlock = await import('../src/services/unlock.js');
  const { sha256 } = await import('../src/crypto.js');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('me'), 'u1', Date.now() + 3_600_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('other'), 'u2', Date.now() + 3_600_000);
});
afterAll(() => app.close());

const names = async (auth: object) => ((await app.inject({ method: 'GET', url: '/api/files', ...auth })).json() as { path: string }[]).map((f) => f.path);
const lock = (path: string, hidden: boolean, auth: object = me) => app.inject({ method: 'PUT', url: '/api/files/hidden', ...auth, payload: { path, hidden } });

describe('lock a file by hand', () => {
  it('needs unlock mode, only for your own file, and hides it from everyone else', async () => {
    const up = await app.inject({ method: 'POST', url: '/api/files?name=uploads/stray.png', ...me, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    const path = (up.json() as { path: string }).path;
    unlock.setUnlocked({ id: 'u1' }, false);
    expect((await lock(path, true)).statusCode).toBe(403);
    unlock.setUnlocked({ id: 'u1' }, true);
    unlock.setUnlocked({ id: 'u2' }, true);
    expect((await lock(path, true, other)).statusCode).toBe(404); // not theirs
    expect((await lock(path, true)).statusCode).toBe(200);
    expect(await names(other)).not.toContain(path);
    expect(await names(me)).toContain(path);
    unlock.setUnlocked({ id: 'u1' }, false);
    expect(await names(me)).not.toContain(path);
    unlock.setUnlocked({ id: 'u1' }, true);
    expect((await lock(path, false)).statusCode).toBe(200);
    expect(await names(other)).toContain(path); // a normal file again (admins see all)
  });
});
