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

  it('fills in a missing name or description instead of refusing', async () => {
    const a = (await importZip('a', [{ name: 'notes/SKILL.md', data: '# Release notes\n\nWrite short release notes from a git log.' }])).json() as { skill: Skill };
    expect(a.skill).toMatchObject({ name: 'notes', description: 'Write short release notes from a git log.' });
    const b = (await importZip('a', [{ name: 'SKILL.md', data: '---\nname: "Build: GPT → local"\n---\nPlan first. Then build.' }])).json() as { skill: Skill };
    expect(b.skill).toMatchObject({ name: 'Build- GPT - local', description: 'Plan first.' });
    const md = (await app.inject({ method: 'GET', url: `/api/skills/${b.skill.id}/file?path=SKILL.md`, headers: bearer('a') })).json().text as string;
    expect(md).toMatch(/^---\nname: Build- GPT - local\ndescription: "Plan first\."\n---\n\nPlan first\. Then build\.\n$/);
    // Empty or binary only: still refused, with a reason.
    expect((await importZip('a', [{ name: 'SKILL.md', data: '' }])).statusCode).toBe(400);
    expect((await importZip('a', [{ name: 'a.png', data: Buffer.from([0x89, 0x50, 0, 1]) }])).json().error).toMatch(/No text file/);
  });

  const upload = (who: string, body: string | Buffer, name: string) =>
    app.inject({ method: 'POST', url: `/api/skills/import?name=${encodeURIComponent(name)}`, headers: { ...bearer(who), 'content-type': 'application/octet-stream' }, payload: body });
  const added = (res: { statusCode: number; body: string; json: () => unknown }) => {
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { skills: Skill[] }).skills;
  };

  it('reads skills from Claude, Codex, OpenCode/T3, Cursor, Copilot, Gemini, GPT JSON and plain text', async () => {
    // Codex / T3 Code: SKILL.md with a wrapped description, agents/openai.yaml and a script.
    const codex = added(
      await importZip('a', [
        { name: 'build/SKILL.md', data: '---\nname: build\ndescription: Voer een taak uit met GPT,\n  een lokaal model en Claude.\nallowed-tools: Read\n---\n# Build\nStap 1.' },
        { name: 'build/agents/openai.yaml', data: 'interface:\n  display_name: "Build"\n  short_description: "GPT → lokaal → Claude"\n' },
        { name: 'build/assets/icon.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]) },
      ]),
    );
    expect(codex[0]).toMatchObject({ name: 'build', description: 'Voer een taak uit met GPT, een lokaal model en Claude.' });
    expect(codex[0].files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'agents/openai.yaml']);
    // A single SKILL.md or .md, uploaded as it is (no zip).
    expect(added(await upload('a', SKILL_MD('touch', 'Touch screen helper', 'Tap big buttons.'), 'SKILL.md'))[0]).toMatchObject({ name: 'touch', description: 'Touch screen helper' });
    expect(added(await upload('a', 'Always answer in Dutch.\n\nKeep it short.', 'dutch-answers.md'))[0]).toMatchObject({ name: 'dutch-answers', description: 'Always answer in Dutch.' });
    // Cursor rule (.mdc), Copilot prompt file, Gemini CLI command (TOML).
    expect(added(await upload('a', '---\ndescription: React component rules\nglobs: "*.tsx"\nalwaysApply: false\n---\nUse function components.', 'react.mdc'))[0]).toMatchObject({
      name: 'react',
      description: 'React component rules',
    });
    expect(added(await upload('a', "---\nmode: 'agent'\ndescription: 'Review a pull request'\n---\nRead the diff first.", 'review.prompt.md'))[0]).toMatchObject({ name: 'review' });
    expect(added(await upload('a', 'description = "Explain code"\nprompt = """\nExplain this code simply.\n"""\n', 'explain.toml'))[0]).toMatchObject({
      name: 'explain',
      description: 'Explain code',
    });
    // A ChatGPT GPT / OpenAI assistant export.
    const gpt = added(await upload('a', JSON.stringify({ gizmo: { display: { name: 'Prompt Pal', description: 'Writes image prompts' }, instructions: 'Ask for the subject, then write a prompt.' } }), 'gpt.json'));
    expect(gpt[0]).toMatchObject({ name: 'Prompt Pal', description: 'Writes image prompts' });
    const pal = (await app.inject({ method: 'GET', url: `/api/skills/${gpt[0].id}/file?path=SKILL.md`, headers: bearer('a') })).json().text as string;
    expect(pal).toContain('Ask for the subject, then write a prompt.');
    // XML-style tags (as some chat apps write skills), uploaded as skill.md.
    const xml = added(
      await upload(
        'a',
        '<skill>\n  <name>name based prompt maker</name>\n  <description>Prompts with ${main} &amp; ${main2} characters.</description>\n  <instructions>\n  1. Define ${main=man standing} first.\n  2. Then use ${main} by name.\n  </instructions>\n</skill>\n',
        'skill.md',
      ),
    );
    expect(xml[0]).toMatchObject({ name: 'name based prompt maker', description: 'Prompts with ${main} & ${main2} characters.' });
    const xmlMd = (await app.inject({ method: 'GET', url: `/api/skills/${xml[0].id}/file?path=SKILL.md`, headers: bearer('a') })).json().text as string;
    expect(xmlMd).toContain('\n\n1. Define ${main=man standing} first.\n2. Then use ${main} by name.\n');
    expect(xmlMd).not.toContain('<instructions>');
    // Pasted text.
    const pasted = await app.inject({ method: 'POST', url: '/api/skills/import', headers: bearer('a'), payload: { text: 'You are a strict code reviewer. Point out bugs.', name: 'strict reviewer' } });
    expect(added(pasted)[0]).toMatchObject({ name: 'strict reviewer', description: 'You are a strict code reviewer.' });
  });

  it('a repo-style zip, a folder upload or a .tar.gz with many skills adds them all', async () => {
    const many = added(
      await importZip('b', [
        { name: 'repo/README.md', data: '# My skills' },
        { name: 'repo/skills/one/SKILL.md', data: SKILL_MD('one', 'First', 'Do one.') },
        { name: 'repo/skills/two/SKILL.md', data: SKILL_MD('two', 'Second', 'Do two.') },
        { name: 'repo/skills/two/ref/SKILL.md', data: SKILL_MD('inner', 'Nested', 'Part of two.') },
      ]),
    );
    expect(many.map((s) => s.name).sort()).toEqual(['one', 'two']);
    expect(many.find((s) => s.name === 'two')!.files.map((f) => f.path)).toContain('ref/SKILL.md');
    // Claude agents folder: one skill per file; the README is not one.
    const agents = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      headers: bearer('b'),
      payload: {
        files: [
          { path: 'agents/README.md', text: '# Agents' },
          { path: 'agents/planner.md', text: '---\nname: planner\ndescription: Plans work\ntools: Read\n---\nMake a plan.' },
          { path: 'agents/tester.md', text: '---\nname: tester\ndescription: Writes tests\n---\nWrite tests.' },
        ],
      },
    });
    expect(added(agents).map((s) => s.name).sort()).toEqual(['planner', 'tester']);
    // A folder with AGENTS.md: one skill named after the folder.
    const folder = await app.inject({
      method: 'POST',
      url: '/api/skills/import',
      headers: bearer('b'),
      payload: { files: [{ path: 'house-style/AGENTS.md', text: 'Use tabs.' }, { path: 'house-style/examples.md', text: 'x' }] },
    });
    expect(added(folder)[0]).toMatchObject({ name: 'house-style', description: 'Use tabs.' });
    // .tar.gz
    const { gzipSync } = await import('node:zlib');
    const tar = (files: { name: string; data: string }[]) => {
      const parts: Buffer[] = [];
      for (const f of files) {
        const h = Buffer.alloc(512);
        h.write(f.name, 0);
        h.write('0000644\0', 100);
        h.write(`${Buffer.byteLength(f.data).toString(8).padStart(11, '0')}\0`, 124);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        h.fill(' ', 148, 156);
        let sum = 0;
        for (const x of h) sum += x;
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        const body = Buffer.alloc(Math.ceil(Buffer.byteLength(f.data) / 512) * 512);
        body.write(f.data);
        parts.push(h, body);
      }
      return Buffer.concat([...parts, Buffer.alloc(1024)]);
    };
    const tgz = gzipSync(tar([{ name: 'pack/alpha/SKILL.md', data: SKILL_MD('alpha', 'A', 'a') }, { name: 'pack/beta/skill.md', data: '# Beta\n\nBeta things here.' }]));
    expect(added(await upload('b', tgz, 'pack.tar.gz')).map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
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
