import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';

/** The Skill block: a workflow reads a skill, a model edits or writes one, the block saves it. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let unlock: typeof import('../src/services/unlock.js');
let skills: typeof import('../src/services/skills.js');
const screen = { cookies: { hm_session: 'screen' } };
let reply = '';
let lastPrompt = '';

beforeAll(async () => {
  ({ app, db } = await testApp('skillblock'));
  unlock = await import('../src/services/unlock.js');
  skills = await import('../src/services/skills.js');
  const { sha256 } = await import('../src/crypto.js');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('screen'), 'u1', Date.now() + 3_600_000);
  db.prepare("UPDATE users SET profile_id = 'everything'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { role: string; content: string }[] };
      lastPrompt = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      return new Response(`${JSON.stringify({ message: { content: reply } })}\n${JSON.stringify({ done: true })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
});
afterAll(() => app.close());

const graph = {
  nodes: [
    { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
    { id: 'r', type: 'skill', position: { x: 1, y: 0 }, config: {} },
    { id: 'm', type: 'llm', position: { x: 2, y: 0 }, config: { model: { providerId: 'ollama', model: 'qwen' }, prompt: '{{question}}\n\n{{inputs}}' } },
    { id: 's', type: 'skill', position: { x: 3, y: 0 }, config: { skillOp: 'save' } },
    { id: 'o', type: 'output', position: { x: 4, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 'q', target: 'r' },
    { id: 'e2', source: 'r', target: 'm' },
    { id: 'e3', source: 'm', target: 's' },
    { id: 'e4', source: 's', target: 'o' },
  ],
};

async function run(canvasId: string, question: string) {
  const start = await app.inject({ method: 'POST', url: '/api/runs', ...screen, payload: { canvasId, question } });
  if (start.statusCode !== 200) throw new Error(`start ${start.statusCode}: ${start.body}`);
  const id = (start.json() as { runId: string }).runId;
  for (let i = 0; i < 300; i++) {
    const r = db.prepare('SELECT status, final FROM runs WHERE id = ?').get(id) as { status: string; final: string | null } | undefined;
    if (r && r.status !== 'running') return r;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error('run did not finish');
}
const row = (name: string) => db.prepare('SELECT hidden, description FROM skills WHERE owner_id = ? AND name = ?').get('u1', name) as { hidden: number; description: string } | undefined;

describe('Skill block', () => {
  it('finds the SKILL.md in an answer and the skill a request names', async () => {
    // Loaded after the app (the block list imports this file).
    const { namedSkills, skillFromAnswer } = await import('../src/nodes/skill.js');
    expect(skillFromAnswer('Here you go:\n```markdown\n---\nname: a\ndescription: b\n---\nDo it.\n```\nEnjoy')).toBe('---\nname: a\ndescription: b\n---\nDo it.');
    expect(skillFromAnswer('Sure.\n---\nname: a\ndescription: b\n---\nx')).toBe('---\nname: a\ndescription: b\n---\nx');
    expect(namedSkills('edit my dark report skill please', ['dark-report', 'report', 'other'])).toEqual(['dark-report', 'report']);
    expect(namedSkills('make a new one', ['dark-report'])).toEqual([]);
  });

  it('a normal workflow makes and edits a normal skill', async () => {
    const c = (await app.inject({ method: 'PUT', url: '/api/canvases', ...screen, payload: { name: 'Skill maker', ...graph } })).json() as { id: string };
    reply = '```markdown\n---\nname: tidy-code\ndescription: Keep code tidy\n---\nUse short functions.\n```';
    expect((await run(c.id, 'make a skill for tidy code')).status).toBe('done');
    expect(lastPrompt).toContain('No existing skill is named in the request');
    expect(row('tidy-code')).toMatchObject({ hidden: 0, description: 'Keep code tidy' });

    reply = '---\nname: tidy-code\ndescription: Keep code tidy and typed\n---\nUse short functions and types.';
    const r = await run(c.id, 'edit my tidy code skill: also use types');
    expect(r.status).toBe('done');
    expect(lastPrompt).toContain('The skill "tidy-code" as it is now');
    expect(lastPrompt).toContain('Use short functions.');
    expect(r.final).toContain('Updated the skill "tidy-code"');
    expect(row('tidy-code')?.description).toBe('Keep code tidy and typed');
  });

  it('a hidden workflow reads locked skills and its new skills are locked; a normal one never changes a locked skill', async () => {
    unlock.setUnlocked({ id: 'u1' }, true);
    const c = (await app.inject({ method: 'PUT', url: '/api/canvases', ...screen, payload: { name: 'Skill maker (hidden)', hidden: true, ...graph } })).json() as { id: string };
    reply = '---\nname: secret-style\ndescription: My secret style\n---\nWrite like this.';
    expect((await run(c.id, 'make a skill for my secret style')).status).toBe('done');
    expect(row('secret-style')?.hidden).toBe(1);

    reply = '---\nname: secret-style\ndescription: My secret style v2\n---\nWrite like this, v2.';
    unlock.setUnlocked({ id: 'u1' }, true);
    expect((await run(c.id, 'edit secret style: v2')).status).toBe('done');
    expect(lastPrompt).toContain('Write like this.');
    expect(row('secret-style')).toMatchObject({ hidden: 1, description: 'My secret style v2' });

    // The normal workflow can't see it, and can't overwrite it.
    const normal = (db.prepare("SELECT id FROM canvases WHERE name = 'Skill maker'").get() as { id: string }).id;
    reply = '---\nname: secret-style\ndescription: overwritten\n---\nx';
    const r = await run(normal, 'edit secret style');
    expect(lastPrompt).not.toContain('Write like this');
    expect(r.status).toBe('error');
    expect(row('secret-style')?.description).toBe('My secret style v2');
    expect(skills.skillsForRun({ id: 'u1', role: 'admin' }).list().map((s) => s.name)).toEqual(['tidy-code']);
  });
});
