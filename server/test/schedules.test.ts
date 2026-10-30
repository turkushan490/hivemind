import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let clock: typeof import('../src/clock.js');
let schedules: typeof import('../src/services/schedules.js');
let runScheduled: typeof import('../src/api/schedules.js').runScheduled;
let train: typeof import('../src/lab/train.js');

// Local time (the TZ of the test machine): 2 November 2026 is a Monday.
const monday = (h: number, m: number) => new Date(2026, 10, 2, h, m, 30);
const tuesday = (h: number, m: number) => new Date(2026, 10, 3, h, m, 30);

beforeAll(async () => {
  process.env.TRAIN_POLL_MS = '20';
  ({ app, db } = await testApp('schedules', [
    ['u1', 'admin'],
    ['v1', 'viewer'],
  ]));
  clock = await import('../src/clock.js');
  schedules = await import('../src/services/schedules.js');
  ({ runScheduled } = await import('../src/api/schedules.js'));
  train = await import('../src/lab/train.js');
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://ollama.test:11434', 1)").run();
  await app.inject({ method: 'PUT', url: '/api/canvases/nightly', headers: bearer(), payload: { name: 'Nightly', ...chain(node('i', 'input'), node('t', 'template', { prompt: 'ran: {{question}}' }), node('o', 'output')) } });
});
afterAll(() => {
  clock.setClock();
  return app?.close();
});

const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: object, who = 'u1') => app.inject({ method, url, headers: bearer(who), ...(payload && { payload }) });
const runs = (canvasId: string) => db.prepare('SELECT question FROM runs WHERE canvas_id = ? ORDER BY started_at').all(canvasId) as { question: string }[];

describe('workflow schedules', () => {
  it('set, read and remove a schedule; bad input is refused', async () => {
    clock.setClock(() => monday(1, 0));
    expect((await call('GET', '/api/workflows/nightly/schedule')).statusCode).toBe(404);
    expect((await call('PUT', '/api/workflows/nightly/schedule', { time: '3:15' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/workflows/nightly/schedule', { time: '03:15', days: ['someday'] })).statusCode).toBe(400);
    expect((await call('PUT', '/api/workflows/missing/schedule', { time: '03:15' })).statusCode).toBe(404);
    expect((await call('PUT', '/api/workflows/nightly/schedule', { time: '03:15' }, 'v1')).statusCode).toBe(403);
    const put = await call('PUT', '/api/workflows/nightly/schedule', { time: '03:15', days: ['MON', 'wed'] });
    expect(put.json()).toMatchObject({ canvasId: 'nightly', time: '03:15', days: ['mon', 'wed'], enabled: true, nextRunAt: new Date(2026, 10, 2, 3, 15).toISOString() });
    expect((await call('GET', '/api/workflows/nightly/schedule')).json()).toMatchObject({ time: '03:15', days: ['mon', 'wed'] });
    expect((await call('PUT', '/api/workflows/nightly/schedule', { enabled: false })).json()).toMatchObject({ enabled: false, time: '03:15' });
    expect((await call('PUT', '/api/workflows/nightly/schedule', { enabled: true })).json().nextRunAt).toBeDefined();
    expect((await call('DELETE', '/api/workflows/nightly/schedule')).json()).toEqual({ ok: true });
    expect((await call('DELETE', '/api/workflows/nightly/schedule')).statusCode).toBe(404);
  });

  it('the minute ticker runs a due workflow once, as its owner, on its days only (fake clock)', async () => {
    await call('PUT', '/api/workflows/nightly/schedule', { time: '03:15', days: ['mon'] });
    expect(schedules.tickSchedules(runScheduled, monday(3, 14))).toEqual([]);
    expect(schedules.tickSchedules(runScheduled, monday(3, 15))).toEqual(['nightly']);
    // The next minutes (and a second tick in the same minute) don't run it again.
    expect(schedules.tickSchedules(runScheduled, monday(3, 15))).toEqual([]);
    expect(schedules.tickSchedules(runScheduled, monday(3, 16))).toEqual([]);
    // Not on Tuesday.
    expect(schedules.tickSchedules(runScheduled, tuesday(3, 15))).toEqual([]);
    expect(runs('nightly')).toEqual([{ question: 'Scheduled run (03:15)' }]);
    const sched = (await call('GET', '/api/workflows/nightly/schedule')).json();
    expect(sched.lastRunAt).toBe(monday(3, 15).toISOString());
  });

  it('a missed time still runs within the hour (a restart), not later', async () => {
    db.prepare('UPDATE workflow_schedules SET last_run_at = NULL').run();
    await call('PUT', '/api/workflows/nightly/schedule', { time: '05:00', days: ['mon', 'tue'] });
    expect(schedules.tickSchedules(runScheduled, monday(6, 1))).toEqual([]);
    expect(schedules.tickSchedules(runScheduled, tuesday(5, 40))).toEqual(['nightly']);
    await call('DELETE', '/api/workflows/nightly/schedule');
  });

  it('a Train block in a scheduled run waits for the training window', async () => {
    const ds = await import('../src/lab/datasets.js');
    const d = ds.createDataset('u1', { name: 'Night data' });
    ds.addItems(d.id, 'manual', Array.from({ length: 25 }, (_, i) => ({ input: `q${i}`, output: `a${i}` })));
    await app.inject({ method: 'PUT', url: '/api/settings/training', headers: bearer(), payload: { start: '04:00', end: '05:00' } });
    await call('PUT', '/api/canvases/trainer', { name: 'Trainer', ...chain(node('i', 'input'), node('t', 'train', { dataset: 'Night data', trainBase: 'unsloth/Qwen3.5-0.8B', trainName: 'night:v1' }), node('o', 'output')) });
    clock.setClock(() => monday(3, 30));
    await call('PUT', '/api/workflows/trainer/schedule', { time: '03:30' });
    expect(schedules.tickSchedules(runScheduled, monday(3, 30))).toEqual(['trainer']);
    let job: { id: string; state: string; settings: string } | undefined;
    for (let i = 0; i < 200 && job?.state !== 'queued'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      job = db.prepare("SELECT id, state, settings FROM lab_trains WHERE name = 'night:v1'").get() as typeof job;
    }
    expect(job?.state).toBe('queued');
    expect(JSON.parse(job!.settings).nightly).toBe(true);
    expect(train.cancelTrain(job!.id, 'u1')).toBe(true);
    for (let i = 0; i < 100 && job?.state !== 'cancelled'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = db.prepare('SELECT id, state, settings FROM lab_trains WHERE id = ?').get(job!.id) as typeof job;
    }
    expect(job?.state).toBe('cancelled');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toContain('schedules');
  });
});
