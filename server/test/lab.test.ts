import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import type { ChatRequest } from '../src/providers/types.js';
import { bearer, chain, fakeDecider, fakeProvider, node, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let lab: typeof import('../src/lab/runner.js');
let data: typeof import('../src/lab/data.js');

beforeAll(async () => {
  ({ app, db } = await testApp('lab'));
  lab = await import('../src/lab/runner.js');
  data = await import('../src/lab/data.js');
});
afterAll(() => app?.close());

const ref = (model: string) => ({ providerId: 'p', model });

/** Players act, the DM answers JSON (every 3rd turn it lets the cleric use Channel Divinity again), the judge rules. */
function sim(opts: { delay?: number; local?: boolean; log?: string[] } = {}) {
  let turn = 0;
  const reply = (req: ChatRequest) => {
    const sys = req.messages[0]?.content ?? '';
    if (req.model === 'dm') {
      turn++;
      opts.log?.push(`sim-dm-${turn}`);
      const cheat = turn % 3 === 0;
      return JSON.stringify({ narration: `Turn ${turn}: the hag shrieks.`, rolls: [{ pc: 'Brakka', kind: 'attack' }], resources: cheat ? [{ pc: 'Esvahanna', name: 'Channel Divinity' }] : [], hp: [], conditions: [], xp: 0 });
    }
    if (req.model === 'judge') {
      const user = req.messages.at(-1)?.content ?? '';
      return sys.includes('rules referee') && user.includes('"name":"Channel Divinity"')
        ? '{"errors":[{"type":"resource","detail":"overspent"}],"story":6,"corrected":{"narration":"fixed","rolls":[],"resources":[],"hp":[],"conditions":[],"xp":0}}'
        : '{"errors":[],"story":8}';
    }
    opts.log?.push('sim-player');
    return 'I attack!';
  };
  const base = fakeProvider(reply, { local: opts.local });
  const p: ResolvedProvider = {
    ...base,
    adapter: {
      ...base.adapter,
      async *stream(req, signal) {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        yield* base.adapter.stream(req, signal);
      },
    },
  };
  return p;
}

const cfg = (extra = {}) => ({ dm: [ref('dm')], players: ref('player'), judge: ref('judge'), partySize: 3, turnsPerGame: 5, maxTurns: 10, seed: 7, sample: 0, rulesKey: '', ...extra });

describe('Lab simulator', () => {
  it('a 10-turn sim with a fake provider gives 10 lab_turns and a valid JSONL', async () => {
    const p = sim();
    const run = lab.startLab('u1', cfg(), { resolve: async () => p });
    await run.done;
    expect(run.status.state).toBe('done');
    const turns = db.prepare('SELECT * FROM lab_turns WHERE run_id = ? ORDER BY id').all(run.id) as Record<string, any>[];
    expect(turns).toHaveLength(10);
    expect(turns.every((t) => t.json_valid === 1)).toBe(true);
    expect(run.status.games).toBe(2);
    // The input is exactly what the DM saw: the party state, the dice and the players' actions.
    expect(turns[0].input).toContain('Party state:\n');
    expect(turns[0].input).toMatch(/d20=\d+/);
    expect(turns[0].input).toContain('I attack!');
    const jsonl = data.exportJsonl('u1', run.id);
    const lines = jsonl.split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const row = JSON.parse(l);
      expect(row.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant']);
      expect(() => JSON.parse(row.messages[2].content)).not.toThrow();
    }
  });

  it('the bookkeeper catches the overspent Channel Divinity; the bad turn goes to review with a correction', async () => {
    const p = sim();
    const run = lab.startLab('u1', cfg({ judge: ref('judge') }), { resolve: async () => p });
    await run.done;
    const bad = db.prepare("SELECT * FROM lab_turns WHERE run_id = ? AND review = 'pending' AND corrected IS NOT NULL").all(run.id) as Record<string, any>[];
    // Seed 7 with 3 players: turn 3 spends Channel Divinity — only a problem when the cleric is there and already at 0.
    expect(bad.length).toBeGreaterThan(0);
    expect(JSON.parse(bad[0].error_types)).toContain('resource');
    expect(JSON.parse(bad[0].corrected).narration).toBe('fixed');
    // Accepting the correction puts it in the export.
    const before = data.exportJsonl('u1', run.id).split('\n').filter(Boolean).length;
    const res = await app.inject({ method: 'PATCH', url: `/api/lab/turns/${bad[0].id}`, headers: bearer(), payload: { review: 'accepted' } });
    expect(res.statusCode).toBe(200);
    expect(data.exportJsonl('u1', run.id).split('\n').filter(Boolean).length).toBe(before + 1);
    expect((await app.inject({ method: 'PATCH', url: `/api/lab/turns/${bad[0].id}`, headers: bearer(), payload: { review: 'accepted', corrected: 'not json' } })).statusCode).toBe(400);
  });

  it('the Jev fast pass decides which turns the LLM judge checks; both verdicts are stored', async () => {
    const jev = fakeDecider((req) => ({
      roll: { type: 'noul', p: req.state.includes('Turn 2:') ? 0.9 : 0.05 },
      resource: { type: 'noul', p: 0.05 },
      number: { type: 'noul', p: 0.05 },
      contradiction: { type: 'noul', p: 0.05 },
      story: { type: 'score', score: 2, probabilities: {} },
    }));
    const chat = sim();
    const run = lab.startLab('u1', cfg({ jev: { providerId: 'ts', model: 'jev-latest' }, maxTurns: 2, partySize: 2 }), { resolve: async (id) => (id === 'ts' ? jev : chat) });
    await run.done;
    const turns = db.prepare('SELECT * FROM lab_turns WHERE run_id = ? ORDER BY id').all(run.id) as Record<string, any>[];
    expect(turns).toHaveLength(2);
    expect(turns[0].verdict).toBeNull(); // not flagged, not sampled: no LLM judge
    expect(JSON.parse(turns[0].jev_verdict).flagged).toEqual([]);
    expect(turns[0].jev_story).toBe(7);
    expect(JSON.parse(turns[1].jev_verdict).flagged).toEqual(['roll']);
    expect(turns[1].verdict).not.toBeNull();
  });

  it('gives the GPU lock back between turns, so a real run goes before the next sim turn', async () => {
    const log: string[] = [];
    const p = sim({ delay: 30, local: true, log });
    const run = lab.startLab('u1', cfg({ maxTurns: 2, judge: undefined, jev: undefined, partySize: 2 }), { resolve: async () => p });
    // While the sim's first turn holds the GPU, a real run asks for it.
    await new Promise((r) => setTimeout(r, 10));
    const real = fakeProvider(() => {
      log.push('REAL');
      return 'real answer';
    }, { local: true });
    const realRun = runGraph(chain(node('q', 'input'), node('m', 'llm', { model: ref('real') }), node('o', 'output')), 'hi', { resolve: async () => real, emit: () => {} }, new AbortController().signal);
    await Promise.all([run.done, realRun]);
    expect(log.indexOf('REAL')).toBeGreaterThan(-1);
    expect(log.indexOf('REAL')).toBeLessThan(log.indexOf('sim-dm-2'));
  });

  it('Start / Stop over the API, with a status and a scoreboard', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/lab/start', headers: bearer(), payload: { dm: [], players: ref('x') } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/lab/start', headers: bearer(), payload: { dm: [ref('dm')], players: ref('p') } })).json().error).toMatch(/rules-checker/);
    // A slow sim runs in the background until stopped.
    const p = sim({ delay: 20 });
    lab.startLab('u1', cfg({ maxTurns: undefined }), { resolve: async () => p });
    expect((await app.inject({ method: 'POST', url: '/api/lab/start', headers: bearer(), payload: { dm: [ref('dm')], players: ref('p'), judge: ref('j') } })).statusCode).toBe(409);
    await new Promise((r) => setTimeout(r, 150));
    const status = (await app.inject({ method: 'GET', url: '/api/lab', headers: bearer() })).json();
    expect(status.active).toMatchObject({ running: true, state: 'running' });
    expect(status.runs.length).toBeGreaterThan(0);
    const stop = await app.inject({ method: 'POST', url: '/api/lab/stop', headers: bearer() });
    expect(stop.json()).toMatchObject({ running: false, state: 'stopped' });
    expect((await app.inject({ method: 'POST', url: '/api/lab/stop', headers: bearer() })).statusCode).toBe(404);
    const board = (await app.inject({ method: 'GET', url: '/api/lab/scoreboard', headers: bearer() })).json() as { model: string; turns: number; jsonValidPct: number; resourcesPer100: number; story?: number }[];
    const dm = board.find((r) => r.model === 'p|dm')!;
    expect(dm.turns).toBeGreaterThanOrEqual(10);
    expect(dm.jsonValidPct).toBe(100);
    expect(dm.story).toBeGreaterThan(0);
    const jsonl = await app.inject({ method: 'GET', url: '/api/lab/export.jsonl', headers: bearer() });
    expect(jsonl.headers['content-type']).toContain('application/jsonl');
    expect(jsonl.body.split('\n').length).toBeGreaterThan(0);
  });

  it('sets the winner as the model of the DungeonMind canvases', async () => {
    await app.inject({ method: 'PUT', url: '/api/canvases/dnd-narrate', headers: bearer(), payload: { name: 'n', ...chain(node('q', 'input'), node('n', 'llm', { model: ref('old') }), node('o', 'output')) } });
    const res = await app.inject({ method: 'POST', url: '/api/lab/default', headers: bearer(), payload: { model: ref('winner') } });
    expect(res.json()).toEqual({ canvases: 1, blocks: 1 });
    const c = (await app.inject({ method: 'GET', url: '/api/canvases/dnd-narrate', headers: bearer() })).json();
    expect(c.nodes[1].config.model).toEqual(ref('winner'));
  });

  it('a run of failing turns stops itself and shows the error in Problems', async () => {
    const broken: ResolvedProvider = { ...fakeProvider(), adapter: { listModels: async () => [], stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('model offline')) }) }) as never } };
    const run = lab.startLab('u1', cfg({ maxTurns: 50 }), { resolve: async () => broken });
    await run.done;
    expect(run.status.state).toBe('error');
    expect(run.status.lastError).toMatch(/5 failed turns in a row.*model offline/);
    const logged = db.prepare("SELECT message FROM error_log WHERE message LIKE 'Lab:%' ORDER BY id DESC").get() as { message: string };
    expect(logged.message).toMatch(/model offline/);
  });
});
