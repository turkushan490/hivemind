import type { Skill } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

/** Unlock mode: locked skills only show for their owner while unlocked, are never shared, and only hidden runs use them. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let unlock: typeof import('../src/services/unlock.js');
let skills: typeof import('../src/services/skills.js');

const screen = { cookies: { hm_session: 'screen' } };
const MD = (name: string) => `---\nname: ${name}\ndescription: test skill ${name}\n---\nSay the word ${name.toUpperCase()}.`;
const names = async (auth: object = screen) => ((await app.inject({ method: 'GET', url: '/api/skills', ...auth })).json() as Skill[]).map((s) => s.name);

beforeAll(async () => {
  ({ app, db } = await testApp('hiddenskills', [
    ['u1', 'admin'],
    ['u2', 'admin'],
  ]));
  unlock = await import('../src/services/unlock.js');
  skills = await import('../src/services/skills.js');
  const { sha256 } = await import('../src/crypto.js');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('screen'), 'u1', Date.now() + 3_600_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('other'), 'u2', Date.now() + 3_600_000);
});
afterAll(() => app.close());

describe('locked skills', () => {
  it('a new locked skill needs unlock mode; then only its owner sees it, only while unlocked', async () => {
    unlock.setUnlocked({ id: 'u1' }, false);
    expect((await app.inject({ method: 'POST', url: '/api/skills?hidden=1', ...screen, payload: { skillMd: MD('secret-one') } })).statusCode).toBe(403);
    expect(await names()).not.toContain('secret-one'); // nothing was made

    unlock.setUnlocked({ id: 'u1' }, true);
    const made = await app.inject({ method: 'POST', url: '/api/skills?hidden=1', ...screen, payload: { skillMd: MD('secret-one') } });
    expect(made.statusCode).toBe(200);
    const id = (made.json() as { skill: Skill }).skill.id;
    expect((made.json() as { skill: Skill }).skill.hidden).toBe(true);
    await app.inject({ method: 'POST', url: '/api/skills/import?hidden=1', ...screen, payload: { text: MD('secret-two') } });
    await app.inject({ method: 'POST', url: '/api/skills', ...screen, payload: { skillMd: MD('open-one') } });
    const list = (await app.inject({ method: 'GET', url: '/api/skills', ...screen })).json() as Skill[];
    expect(list.slice(0, 2).map((s) => s.name).sort()).toEqual(['secret-one', 'secret-two']); // locked first
    expect(list.find((s) => s.name === 'open-one')?.hidden).toBeUndefined();

    // Locked: gone, and "not found" when opened or edited.
    unlock.setUnlocked({ id: 'u1' }, false);
    expect(await names()).toEqual(['open-one']);
    expect((await app.inject({ method: 'GET', url: `/api/skills/${id}`, ...screen })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/skills/${id}/file`, ...screen, payload: { path: 'SKILL.md', text: MD('x') } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/skills/${id}/hidden`, ...screen, payload: { hidden: false } })).statusCode).toBe(403);

    // Another admin (also unlocked) and API tokens never see it; it can't be shared.
    unlock.setUnlocked({ id: 'u2' }, true);
    expect(await names({ cookies: { hm_session: 'other' } })).toEqual(['open-one']);
    expect(await names({ headers: bearer('u1') })).toEqual(['open-one']);
    await app.inject({ method: 'PUT', url: `/api/skills/${id}/shared`, ...screen, payload: { shared: true } });
    expect((db.prepare('SELECT shared FROM skills WHERE id = ?').get(id) as { shared: number }).shared).toBe(0);
  });

  it('lock and unlock a skill (only while unlocked); locking stops sharing it', async () => {
    unlock.setUnlocked({ id: 'u1' }, true);
    const open = ((await app.inject({ method: 'GET', url: '/api/skills', ...screen })).json() as Skill[]).find((s) => s.name === 'open-one')!;
    await app.inject({ method: 'PUT', url: `/api/skills/${open.id}/shared`, ...screen, payload: { shared: true } });
    const locked = await app.inject({ method: 'PUT', url: `/api/skills/${open.id}/hidden`, ...screen, payload: { hidden: true } });
    expect((locked.json() as Skill).hidden).toBe(true);
    expect((locked.json() as Skill).shared).toBe(false);
    unlock.setUnlocked({ id: 'u1' }, false);
    expect(await names()).not.toContain('open-one');
    unlock.setUnlocked({ id: 'u1' }, true);
    expect(((await app.inject({ method: 'PUT', url: `/api/skills/${open.id}/hidden`, ...screen, payload: { hidden: false } })).json() as Skill).hidden).toBeUndefined();
    unlock.setUnlocked({ id: 'u1' }, false);
    expect(await names()).toContain('open-one');
  });

  it('only a hidden run gets the locked skills', () => {
    const normal = skills.skillsForRun({ id: 'u1', role: 'admin' }).list().map((s) => s.name);
    const hidden = skills.skillsForRun({ id: 'u1', role: 'admin' }, { hidden: true }).list().map((s) => s.name);
    expect(normal).toEqual(['open-one']);
    expect(hidden.sort()).toEqual(['open-one', 'secret-one', 'secret-two']);
    expect(skills.skillsForRun({ id: 'u1', role: 'admin' }).load('secret-one')).toBeUndefined();
    expect(skills.skillsForRun({ id: 'u1', role: 'admin' }, { hidden: true }).load('secret-one')).toContain('SECRET-ONE');
    // Someone else's hidden run never gets u1's locked skills.
    expect(skills.skillsForRun({ id: 'u2', role: 'admin' }, { hidden: true }).list().map((s) => s.name)).not.toContain('secret-one');
  });
});
