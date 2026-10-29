import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];

beforeAll(async () => {
  ({ app, db } = await testApp('batch', [
    ['u1', 'admin'],
    ['v1', 'viewer'],
  ]));
  const graph = chain(node('i', 'input'), node('t', 'template', { prompt: '{{question}} #{{vars.run}}' }), node('o', 'output'));
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('c-batch', 'u1', 'Batch test', ?)").run(JSON.stringify(graph));
});
afterAll(() => app?.close());

const status = async () => (await app.inject({ method: 'GET', url: '/api/batch', headers: bearer() })).json();
const until = async (fn: (s: any) => boolean) => {
  for (let i = 0; i < 300; i++) {
    const s = await status();
    if (fn(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('batch did not get there');
};

describe('run repeatedly', () => {
  it('runs the questions in turn, a number of times, with {{vars.run}} per run', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/batch', headers: bearer(), payload: { canvasId: 'c-batch', questions: ['a', 'b'], times: 3 } });
    expect(res.statusCode).toBe(200);
    const s = await until((x) => x && !x.running);
    expect(s).toMatchObject({ done: 3, failed: 0, total: 3 });
    const finals = (db.prepare("SELECT final FROM runs WHERE canvas_id = 'c-batch' ORDER BY started_at, rowid").all() as { final: string }[]).map((r) => r.final);
    expect(finals).toEqual(['a #1', 'b #2', 'a #3']);
  });

  it('runs until stopped, one batch at a time', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/batch', headers: bearer(), payload: { canvasId: 'c-batch', questions: ['x'], times: 0 } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/batch', headers: bearer(), payload: { canvasId: 'c-batch', questions: ['y'] } })).statusCode).toBe(409);
    await until((x) => x.done >= 2);
    expect((await app.inject({ method: 'POST', url: '/api/batch/stop', headers: bearer() })).statusCode).toBe(200);
    expect((await until((x) => !x.running)).total).toBeUndefined();
  });

  it('needs a saved canvas and questions; viewers may not', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/batch', headers: bearer(), payload: { canvasId: 'nope', questions: ['x'] } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/batch', headers: bearer(), payload: { canvasId: 'c-batch', questions: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/batch', headers: bearer('v1'), payload: { canvasId: 'c-batch', questions: ['x'] } })).statusCode).toBe(403);
  });
});
