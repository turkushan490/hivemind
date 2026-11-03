import type { ApiCall, Project } from '@hivemind/shared';
import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

/**
 * Git for projects, against bare repos in a folder (HIVEMIND_GIT_REMOTE_BASE) instead of github.com. The token
 * must never reach .git/config, the logs, the API call log or an error.
 */

const TOKEN = 'ghp_TESTtoken1234567890abcdefXYZ';
const remotes = mkdtempSync(join(tmpdir(), 'hm-remotes-'));
process.env.HIVEMIND_GIT_REMOTE_BASE = remotes;

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Other', '-c', 'user.email=other@test', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });

function bareRepo(name: string) {
  const dir = join(remotes, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '--bare', '-b', 'main');
  return dir;
}

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let projects: typeof import('../src/services/projects.js');

const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, who = 'u1') =>
  app.inject({ method, url, headers: bearer(who), ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

beforeAll(async () => {
  ({ app, db } = await testApp('git', [
    ['u1', 'admin'],
    ['u2', 'user'],
  ]));
  projects = await import('../src/services/projects.js');
  const { encrypt } = await import('../src/crypto.js');
  db.prepare('INSERT INTO github_accounts (user_id, token_enc, last4, login, author_name, author_email) VALUES (?, ?, ?, ?, ?, ?)').run(
    'u1',
    encrypt(TOKEN),
    TOKEN.slice(-4),
    'me',
    'Site Owner',
    'owner@test',
  );
});
afterAll(() => app?.close());

describe('git for projects', () => {
  it('connects, commits and pushes; the token is never stored or shown', async () => {
    const bare = bareRepo('me/site');
    const p = (await api('POST', '/api/projects', { name: 'Git site' })).json() as Project;
    await api('PUT', `/api/projects/${p.id}/file?path=index.html`, { text: '<h1>Hi</h1>' });
    const conn = await api('POST', `/api/projects/${p.id}/git/connect`, { repo: 'me/site', branch: 'main' });
    expect(conn.statusCode, conn.body).toBe(200);

    // A workflow commits and pushes.
    const graph = chain(node('q', 'input'), node('git', 'git', { project: p.id, gitAction: 'commitPush', message: 'First page' }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'Publish', graph });
    expect(run.status, JSON.stringify(run.events.filter((e) => e.type === 'error'))).toBe('done');
    expect(run.final).toMatch(/Committed [0-9a-f]{7}: First page\. Pushed to main/);
    const log = g(bare, 'log', '--format=%an <%ae> %s', 'main');
    expect(log.trim()).toBe('Site Owner <owner@test> First page');

    const config = readFileSync(join(projects.rootOf(p), '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    expect(JSON.stringify(run.events)).not.toContain(TOKEN);
    const settings = (await api('GET', '/api/settings/github')).json();
    expect(settings).toEqual({ hasToken: true, last4: TOKEN.slice(-4), login: 'me', authorName: 'Site Owner', authorEmail: 'owner@test' });
    const calls = (await api('GET', '/api/activity/calls?limit=200')).json() as ApiCall[];
    expect(JSON.stringify(calls)).not.toContain(TOKEN);

    const status = (await api('GET', `/api/projects/${p.id}/git`)).json();
    expect(status).toMatchObject({ connected: true, repo: 'me/site', branch: 'main', changes: [], ahead: 0 });
  });

  it('a rejected push fails the block, never forces, and Pull brings the new commit', async () => {
    const bare = bareRepo('me/race');
    const p = (await api('POST', '/api/projects', { name: 'Race' })).json() as Project;
    await api('PUT', `/api/projects/${p.id}/file?path=a.txt`, { text: 'a' });
    await api('POST', `/api/projects/${p.id}/git/connect`, { repo: 'me/race' });
    expect((await api('POST', `/api/projects/${p.id}/git/commit`, { message: 'a' })).statusCode).toBe(200);
    expect((await api('POST', `/api/projects/${p.id}/git/push`)).statusCode).toBe(200);

    // Someone else pushes first.
    const other = mkdtempSync(join(tmpdir(), 'hm-other-'));
    g(other, 'clone', '-q', bare, '.');
    writeFileSync(join(other, 'b.txt'), 'b');
    g(other, 'add', '.');
    g(other, 'commit', '-q', '-m', 'theirs');
    g(other, 'push', '-q', 'origin', 'main');

    await api('PUT', `/api/projects/${p.id}/file?path=a.txt`, { text: 'mine' });
    const graph = chain(node('q', 'input'), node('git', 'git', { project: p.id, gitAction: 'commitPush', message: 'Mine' }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'x', graph });
    const error = run.events.find((e) => e.type === 'error' && e.nodeId === 'git')?.error ?? '';
    expect(error).toMatch(/git push failed/);
    expect(error).not.toContain(TOKEN);
    // GitHub still has their commit on top: nothing was forced.
    expect(g(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('theirs');

    // Pull puts our commit on top of theirs; then the push works.
    const pull = await api('POST', `/api/projects/${p.id}/git/pull`);
    expect(pull.statusCode, pull.body).toBe(200);
    expect((await api('GET', `/api/projects/${p.id}/file?path=b.txt`)).json()).toMatchObject({ text: 'b' });
    expect((await api('POST', `/api/projects/${p.id}/git/push`)).statusCode).toBe(200);
    expect(g(bare, 'log', '--format=%s', 'main').trim().split('\n')).toEqual(['Mine', 'theirs', 'a']);

    // The same lines changed on both sides: refused, nothing lost.
    g(other, 'pull', '-q', '--rebase', 'origin', 'main');
    writeFileSync(join(other, 'a.txt'), 'theirs again');
    g(other, 'commit', '-q', '-am', 'theirs 2');
    g(other, 'push', '-q', 'origin', 'main');
    await api('PUT', `/api/projects/${p.id}/file?path=a.txt`, { text: 'mine again' });
    const clash = await api('POST', `/api/projects/${p.id}/git/pull`);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toContain('a.txt');
    expect((await api('GET', `/api/projects/${p.id}/file?path=a.txt`)).json()).toMatchObject({ text: 'mine again' });
  });

  it('an empty project connected to a repo with commits gets its files; a project with files is refused', async () => {
    const bare = bareRepo('me/existing');
    const seed = mkdtempSync(join(tmpdir(), 'hm-seed-'));
    g(seed, 'clone', '-q', bare, '.');
    writeFileSync(join(seed, 'readme.md'), '# Hello');
    g(seed, 'add', '.');
    g(seed, 'commit', '-q', '-m', 'init');
    g(seed, 'push', '-q', 'origin', 'main');

    const empty = (await api('POST', '/api/projects', { name: 'Clone' })).json() as Project;
    const res = await api('POST', `/api/projects/${empty.id}/git/connect`, { repo: 'me/existing' });
    expect(res.json()).toMatchObject({ repo: 'me/existing', branch: 'main', cloned: true });
    expect((await api('GET', `/api/projects/${empty.id}/file?path=readme.md`)).json()).toMatchObject({ text: '# Hello' });

    const full = (await api('POST', '/api/projects', { name: 'Full' })).json() as Project;
    await api('PUT', `/api/projects/${full.id}/file?path=x.txt`, { text: 'x' });
    expect((await api('POST', `/api/projects/${full.id}/git/connect`, { repo: 'me/existing' })).statusCode).toBe(409);
  });

  it('passes when the project is not connected', async () => {
    const p = (await api('POST', '/api/projects', { name: 'Local only' })).json() as Project;
    const graph = chain(node('q', 'input'), node('git', 'git', { project: p.id }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'x', graph });
    expect(run.status).toBe('done');
    expect(run.final).toContain('not connected to GitHub');
  });

  it('masks the token in messages', async () => {
    const { mask } = await import('../src/services/git.js');
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(mask(`fatal: ${TOKEN} and ${basic}`, TOKEN)).toBe('fatal: *** and ***');
  });
});
