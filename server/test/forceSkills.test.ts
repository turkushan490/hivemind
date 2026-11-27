import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

/** Skills in Force mode: the skills go first, a reminder ends the user message, and one check may correct the answer. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let zip: typeof import('../src/services/zip.js');

const chats: { system: string; user: string; json: boolean; messages: { role: string; content: string }[] }[] = [];
let reply: (system: string, user: string) => string = () => 'ok';
function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { role: string; content: string }[]; format?: unknown };
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      chats.push({ system, user, json: !!body.format, messages: body.messages });
      let text: string;
      try {
        text = reply(system, user);
      } catch {
        return new Response('boom', { status: 500 });
      }
      return new Response(`${JSON.stringify({ message: { content: text } })}\n${JSON.stringify({ done: true })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
}

const SKILL_MD = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;
const M = { providerId: 'ollama', model: 'm' };
const isCheck = (system: string) => system.startsWith('You check an answer against the rules');
const graph = (config: Record<string, unknown> = {}) =>
  chain(node('q', 'input'), node('l', 'llm', { model: M, system: 'Use 20 steps and cfg 7.', skills: ['comfy-prompt'], skillMode: 'force', ...config }), node('o', 'output'));

beforeAll(async () => {
  ({ app, db } = await testApp('forceskills', [['b', 'user']]));
  zip = await import('../src/services/zip.js');
  db.prepare("UPDATE users SET profile_id = 'everything'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
  fakeOllama();
  const res = await app.inject({
    method: 'POST',
    url: '/api/skills/import',
    headers: { ...bearer('b'), 'content-type': 'application/zip' },
    payload: zip.createZip([{ name: 'SKILL.md', data: SKILL_MD('comfy-prompt', 'Image prompts', '# Settings\n\n- Always use 30 steps.\n- Use cfg 4.5.\n- End with the word DONE.') }]),
  });
  expect(res.statusCode).toBe(200);
});
beforeEach(() => {
  fakeOllama();
  chats.length = 0;
  reply = () => 'ok';
});
afterAll(() => app?.close());

const notes = (run: { events: { type: string; note?: string }[] }) => run.events.filter((e) => e.type === 'node_progress').map((e) => e.note);

describe('force skills', () => {
  it('puts the skills first in the system prompt and a reminder at the end of the user message', async () => {
    reply = (system) => (isCheck(system) ? '{"ok": true, "broken": []}' : 'steps 30, cfg 4.5 DONE');
    const run = await runAndWait(app, { question: 'A cat on a roof', graph: graph() }, 'b');
    expect(run.status).toBe('done');
    const first = chats[0];
    expect(first.system).toMatch(/^SKILLS: the person's own instructions[\s\S]*## Skill: comfy-prompt[\s\S]*Always use 30 steps\.[\s\S]*Use 20 steps and cfg 7\.$/);
    expect(first.user).toMatch(/^A cat on a roof\n\nREMINDER: [\s\S]*- Follow skill comfy-prompt: Always use 30 steps\.; Use cfg 4\.5\.; End with the word DONE\.$/);
  });

  it('a check that finds a broken rule asks once more, and the corrected answer is the one used', async () => {
    reply = (system, user) => {
      if (isCheck(system)) return '{"ok": false, "broken": ["Uses 20 steps, the skill says 30"]}';
      return /breaks these rules/.test(user) ? 'steps 30, cfg 4.5 DONE' : 'steps 20, cfg 7';
    };
    const run = await runAndWait(app, { question: 'A dog', graph: graph() }, 'b');
    expect(run.status).toBe('done');
    expect(run.final).toBe('steps 30, cfg 4.5 DONE');
    expect(chats).toHaveLength(3);
    expect(chats[1].json).toBe(true);
    expect(chats[1].user).toContain('Answer:\nsteps 20, cfg 7');
    expect(chats[2].user).toContain('- Uses 20 steps, the skill says 30');
    expect(chats[2].messages.at(-2)).toEqual({ role: 'assistant', content: 'steps 20, cfg 7' });
    expect(notes(run)).toContain('Skills: fixed 1 rule');
    // The check's tokens are not shown; the corrected answer starts the shown text over.
    const tokens = run.events.filter((e) => e.type === 'token');
    expect(tokens.map((t) => t.text).join('')).not.toContain('"ok"');
    expect(tokens.find((t) => t.text === 'steps 30, cfg 4.5 DONE')?.replace).toBe(true);
    expect(run.events.find((e) => e.type === 'node_done' && e.nodeId === 'l')?.text).toBe('steps 30, cfg 4.5 DONE');
  });

  it('a check that says ok means no retry', async () => {
    reply = (system) => (isCheck(system) ? '{"ok": true, "broken": []}' : 'steps 30, cfg 4.5 DONE');
    const run = await runAndWait(app, { question: 'A bird', graph: graph() }, 'b');
    expect(run.final).toBe('steps 30, cfg 4.5 DONE');
    expect(chats).toHaveLength(2);
    expect(notes(run)).toContain('Skills checked: ok');
  });

  it('a check call that fails keeps the first answer', async () => {
    reply = (system) => {
      if (isCheck(system)) throw new Error('down');
      return 'first answer';
    };
    const run = await runAndWait(app, { question: 'A fish', graph: graph() }, 'b');
    expect(run.status).toBe('done');
    expect(run.final).toBe('first answer');
    expect(chats.filter((c) => !isCheck(c.system))).toHaveLength(1);
    expect(notes(run).some((n) => /^Skills check failed .*kept the first answer$/.test(n ?? ''))).toBe(true);
  });

  it('a check that is not JSON keeps the first answer too', async () => {
    reply = (system) => (isCheck(system) ? 'looks fine to me' : 'first answer');
    const run = await runAndWait(app, { question: 'A horse', graph: graph() }, 'b');
    expect(run.final).toBe('first answer');
    expect(chats.filter((c) => !isCheck(c.system))).toHaveLength(1);
  });

  it('Fixed mode stays as it was: skills after the block prompt, no reminder, no check', async () => {
    const run = await runAndWait(app, { question: 'A cow', graph: graph({ skillMode: 'fixed' }) }, 'b');
    expect(run.final).toBe('ok');
    expect(chats).toHaveLength(1);
    expect(chats[0].system).toMatch(/^Use 20 steps and cfg 7\.\n\nSKILLS:/);
    expect(chats[0].user).toBe('A cow');
  });

  it('Judge and Review follow forced skills too', async () => {
    reply = (system) => (isCheck(system) ? '{"ok": true, "broken": []}' : 'verdict');
    const g = chain(node('q', 'input'), node('a', 'llm', { model: M }), node('j', 'judge', { model: M, skills: ['comfy-prompt'], skillMode: 'force' }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'A pig', graph: g }, 'b');
    expect(run.final).toBe('verdict');
    const judge = chats.find((c) => c.system.startsWith('SKILLS:'))!;
    expect(judge.user).toContain('- Follow skill comfy-prompt:');
    expect(chats.some((c) => isCheck(c.system))).toBe(true);

    chats.length = 0;
    const r = chain(node('q', 'input'), node('a', 'llm', { model: M }), node('r', 'review', { model: M, skills: ['comfy-prompt'], skillMode: 'force' }), node('o', 'output'));
    expect((await runAndWait(app, { question: 'A goat', graph: r }, 'b')).final).toBe('verdict');
    expect(chats.find((c) => c.system.startsWith('SKILLS:'))?.user).toContain('- Follow skill comfy-prompt:');
  });
});
