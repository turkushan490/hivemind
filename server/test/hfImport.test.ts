import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let imp: typeof import('../src/lab/hfImport.js');
let scoped: { authorization: string };

// ---- A fake Hugging Face (huggingface.co and datasets-server.huggingface.co) ----

interface FakeRepo {
  info: Record<string, unknown>;
  /** Route A: the rows API reads it. Otherwise /splits answers splitsError. */
  rows?: (i: number) => Record<string, unknown>;
  total?: number;
  truncated?: (i: number) => boolean;
  splitsError?: number;
  files?: Record<string, string>;
  /** A file download that waits until it is aborted (or released). */
  hang?: string;
}

const repos = new Map<string, FakeRepo>();
const calls: string[] = [];
let release: (() => void) | undefined;

const turn = (i: number, o: Record<string, unknown> = {}) =>
  JSON.stringify({
    speaker_id: 111111111111111111,
    before_utterances: [`Turn ${i}: I swing my axe!`],
    combat_state_before: [
      { name: 'Thorin', hp: '<12/20 HP; Injured>', class: 'Fighter 3', race: 'Dwarf', effects: ['Bless'], controller_id: 222222222222222222 },
      { name: 'Goblin', hp: '<7/7 HP; Healthy>', class: null, race: '', effects: [], controller_id: '333' },
    ],
    current_actor: { name: 'Thorin', hp: '<12/20 HP; Injured>', controller_id: 222222222222222222 },
    commands_norm: ['!a axe -t Goblin'],
    automation_results: ['Thorin attacks with an Axe! Hit: 9 slashing.'],
    after_utterances: ['The goblin falls.'],
    utterance_history: ['DM: A goblin jumps out.', 'Thorin: Not today.'],
    ...o,
  });

function fakeHub() {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (url.host === 'huggingface.co' && url.pathname.startsWith('/api/datasets/')) {
      const r = repos.get(url.pathname.slice('/api/datasets/'.length));
      return r ? Response.json({ siblings: Object.keys(r.files ?? {}).map((rfilename) => ({ rfilename })), ...r.info }) : Response.json({ error: 'Repository not found' }, { status: 404 });
    }
    if (url.host === 'datasets-server.huggingface.co') {
      const r = repos.get(url.searchParams.get('dataset')!)!;
      if (url.pathname === '/splits')
        return r.rows ? Response.json({ splits: [{ dataset: 'x', config: 'default', split: 'test' }, { dataset: 'x', config: 'default', split: 'train' }, { dataset: 'x', config: 'other', split: 'train' }] }) : Response.json({ error: "The dataset viewer doesn't support this dataset because it runs arbitrary Python code." }, { status: r.splitsError ?? 501 });
      if (url.pathname === '/rows') {
        const offset = Number(url.searchParams.get('offset'));
        const length = Number(url.searchParams.get('length'));
        if (length > 100) return Response.json({ error: 'length must be at most 100' }, { status: 422 });
        expect(url.searchParams.get('config')).toBe('default');
        expect(url.searchParams.get('split')).toBe('train');
        const rows = [];
        for (let i = offset; i < Math.min(offset + length, r.total!); i++) rows.push({ row_idx: i, row: r.rows!(i), truncated_cells: r.truncated?.(i) ? ['answer'] : [] });
        return Response.json({ features: Object.keys(r.rows!(0)).map((name, feature_idx) => ({ feature_idx, name, type: { dtype: 'string' } })), rows, num_rows_total: r.total, partial: false });
      }
    }
    const m = url.pathname.match(/^\/datasets\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/);
    if (url.host === 'huggingface.co' && m) {
      const r = repos.get(m[1])!;
      if (r.info.gated && !auth) return new Response('Access to this dataset is restricted', { status: 401 });
      const file = m[2].split('/').map(decodeURIComponent).join('/');
      if (file === r.hang)
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      const body = r.files?.[file];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
    }
    throw new Error(`The import called ${input}`);
  });
}

const lines = (from: number, to: number, f = (i: number) => JSON.stringify({ question: `q${i}`, answer: `a${i}` })) =>
  Array.from({ length: to - from }, (_, k) => f(from + k)).join('\n');

beforeAll(async () => {
  ({ app, db } = await testApp('hfimport', [
    ['u1', 'admin'],
    ['u2', 'user'],
    ['v1', 'viewer'],
  ]));
  imp = await import('../src/lab/hfImport.js');
  imp.setRetryWait(async () => {});
  const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer('u1'), payload: { name: 'DM', canvases: ['dnd-*'], memory: ['dnd:*'], training: true, datasets: ['*'] } });
  scoped = { authorization: `Bearer ${res.json().token}` };
  fakeHub();
  repos.set('squad/qa', {
    info: { id: 'squad/qa', gated: false, cardData: { license: 'mit' } },
    rows: (i) => ({ question: `q${i}`, answer: `a${i}`, context: { title: `T${i}`, tags: ['x', 'y'] } }),
    total: 12_000,
    truncated: (i) => i === 3,
  });
  repos.set('lara-martin/FIREBALL', {
    info: { id: 'lara-martin/FIREBALL', gated: false, cardData: { license: 'cc-by-4.0' } },
    files: {
      'FIREBALL.py': 'print("script")',
      'README.md': '# FIREBALL',
      'filtered/a.jsonl': [turn(1), turn(2, { after_utterances: [], current_actor: null }), '{broken', turn(3)].join('\n'),
      'filtered/b.jsonl': turn(4),
    },
  });
  repos.set('files/qa', {
    info: { id: 'files/qa', gated: false },
    splitsError: 500,
    files: { 'data/1.jsonl': lines(0, 4000), 'data/2.csv': `question,answer\n${lines(4000, 8000, (i) => `q${i},a${i}`)}`, 'data/3.json': JSON.stringify(lines(8000, 12_000).split('\n').map((l) => JSON.parse(l))), 'notes.txt': 'x' },
  });
  repos.set('gated/qa', { info: { id: 'gated/qa', gated: 'manual', cardData: { license: 'other' } }, files: { 'a.jsonl': lines(0, 3) } });
  repos.set('chat/conv', {
    info: { id: 'chat/conv', gated: false },
    files: {
      'train.jsonl': [
        JSON.stringify({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'Weather?' }, { role: 'assistant', content: 'Sunny.' }] }),
        JSON.stringify({ messages: [{ role: 'user', content: 'Anyone?' }] }),
      ].join('\n'),
      'sharegpt.jsonl': JSON.stringify({ conversations: [{ from: 'human', value: 'Name a color' }, { from: 'gpt', value: 'Blue' }] }),
    },
  });
  repos.set('slow/qa', { info: { id: 'slow/qa', gated: false }, files: { 'a.jsonl': lines(0, 25), 'b.jsonl': lines(25, 30) }, hang: 'b.jsonl' });
});
afterAll(() => {
  vi.unstubAllGlobals();
  return app?.close();
});
beforeEach(() => {
  calls.length = 0;
  imp.limits.cap = 1_000_000;
  imp.limits.batch = 1000;
});

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, who = 'u2') => app.inject({ method, url, headers: bearer(who), ...(payload && { payload }) });
const dataset = async (name: string, kind = 'text', who = 'u2') => (await call('POST', '/api/datasets', { name, kind }, who)).json().id as string;
const preview = (id: string, repo: string) => call('POST', `/api/datasets/${id}/import/preview`, { repo });

async function importAndWait(id: string, body: object, who = 'u2') {
  const res = await call('POST', `/api/datasets/${id}/import`, body, who);
  expect(res.statusCode, res.body).toBe(202);
  return waitJob(res.json().jobId, who);
}
async function waitJob(jobId: string, who = 'u2', until = ['done', 'stopped', 'failed']) {
  for (let i = 0; i < 500; i++) {
    const job = (await call('GET', `/api/datasets/import/${jobId}`, undefined, who)).json();
    if (until.includes(job.state) || (until.includes('written') && job.done > 0)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Import did not finish');
}
const refs = (id: string) => (db.prepare('SELECT ref FROM dataset_items WHERE dataset_id = ? ORDER BY id').all(id) as { ref: string }[]).map((r) => r.ref);
const items = (id: string) => db.prepare('SELECT input, output, system, source FROM dataset_items WHERE dataset_id = ? ORDER BY id').all(id) as { input: string; output: string; system: string | null; source: string }[];

describe('Hugging Face import: preview', () => {
  it('route A (rows API): columns, license, rows, first 5 rows; a full link and owner/name are the same repo', async () => {
    const id = await dataset('QA');
    const a = (await preview(id, 'https://huggingface.co/datasets/squad/qa/tree/main/data')).json();
    expect(a).toMatchObject({ repo: 'squad/qa', license: 'mit', gated: false, needsToken: false, route: 'rows', rows: 12_000, files: null, columns: ['question', 'answer', 'context'], preset: null, imported: 0 });
    expect(a.sample).toHaveLength(5);
    expect((await preview(id, 'squad/qa')).json()).toEqual(a);
    expect(calls.some((c) => c.includes('/rows?') && c.includes('length=5'))).toBe(true);
  });

  it('route B (files) on any /splits error: FIREBALL, without the Discord ids in the sample', async () => {
    const id = await dataset('Fireball');
    const p = (await preview(id, 'lara-martin/FIREBALL')).json();
    expect(p).toMatchObject({ repo: 'lara-martin/FIREBALL', license: 'cc-by-4.0', gated: false, route: 'files', files: 2, rows: null, preset: 'fireball', imported: 0 });
    expect(p.columns).toContain('speaker_id');
    expect(p.columns).toContain('commands_norm');
    expect(p.sample).toHaveLength(3);
    expect(JSON.stringify(p.sample)).not.toMatch(/speaker_id|controller_id|111111|222222/);
    // A 500 from /splits falls through too (after its retries); other file types are never downloaded.
    const f = (await preview(id, 'files/qa')).json();
    expect(f).toMatchObject({ route: 'files', files: 3, columns: ['question', 'answer'] });
    expect(calls.filter((c) => c.includes('/splits')).length).toBe(1 + 4);
    expect(calls.some((c) => /FIREBALL\.py|README|notes\.txt/.test(c))).toBe(false);
  });

  it('a gated dataset without a token says so, and the import is refused', async () => {
    const id = await dataset('Gated');
    expect((await preview(id, 'gated/qa')).json()).toMatchObject({ gated: true, needsToken: true, license: 'other', sample: [] });
    const res = await call('POST', `/api/datasets/${id}/import`, { repo: 'gated/qa', map: { input: ['question'], output: ['answer'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(imp.GATED);
  });

  it('presets chat when a column holds a conversation', async () => {
    const id = await dataset('Chats');
    expect((await preview(id, 'chat/conv')).json()).toMatchObject({ preset: 'chat', columns: ['conversations'] });
  });

  it('refuses bad repo ids, unknown repos and datasets that are not text', async () => {
    const id = await dataset('Bad ids');
    for (const repo of ['../..', 'a', 'a/b/c', 'owner/..', './x', 'https://huggingface.co/datasets/../..', 'https://huggingface.co/owner/model', 'a b/c', ''])
      expect((await preview(id, repo)).statusCode, repo).toBe(400);
    expect(calls).toEqual([]);
    expect((await preview(id, 'nobody/nothing')).json().error).toMatch(/no dataset "nobody\/nothing"/);
    for (const kind of ['decision', 'image']) {
      const d = await dataset(`Not text ${kind}`, kind);
      expect((await preview(d, 'squad/qa')).statusCode).toBe(400);
      expect((await call('POST', `/api/datasets/${d}/import`, { repo: 'squad/qa', map: { input: ['question'], output: ['answer'] } })).statusCode).toBe(400);
    }
  });
});

describe('Hugging Face import: route A', () => {
  it('pages at most 100 rows until the limit, skips truncated rows, credits the source once', async () => {
    const id = await dataset('Paged');
    const job = await importAndWait(id, { repo: 'squad/qa', map: { input: ['question', 'context'], output: ['answer'], system: [] }, limit: 250 });
    expect(job).toMatchObject({ state: 'done', done: 250, total: 250, skipped: 1, file: null, files: null, capped: false, error: null });
    const lengths = calls.filter((c) => c.includes('/rows?')).map((c) => Number(new URL(c).searchParams.get('length')));
    expect(Math.max(...lengths)).toBeLessThanOrEqual(100);
    const stored = items(id);
    expect(stored[0]).toEqual({ input: 'q0\n\ntitle: T0\ntags: x, y', output: 'a0', system: null, source: 'huggingface' });
    expect(refs(id)).not.toContain('hf:squad/qa:default/train:3');
    expect(refs(id).at(-1)).toBe('hf:squad/qa:default/train:250');
    await importAndWait(id, { repo: 'squad/qa', map: { input: ['question'], output: ['answer'] }, limit: 1 });
    const d = (await call('GET', '/api/datasets')).json().find((x: { id: string }) => x.id === id);
    expect(d.description).toBe('Imported from Hugging Face: squad/qa (mit)');
  });

  it('importing again continues: 5,000 + 5,000 gives 10,000', async () => {
    const id = await dataset('Twice A');
    const map = { input: ['question'], output: ['answer'] };
    expect(await importAndWait(id, { repo: 'squad/qa', map })).toMatchObject({ done: 5000, total: 5000 });
    expect((await preview(id, 'squad/qa')).json().imported).toBe(5000);
    calls.length = 0;
    expect(await importAndWait(id, { repo: 'squad/qa', map, limit: 5000 })).toMatchObject({ done: 5000, skipped: 0 });
    expect(new URL(calls.find((c) => c.includes('/rows?'))!).searchParams.get('offset')).toBe('5001');
    expect(new Set(refs(id)).size).toBe(10_000);
    expect(imp.importedCount(id, 'squad/qa')).toBe(10_000);
    expect(imp.datasetSources(id)).toEqual([{ repo: 'squad/qa', license: 'mit', url: 'https://huggingface.co/datasets/squad/qa', position: { config: 'default', split: 'train', offset: 10_001 } }]);
    // All: to the end of the dataset.
    expect(await importAndWait(id, { repo: 'squad/qa', map, limit: null })).toMatchObject({ state: 'done', done: 1999, capped: false });
  });

  it('starts from the beginning once the imported examples are deleted', async () => {
    const id = await dataset('Again');
    const map = { input: ['question'], output: ['answer'] };
    await importAndWait(id, { repo: 'squad/qa', map, limit: 10 });
    db.prepare('DELETE FROM dataset_items WHERE dataset_id = ?').run(id);
    await importAndWait(id, { repo: 'squad/qa', map, limit: 10 });
    expect(refs(id)[0]).toBe('hf:squad/qa:default/train:0');
  });

  it('ends at the cap with capped: true, and a full dataset is refused', async () => {
    const id = await dataset('Capped');
    imp.limits.cap = 30;
    await call('POST', `/api/datasets/${id}/items`, { items: Array.from({ length: 10 }, (_, i) => ({ input: `x${i}`, output: 'y' })) });
    expect(await importAndWait(id, { repo: 'squad/qa', map: { input: ['question'], output: ['answer'] }, limit: null })).toMatchObject({ state: 'done', done: 20, capped: true });
    const res = await call('POST', `/api/datasets/${id}/import`, { repo: 'squad/qa', map: { input: ['question'], output: ['answer'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/full/);
  });

  it('retries a 429, honoring Retry-After', async () => {
    const id = await dataset('Busy');
    const waits: number[] = [];
    imp.setRetryWait(async (ms) => void waits.push(ms));
    const real = globalThis.fetch;
    let busy = 1;
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).includes('/rows?') && busy-- > 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : real(u, init)));
    expect(await importAndWait(id, { repo: 'squad/qa', map: { input: ['question'], output: ['answer'] }, limit: 5 })).toMatchObject({ state: 'done', done: 5 });
    expect(waits).toEqual([7000]);
    // Always busy: the job fails and says where it stopped (rows 0–5 are in, row 3 was truncated).
    vi.stubGlobal('fetch', async (u: string, init?: RequestInit) => (String(u).includes('/rows?') ? new Response('down', { status: 503 }) : real(u, init)));
    expect(await importAndWait(id, { repo: 'squad/qa', map: { input: ['question'], output: ['answer'] }, limit: 5 })).toMatchObject({ state: 'failed', error: expect.stringMatching(/Stopped at row 6: .*503/) });
    vi.stubGlobal('fetch', real);
    imp.setRetryWait(async () => {});
  });
});

describe('Hugging Face import: route B', () => {
  it('FIREBALL: the preset, unreadable lines skipped, no Discord ids stored', async () => {
    const id = await dataset('FIREBALL turns');
    const job = await importAndWait(id, { repo: 'https://huggingface.co/datasets/lara-martin/FIREBALL', preset: 'fireball', limit: null });
    expect(job).toMatchObject({ state: 'done', done: 4, skipped: 1, total: null, file: 2, files: 2 });
    const stored = items(id);
    expect(stored[0].input).toBe(
      'Combat:\nThorin, <12/20 HP; Injured>, Fighter 3, Dwarf, Bless\nGoblin, <7/7 HP; Healthy>\n\nCurrent turn: Thorin\n\nChat so far:\nDM: A goblin jumps out.\nThorin: Not today.\n\nTurn 1: I swing my axe!',
    );
    expect(stored[0].output).toBe('Commands:\n!a axe -t Goblin\n\nResults:\nThorin attacks with an Axe! Hit: 9 slashing.\n\nThe goblin falls.');
    // Empty after_utterances and a null current_actor: those sections are left out.
    expect(stored[1].input).not.toContain('Current turn');
    expect(stored[1].output).toBe('Commands:\n!a axe -t Goblin\n\nResults:\nThorin attacks with an Axe! Hit: 9 slashing.');
    expect(refs(id)).toEqual(['hf:lara-martin/FIREBALL:filtered/a.jsonl:1', 'hf:lara-martin/FIREBALL:filtered/a.jsonl:2', 'hf:lara-martin/FIREBALL:filtered/a.jsonl:4', 'hf:lara-martin/FIREBALL:filtered/b.jsonl:1']);
    const everything = JSON.stringify(db.prepare('SELECT * FROM dataset_items WHERE dataset_id = ?').all(id)) + JSON.stringify(db.prepare('SELECT * FROM datasets WHERE id = ?').get(id));
    expect(everything).not.toMatch(/111111|222222|speaker_id|controller_id/);
    // Mapping its columns by hand doesn't store them either.
    const d2 = await dataset('FIREBALL by hand');
    await importAndWait(d2, { repo: 'lara-martin/FIREBALL', map: { input: ['combat_state_before', 'speaker_id'], output: ['current_actor'] }, limit: 1 });
    expect(JSON.stringify(items(d2))).not.toMatch(/111111|222222|controller_id/);
  });

  it('FIREBALL never goes into "DungeonMind DM", with or without the preset', async () => {
    const id = await dataset('dungeonmind dm');
    for (const body of [{ preset: 'fireball' }, { map: { input: ['before_utterances'], output: ['commands_norm'] } }]) {
      const res = await call('POST', `/api/datasets/${id}/import`, { repo: 'lara-martin/fireball', ...body });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/DungeonMind DM/);
    }
    const other = await dataset('Not FIREBALL');
    expect((await call('POST', `/api/datasets/${other}/import`, { repo: 'squad/qa', preset: 'fireball' })).statusCode).toBe(400);
    expect((await call('POST', `/api/datasets/${other}/import`, { repo: 'squad/qa', preset: 'chat', map: { input: ['a'], output: ['b'] } })).statusCode).toBe(400);
    expect((await call('POST', `/api/datasets/${other}/import`, { repo: 'squad/qa', map: { input: ['question'], output: [] } })).statusCode).toBe(400);
  });

  it('chat preset: {role, content} and {from, value}; a conversation without an answer is skipped', async () => {
    const id = await dataset('Chat import');
    expect(await importAndWait(id, { repo: 'chat/conv', preset: 'chat', limit: null })).toMatchObject({ state: 'done', done: 2, skipped: 1 });
    // Files by name: sharegpt.jsonl, then train.jsonl.
    expect(items(id)).toEqual([
      { input: 'human: Name a color', output: 'Blue', system: null, source: 'huggingface' },
      { input: 'user: Hi\n\nassistant: Hello!\n\nuser: Weather?', output: 'Sunny.', system: 'Be brief.', source: 'huggingface' },
    ]);
  });

  it('importing again continues: 5,000 + 5,000 gives 10,000 over JSONL, CSV and JSON files', async () => {
    const id = await dataset('Twice B');
    const map = { input: ['question'], output: ['answer'] };
    expect(await importAndWait(id, { repo: 'files/qa', map, limit: 5000 })).toMatchObject({ done: 5000, file: 2, files: 3, total: null });
    expect(imp.datasetSources(id)[0].position).toEqual({ file: 'data/2.csv', line: 1000 });
    calls.length = 0;
    expect(await importAndWait(id, { repo: 'files/qa', map, limit: 5000 })).toMatchObject({ done: 5000, file: 3 });
    expect(calls.some((c) => c.includes('data/1.jsonl'))).toBe(false);
    const r = refs(id);
    expect(new Set(r).size).toBe(10_000);
    expect(r[5000]).toBe('hf:files/qa:data/2.csv:1001');
    expect(items(id)[9999]).toMatchObject({ input: 'q9999', output: 'a9999' });
    expect(await importAndWait(id, { repo: 'files/qa', map, limit: null })).toMatchObject({ done: 2000 });
    expect(imp.datasetSources(id)[0].position).toEqual({ file: 'data/3.json', line: 4000, done: true });
    calls.length = 0;
    expect(await importAndWait(id, { repo: 'files/qa', map, limit: null })).toMatchObject({ state: 'done', done: 0 });
    expect(calls.some((c) => c.includes('/resolve/'))).toBe(false);
  });

  it('Stop keeps the finished batches; a second import meanwhile gets 409; the next one continues', async () => {
    const id = await dataset('Stopped');
    imp.limits.batch = 10;
    const map = { input: ['question'], output: ['answer'] };
    const start = await call('POST', `/api/datasets/${id}/import`, { repo: 'slow/qa', map, limit: null });
    const jobId = start.json().jobId;
    // b.jsonl hangs: a.jsonl is read, 20 written, 5 still in the batch.
    await waitJob(jobId, 'u2', ['written']);
    for (let i = 0; i < 100 && !calls.some((c) => c.includes('b.jsonl')); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await call('POST', `/api/datasets/${id}/import`, { repo: 'slow/qa', map })).statusCode).toBe(409);
    expect((await preview(id, 'slow/qa')).json().running).toBe(jobId);
    // Someone else can't see or stop it.
    expect((await call('GET', `/api/datasets/import/${jobId}`, undefined, 'u1')).statusCode).toBe(404);
    expect((await call('DELETE', `/api/datasets/import/${jobId}`, undefined, 'u1')).statusCode).toBe(404);
    expect((await call('DELETE', `/api/datasets/import/${jobId}`)).json()).toEqual({ ok: true });
    expect(await waitJob(jobId)).toMatchObject({ state: 'stopped', done: 20 });
    expect(refs(id)).toHaveLength(20);
    expect(imp.datasetSources(id)[0].position).toEqual({ file: 'a.jsonl', line: 20 });
    repos.get('slow/qa')!.hang = undefined;
    expect(await importAndWait(id, { repo: 'slow/qa', map, limit: null })).toMatchObject({ state: 'done', done: 10 });
    expect(refs(id).slice(19, 22)).toEqual(['hf:slow/qa:a.jsonl:20', 'hf:slow/qa:a.jsonl:21', 'hf:slow/qa:a.jsonl:22']);
    expect(new Set(refs(id)).size).toBe(30);
    release?.();
  });
});

describe('Hugging Face import: who may', () => {
  it('viewers and limited API tokens are refused', async () => {
    const mine = await dataset('Viewer try', 'text', 'u1');
    expect((await call('POST', `/api/datasets/${mine}/import/preview`, { repo: 'squad/qa' }, 'v1')).statusCode).toBe(403);
    expect((await call('POST', `/api/datasets/${mine}/import`, { repo: 'squad/qa', preset: 'chat' }, 'v1')).statusCode).toBe(403);
    for (const [method, url] of [
      ['POST', `/api/datasets/${mine}/import/preview`],
      ['POST', `/api/datasets/${mine}/import`],
      ['GET', '/api/datasets/import/x'],
      ['DELETE', '/api/datasets/import/x'],
    ] as const) {
      const res = await app.inject({ method, url, headers: scoped, payload: method === 'POST' ? { repo: 'squad/qa', preset: 'chat' } : undefined });
      expect(res.statusCode, url).toBe(403);
    }
    // Another user's dataset is not found.
    expect((await preview(mine, 'squad/qa')).statusCode).toBe(404);
  });

  it('the health check lists datasetImport', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toContain('datasetImport');
  });
});

describe('Hugging Face import: credit', () => {
  it('the model card lists each imported source with its license and link, and the FIREBALL paper', async () => {
    const { modelCard } = await import('../src/lab/hf.js');
    const id = await dataset('Credit');
    await importAndWait(id, { repo: 'lara-martin/FIREBALL', preset: 'fireball', limit: 1 });
    const sources = imp.datasetSources(id).map(({ repo, license, url }) => ({ repo, license, url }));
    const card = modelCard({ name: 'dm', repo: 'me/dm', base: 'unsloth/Qwen3.5-2B', dataset: 'Credit', rows: 1, kind: 'text', file: 'x.gguf', sources });
    expect(card).toContain('datasets:\n  - lara-martin/FIREBALL');
    expect(card).toContain('## Training data');
    expect(card).toContain('- [lara-martin/FIREBALL](https://huggingface.co/datasets/lara-martin/FIREBALL), license: cc-by-4.0');
    expect(card).toContain('https://arxiv.org/abs/2305.01528');
    expect(modelCard({ name: 'dm', repo: 'me/dm', base: 'b', dataset: 'd', rows: 1, kind: 'text', file: 'x.gguf' })).not.toContain('Training data');
  });
});
