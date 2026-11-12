import { createHash } from 'node:crypto';
import type { CanvasGraph } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
/** The cloud model fails while this is set (a broken step), else it answers "<model>: <words>". */
let failStep = false;

/** An OpenAI-compatible server: streams two words, or fails with HTTP 500. */
function cloud() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
    const b = JSON.parse(String(init?.body ?? '{}')) as { model: string };
    if (failStep && b.model === 'm2') return new Response('{"error":"broken"}', { status: 500 });
    const sse = [{ choices: [{ delta: { content: `${b.model} ` } }] }, { choices: [{ delta: { content: 'done' } }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } }]
      .map((d) => `data: ${JSON.stringify(d)}\n\n`)
      .join('');
    return new Response(`${sse}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
}

const graph: CanvasGraph = chain(
  node('in', 'input'),
  node('plan', 'llm', { model: { providerId: 'cloud', model: 'm1' } }, 'plan'),
  node('code', 'llm', { model: { providerId: 'cloud', model: 'm2' } }, 'code'),
  node('out', 'output'),
);

beforeAll(async () => {
  ({ app, db } = await testApp('robotjobs'));
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('cloud', 'custom', 'openai', 'Cloud', 'http://cloud.test/v1', 0)").run();
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('hivebot-build-1', 'u1', 'HiveBot build 1', ?)").run(JSON.stringify(graph));
  cloud();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
});

const waitJob = async (jobId: string, done: (j: { status: string }) => boolean) => {
  for (let i = 0; i < 150; i++) {
    const j = (await app.inject({ method: 'GET', url: `/api/robot/jobs/${jobId}`, headers: bearer() })).json();
    if (done(j)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  const last = (await app.inject({ method: 'GET', url: `/api/robot/jobs/${jobId}`, headers: bearer() })).json();
  throw new Error(`job did not finish: ${JSON.stringify(last).slice(0, 600)}`);
};

describe('background jobs (H3)', () => {
  it('a background request answers 202 at once; the job shows its progress, stats and answer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: bearer(),
      payload: { model: 'hivebot-build-1', messages: [{ role: 'user', content: 'make a website about cats' }], hivemind_vars: { background: true, character: 'ultron', job: 'Cat website' } },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json();
    const j = await waitJob(jobId, (x) => x.status === 'done');
    expect(j).toMatchObject({ character: 'ultron', title: 'Cat website', answer: 'm2 done', progress: { done: 2, total: 2 } });
    expect(j.blocks.map((b: { node: string; model: string }) => [b.node, b.model])).toEqual([
      ['plan', 'm1'],
      ['code', 'm2'],
    ]);
    const list = (await app.inject({ method: 'GET', url: '/api/robot/jobs', headers: bearer() })).json();
    expect(list[0]).toMatchObject({ jobId, status: 'done', seen: false });
    await app.inject({ method: 'POST', url: `/api/robot/jobs/${jobId}/seen`, headers: bearer() });
    expect((await app.inject({ method: 'GET', url: '/api/robot/jobs', headers: bearer() })).json()[0].seen).toBe(true);
  });

  it('a failed step stops the job with its block; resuming from that block keeps what came before', async () => {
    failStep = true;
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'hivebot-build-1', messages: [{ role: 'user', content: 'go' }], hivemind_vars: { background: true } } });
    const { jobId } = res.json();
    const failed = await waitJob(jobId, (x) => x.status === 'failed');
    expect(failed).toMatchObject({ failedNode: 'code', failedLabel: 'code' });
    failStep = false;
    const calls: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.body) calls.push((JSON.parse(String(init.body)) as { model: string }).model);
      return real(url, init);
    });
    const again = await app.inject({ method: 'POST', url: `/api/robot/jobs/${jobId}/resume`, headers: bearer(), payload: { fromNode: 'code' } });
    expect(again.statusCode, again.body).toBe(200);
    const done = await waitJob(jobId, (x) => x.status === 'done');
    expect(done.answer).toBe('m2 done');
    // Only the fixed step ran again.
    expect(calls).toEqual(['m2']);
    cloud();
  });
});

describe('stats per block (H5)', () => {
  it('a non-streamed answer carries each block\'s numbers and the answering block\'s speed', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'hivebot-build-1', messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.json().hivemind.stats.map((s: { node: string; completionTokens: number }) => [s.node, s.completionTokens])).toEqual([
      ['plan', 2],
      ['code', 2],
    ]);
  });

  it('a streamed answer with hivemind_vars.progress says which block works and what it measured', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'hivebot-build-1', stream: true, messages: [{ role: 'user', content: 'hi' }], hivemind_vars: { progress: true } } });
    const chunks = res.body
      .split('\n\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)));
    expect(chunks.filter((c) => c.type === 'progress').map((c) => c.node)).toEqual(['plan', 'code']);
    expect(chunks.filter((c) => c.type === 'stats' && !c.live).map((c) => [c.node, c.model])).toEqual([
      ['plan', 'm1'],
      ['code', 'm2'],
    ]);
  });
});

describe('robot settings and PIN (H2, H4)', () => {
  it('settings go to the robot; what it reports shows; a new PIN goes as salt + hash and is forgotten once taken', async () => {
    const { robot, token } = (await app.inject({ method: 'POST', url: '/api/robots', headers: bearer(), payload: { name: 'desk', board: 'cores3' } })).json();
    const as = { authorization: `Bearer ${token}` };
    await app.inject({ method: 'PATCH', url: `/api/robots/${robot.id}`, headers: bearer(), payload: { settings: { volume: 40, micSensitivity: 99 } } });
    const cfg = (await app.inject({ method: 'GET', url: '/api/robot/config', headers: as })).json();
    expect(cfg.settings).toMatchObject({ volume: 40, micSensitivity: 10, conversationMode: true, backlight: { dimAfterS: 180 } });
    expect((await app.inject({ method: 'POST', url: `/api/robots/${robot.id}/pin`, headers: bearer(), payload: { pin: '12' } })).statusCode).toBe(400);
    const { id } = (await app.inject({ method: 'POST', url: `/api/robots/${robot.id}/pin`, headers: bearer(), payload: { pin: '4321' } })).json();
    const change = (await app.inject({ method: 'GET', url: '/api/robot/config', headers: as })).json().pinChange;
    // The robot's scheme: SHA-256 of the 16 salt bytes, then the digits.
    expect(change.hash).toBe(createHash('sha256').update(Buffer.from(change.salt, 'hex')).update('4321').digest('hex'));
    expect(change.id).toBe(id);
    const hb = (await app.inject({ method: 'POST', url: '/api/robot/heartbeat', headers: as, payload: { pinId: id, settings: { volume: 55 } } })).json();
    expect(hb.config.pinChange).toBeUndefined();
    expect(typeof hb.jobsDone).toBe('number');
    const list = (await app.inject({ method: 'GET', url: '/api/robots', headers: bearer() })).json().robots;
    expect(list.find((r: { id: string }) => r.id === robot.id)).toMatchObject({ pinPending: false, reported: { volume: 55 } });
  });

  it('the CoreS3 speech model is flashed at 0x620000 when the release has it', async () => {
    const put = (f: string) => app.inject({ method: 'PUT', url: `/api/installers/hivebot-robot/v0.9.17/${f}`, headers: { ...bearer(), 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    for (const p of ['bootloader', 'partitions', 'ota_data_initial', 'firmware', 'srmodels']) await put(`cores3-${p}.bin`);
    const m = (await app.inject({ method: 'GET', url: '/api/installers/firmware-manifest?board=cores3', headers: bearer() })).json();
    expect(m.builds[0].parts.at(-1)).toMatchObject({ offset: 0x620000 });
  });
});
