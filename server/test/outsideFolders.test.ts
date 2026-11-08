import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
// Another app's projects folder (T3 Code's /projects), with one project in it.
const root = mkdtempSync(join(tmpdir(), 'hm-t3-projects-'));
const site = join(root, 'my-site');

beforeAll(async () => {
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), '<h1>old</h1>');
  mkdirSync(join(site, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(site, 'node_modules', 'x', 'big.js'), 'x');
  ({ app } = await testApp('outside', [['u1', 'admin'], ['u2', 'user']]));
});
afterAll(() => app?.close());

const put = (body: object, who = 'u1') => app.inject({ method: 'PUT', url: '/api/outside-folders', headers: bearer(who), payload: body });

describe('folders of other apps (T3 Code projects)', () => {
  it('only admins set it up, and HiveMind refuses its own folders as roots', async () => {
    expect((await put({ enabled: true }, 'u2')).statusCode).toBe(403);
    expect((await put({ roots: ['/data'] })).statusCode).toBe(400);
    expect((await put({ roots: ['relative/path'] })).statusCode).toBe(400);
  });

  it('lists the other app\'s folders, opens one as a project in place, and HiveMind edits the same file', async () => {
    const set = await put({ enabled: true, roots: [root] });
    expect(set.statusCode).toBe(200);
    expect(set.json().list[0].folders.map((f: { name: string }) => f.name)).toEqual(['my-site']);
    const made = await app.inject({ method: 'POST', url: '/api/projects/outside', headers: bearer(), payload: { path: site } });
    expect(made.statusCode).toBe(200);
    const p = made.json() as { id: string; name: string; outside: string; files: number };
    expect(p.name).toBe('my-site');
    // node_modules is skipped: only index.html counts.
    expect(p.files).toBe(1);
    const w = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/file?path=index.html`, headers: bearer(), payload: { text: '<h1>new</h1>' } });
    expect(w.statusCode).toBe(200);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toBe('<h1>new</h1>');
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}/file?path=pages/about.html`, headers: bearer(), payload: { text: 'about' } });
    expect(readFileSync(join(site, 'pages', 'about.html'), 'utf8')).toBe('about');
    // The same folder can't become two projects; a folder outside the roots can't become one at all.
    expect((await app.inject({ method: 'POST', url: '/api/projects/outside', headers: bearer(), payload: { path: site } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/projects/outside', headers: bearer(), payload: { path: tmpdir() } })).statusCode).toBe(403);

    // Switched off: the project stays listed but can't be read or changed.
    await put({ enabled: false });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/file?path=index.html`, headers: bearer() })).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: '/api/projects', headers: bearer() })).json() as { id: string }[];
    expect(list.some((x) => x.id === p.id)).toBe(true);

    // Deleting the project leaves the other app's folder alone.
    await put({ enabled: true });
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: bearer() })).statusCode).toBe(200);
    expect(existsSync(join(site, 'index.html'))).toBe(true);
  });
});
