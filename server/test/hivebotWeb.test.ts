import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let rulesMod: typeof import('../src/services/hivebotRules.js');
let sess: typeof import('../src/services/hivebotSessions.js');
const seed = (f: string) => readFileSync(join(__dirname, '..', 'hivebot', 'rules', f), 'utf8');

beforeAll(async () => {
  ({ app } = await testApp('hivebotweb'));
  rulesMod = await import('../src/services/hivebotRules.js');
  sess = await import('../src/services/hivebotSessions.js');
});
afterAll(() => app.close());

const rules = () => {
  const r = rulesMod.parseRules(seed('names.md'), seed('listening.md'));
  return { version: 'x', ...r.rules };
};
const fresh = (id = 's') => sess.sessionFor('u1', `${id}-${Math.random()}`, { kind: 'browser', who: 'test' });

describe('HiveBot rules as MD (H31)', () => {
  it('reads the seed files: names, word starts, settings, noise, one word, additions, kinds', () => {
    const { rules: r, problems } = rulesMod.parseRules(seed('names.md'), seed('listening.md'));
    expect(problems).toEqual([]);
    expect(r.names.jeff).toBe('jev');
    expect(r.names.travis).toBe('jarvis');
    expect(r.prefixes).toContainEqual({ starts: ['ultr', 'altr', 'oltr'], min: 5, max: 9, character: 'ultron' });
    expect(r.settings).toMatchObject({ defaultCharacter: 'vision', followUpSeconds: 60, silenceMs: 1800, tvWords: 60 });
    expect(r.noise).toContain('thanks for watching');
    expect(r.oneWord).toContain('stop');
    expect(r.additions.starts).toContain('oh and');
    expect(r.additions.shortStarts).toContain('tomorrow');
    expect(r.kinds.weather).toContain('forecast');
    expect(r.kinds.web).toContain('look up');
  });

  it('a broken line is a problem with its line number, an unknown character too', () => {
    const { problems } = rulesMod.parseRules('## Jev\n- jev → jev\n- jak jev\n- bob → robert', seed('listening.md'));
    expect(problems).toEqual(['names.md line 3: no → in "jak jev"', 'names.md line 4: unknown character "robert"']);
  });

  it('GET /api/robot/rules writes the first version into memory and keeps the last good one when a file breaks', async () => {
    const first = (await app.inject({ method: 'GET', url: '/api/robot/rules', headers: bearer() })).json();
    expect(first.names.jeff).toBe('jev');
    const mem = await import('../src/services/memoryFiles.js');
    expect(mem.read('u1', ['hivebot/rules/names.md'])[0].content).toContain('## Jev');
    mem.write('u1', 'hivebot/rules/names.md', `${mem.read('u1', ['hivebot/rules/names.md'])[0].content}\n- jak jev\n`);
    const broken = (await app.inject({ method: 'GET', url: '/api/robot/rules', headers: bearer() })).json();
    expect(broken.version).toBe(first.version);
    expect(broken.problems[0]).toMatch(/no →/);
  });
});

describe('Who answers (H32) and sessions (H30)', () => {
  it('a name in the first 5 words picks the character and is cut off the question', () => {
    const p = sess.pickCharacter(fresh(), 'Hey Jeff, turn on the osan light', rules(), { robot: false });
    expect(p).toMatchObject({ character: 'jev', named: true, question: 'turn on the osan light' });
    expect(sess.pickCharacter(fresh(), 'okay ultrono what is the plan', rules(), { robot: false }).character).toBe('ultron');
  });

  it('no name: the follow-up window keeps the character, else the default (Vision)', () => {
    const s = fresh();
    const r = rules();
    const a = sess.pickCharacter(s, 'Jarvis, is the door locked?', r, { robot: true });
    sess.recordTurn(s, a.character, a.question, 'Yes.');
    expect(sess.pickCharacter(s, 'and the window?', r, { robot: true }).character).toBe('jarvis');
    s.lastAnswerAt = Date.now() - 120_000;
    expect(sess.pickCharacter(s, 'what time is it', r, { robot: true }).character).toBe('vision');
  });

  it('noise and the TV are skipped; weather/web words set what is needed; Friday only on the robot', () => {
    const r = rules();
    expect(sess.pickCharacter(fresh(), 'Thanks for watching!', r, { robot: true }).skip).toBe('noise');
    expect(sess.pickCharacter(fresh(), '[music]', r, { robot: true }).skip).toBe('noise');
    expect(sess.pickCharacter(fresh(), 'banana', r, { robot: true }).skip).toBe('noise');
    expect(sess.pickCharacter(fresh(), Array(61).fill('word').join(' '), r, { robot: true }).skip).toBe('tv');
    expect(sess.pickCharacter(fresh(), 'Jev, what is the weather tomorrow', r, { robot: true }).need).toBe('weather');
    expect(sess.pickCharacter(fresh(), 'Jarvis, what is the weather tomorrow', r, { robot: true }).need).toBe('web');
    expect(sess.pickCharacter(fresh(), 'Friday, lights off', r, { robot: false }).answer).toMatch(/only works on the robot/);
  });

  it('try a sentence shows the pick; sessions are listed and can be stopped', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/robot/rules/try', headers: bearer(), payload: { text: 'hey jarvas lock the door' } })).json();
    expect(t).toMatchObject({ character: 'jarvis', question: 'lock the door' });
    sess.sessionFor('u1', 'tab-1', { kind: 'browser', who: 'user_u1' });
    const list = (await app.inject({ method: 'GET', url: '/api/robot/sessions', headers: bearer() })).json();
    expect(list.sessions.some((x: { id: string }) => x.id === 'tab-1')).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: '/api/robot/sessions/tab-1', headers: bearer() })).json()).toEqual({ ok: true });
  });

  it('/v1 with a session and noise answers at once without running the canvas', async () => {
    const { db } = await import('../src/db/index.js');
    db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('hb', 'u1', 'HiveBot', ?)").run(
      JSON.stringify({ nodes: [{ id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} }, { id: 't', type: 'template', position: { x: 1, y: 0 }, config: { prompt: '{{session.character}}: {{question}}' } }, { id: 'o', type: 'output', position: { x: 2, y: 0 }, config: {} }], edges: [{ id: 'e1', source: 'q', target: 't' }, { id: 'e2', source: 't', target: 'o' }] }),
    );
    const noise = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'hb', messages: [{ role: 'user', content: 'thank you' }], hivemind_vars: { session: 'tab-9', character: 'auto' } } })).json();
    expect(noise.hivemind.skip).toBe('noise');
    const ok = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'hb', messages: [{ role: 'user', content: 'Ghost, how are you' }], hivemind_vars: { session: 'tab-9', character: 'auto' } } })).json();
    expect(ok.choices[0].message.content).toBe('ghost: how are you');
    expect(ok.hivemind).toMatchObject({ character: 'ghost', question: 'how are you' });
    // A follow-up without a name stays with Ghost (the session keeps who answered).
    const next = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'hb', messages: [{ role: 'user', content: 'and tomorrow?' }], hivemind_vars: { session: 'tab-9' } } })).json();
    expect(next.choices[0].message.content).toBe('ghost: and tomorrow?');
  });
});
