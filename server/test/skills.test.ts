import type { Skill } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

/** Skills: a SKILL.md (+ text files) a block can follow, the same format as Claude skills. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let zip: typeof import('../src/services/zip.js');

const chats: { system: string; user: string }[] = [];
let reply: (system: string, user: string) => string = () => 'ok';
function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { role: string; content: string }[] };
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      chats.push({ system, user });
      return new Response(`${JSON.stringify({ message: { content: reply(system, user) } })}\n${JSON.stringify({ done: true })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
}

const SKILL_MD = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;
const importZip = (who: string, entries: { name: string; data: string | Buffer }[]) =>
  app.inject({ method: 'POST', url: '/api/skills/import', headers: { ...bearer(who), 'content-type': 'application/zip' }, payload: zip.createZip(entries) });
const list = async (who: string) => (await app.inject({ method: 'GET', url: '/api/skills', headers: bearer(who) })).json() as Skill[];
const M = { providerId: 'ollama', model: 'm' };

beforeAll(async () => {
  ({ app, db } = await testApp('skills', [
    ['admin', 'admin'],
    ['a', 'user'],
    ['b', 'user'],
  ]));
  zip = await import('../src/services/zip.js');
  db.prepare("UPDATE users SET profile_id = 'everything'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
});
beforeEach(() => {
  fakeOllama();
  chats.length = 0;
  reply = () => 'ok';
});
afterAll(() => app?.close());

describe('skills', () => {
  it('imports a zip with SKILL.md in a folder; keeps only text files', async () => {
    const res = await importZip('a', [
      { name: 'dark-report/SKILL.md', data: SKILL_MD('dark-report', 'Dark HTML reports with cards', 'Use a dark background (#0d1117) and cards.') },
      { name: 'dark-report/reference/colors.md', data: '- accent: #58a6ff' },
      { name: 'dark-report/scripts/make.py', data: 'print("never run")' },
      { name: 'dark-report/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
      { name: 'dark-report/tool.exe', data: 'MZ' },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const { skill, skipped } = res.json() as { skill: Skill; skipped: string[] };
    expect(skill).toMatchObject({ name: 'dark-report', description: 'Dark HTML reports with cards', mine: true, shared: false });
    expect(skill.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'reference/colors.md', 'scripts/make.py']);
    expect(skipped.sort()).toEqual(['logo.png', 'tool.exe']);
  });

  it('refuses a SKILL.md without name or description', async () => {
    expect((await importZip('a', [{ name: 'SKILL.md', data: '# no frontmatter' }])).statusCode).toBe(400);
    expect((await importZip('a', [{ name: 'SKILL.md', data: '---\nname: x\n---\nbody' }])).statusCode).toBe(400);
    expect((await importZip('a', [{ name: 'readme.md', data: 'hi' }])).statusCode).toBe(400);
  });

  it("a user can't see another user's unshared skill; a shared one every user can use", async () => {
    await importZip('a', [{ name: 'SKILL.md', data: SKILL_MD('secret-style', 'My style', 'Only for me') }]);
    const mine = (await list('a')).find((s) => s.name === 'secret-style')!;
    expect((await list('b')).some((s) => s.name === 'secret-style')).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/skills/${mine.id}`, headers: bearer('b') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/skills/${mine.id}`, headers: bearer('b') })).statusCode).toBe(404);
    // Only an admin shares.
    expect((await app.inject({ method: 'PUT', url: `/api/skills/${mine.id}/shared`, headers: bearer('a'), payload: { shared: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/skills/${mine.id}/shared`, headers: bearer('admin'), payload: { shared: true } })).statusCode).toBe(200);
    const seen = (await list('b')).find((s) => s.name === 'secret-style')!;
    expect(seen).toMatchObject({ shared: true, mine: false });
    // Shared is not editable by others.
    expect((await app.inject({ method: 'PUT', url: `/api/skills/${mine.id}/file`, headers: bearer('b'), payload: { path: 'x.md', text: 'x' } })).statusCode).toBe(404);
  });

  it('Fixed puts the skill in the system prompt and the run says so', async () => {
    await importZip('b', [{ name: 'SKILL.md', data: SKILL_MD('pirate', 'Talk like a pirate', 'Always say Arr.') }]);
    const graph = chain(node('q', 'input'), node('l', 'llm', { model: M, system: 'Be short.', skills: ['pirate'] }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'Hello', graph }, 'b');
    expect(run.status).toBe('done');
    expect(chats[0].system).toMatch(/^Be short\.\n\nUse these skills[\s\S]*## Skill: pirate[\s\S]*Always say Arr\./);
    expect(run.events.some((e) => e.type === 'node_progress' && e.note === 'Skills loaded: pirate')).toBe(true);
  });

  it('Auto lets the model pick from the list, then loads only that skill', async () => {
    await importZip('b', [{ name: 'SKILL.md', data: SKILL_MD('poems', 'Write in rhyme', 'Rhyme every line.') }]);
    reply = (system) => (/pick which skills/.test(system) ? 'poems' : 'done');
    const graph = chain(node('q', 'input'), node('l', 'llm', { model: M, skillMode: 'auto' }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'A poem about rain', graph }, 'b');
    expect(run.final).toBe('done');
    expect(chats).toHaveLength(2);
    expect(chats[0].user).toMatch(/- pirate: Talk like a pirate[\s\S]*- poems: Write in rhyme/);
    expect(chats[1].system).toContain('Rhyme every line.');
    expect(chats[1].system).not.toContain('Always say Arr.');
  });

  it('a limited API token can use skills but not change them', async () => {
    db.prepare('UPDATE api_tokens SET scope = ? WHERE id = ?').run(JSON.stringify({ canvases: ['x'], memory: [] }), 't-a');
    const res = await app.inject({ method: 'POST', url: '/api/skills', headers: bearer('a'), payload: { skillMd: SKILL_MD('nope', 'x', 'y') } });
    expect(res.statusCode).toBe(403);
    db.prepare('UPDATE api_tokens SET scope = NULL WHERE id = ?').run('t-a');
  });
});
