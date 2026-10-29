import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let ds: typeof import('../src/lab/datasets.js');

beforeAll(async () => {
  ({ app, db } = await testApp('datasets', [
    ['u1', 'admin'],
    ['u2', 'user'],
    ['v1', 'viewer'],
  ]));
  ds = await import('../src/lab/datasets.js');
});
afterAll(() => app?.close());

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, who = 'u2') => app.inject({ method, url, headers: bearer(who), ...(payload && { payload }) });

describe('datasets', () => {
  it('creates, fills by hand and exports chat-format JSONL', async () => {
    const d = (await call('POST', '/api/datasets', { name: 'Style', system: 'Write like Turks' })).json();
    expect(d).toMatchObject({ name: 'Style', kind: 'text', items: 0 });
    expect((await call('POST', '/api/datasets', { name: 'style' })).statusCode).toBe(409);
    const added = (await call('POST', `/api/datasets/${d.id}/items`, { items: [{ input: 'Hi', output: 'Yo' }, { input: '', output: '' }] })).json();
    expect(added.added).toBe(1);
    const jsonl = (await call('GET', `/api/datasets/${d.id}/export.jsonl`)).body;
    expect(JSON.parse(jsonl)).toEqual({ messages: [{ role: 'system', content: 'Write like Turks' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Yo' }] });
  });

  it('imports JSONL, CSV and plain text', () => {
    expect(ds.parseUpload('{"messages":[{"role":"system","content":"S"},{"role":"user","content":"Q"},{"role":"assistant","content":"A"}]}\n{"prompt":"p","completion":"c"}')).toEqual([
      { input: 'Q', output: 'A', system: 'S' },
      { input: 'p', output: 'c' },
    ]);
    expect(ds.parseUpload('question;answer\n"Wat is 2+2?";"4, natuurlijk"\nHoi;Hallo')).toEqual([
      { input: 'Wat is 2+2?', output: '4, natuurlijk' },
      { input: 'Hoi', output: 'Hallo' },
    ]);
    expect(ds.parseUpload('Q1 ||| A1\n\nJust a sentence.')).toEqual([
      { input: 'Q1', output: 'A1' },
      { input: '', output: 'Just a sentence.' },
    ]);
    expect(() => ds.parseUpload('{"a":1}\n{broken')).toThrow(/Line 2/);
  });

  it('decision datasets: a question, answers as option keys, and trainer rows with the options', async () => {
    const question = { question: 'Which label fits?', type: 'choice', options: { bug: 'Software errors', billing: 'Payments' } };
    const d = (await call('POST', '/api/datasets', { name: 'Tickets', kind: 'decision' })).json();
    await call('PATCH', `/api/datasets/${d.id}`, { system: JSON.stringify(question) });
    const text = [
      '{"state": "Checkout gives 500 errors", "answer": "bug"}',
      '{"state": "Refund missing", "answer": "nope"}',
      '{"state": "Is the hag dead?", "answer": "yes", "question": "Did the turn end the fight?", "type": "noul"}',
      '{"state": "Hit for 7", "answer": "great", "question": "How good is the turn?", "type": "score", "options": ["bad", "okay", "great"]}',
    ].join('\n');
    expect((await call('POST', `/api/datasets/${d.id}/items`, { text, format: 'jsonl' })).json().added).toBe(4);
    const rows = ds.exportDataset(d.id).split('\n').map((l) => JSON.parse(l));
    // "nope" is not an option: left out.
    expect(rows).toEqual([
      { state: 'Checkout gives 500 errors', question: 'Which label fits?', type: 'choice', options: [{ key: 'bug', description: 'Software errors' }, { key: 'billing', description: 'Payments' }], answer: 'bug' },
      { state: 'Is the hag dead?', question: 'Did the turn end the fight?', type: 'noul', options: [{ key: 'true', description: null }, { key: 'false', description: null }], answer: 'true' },
      { state: 'Hit for 7', question: 'How good is the turn?', type: 'score', options: [{ key: '0', description: 'bad' }, { key: '1', description: 'okay' }, { key: '2', description: 'great' }], answer: '2' },
    ]);
    // An export uploads again unchanged.
    const again = ds.parseUpload(rows.map((r) => JSON.stringify(r)).join('\n'));
    expect(again[2]).toMatchObject({ input: 'Hit for 7', output: '2', meta: { type: 'score', options: ['bad', 'okay', 'great'] } });
  });

  it('pending and rejected examples are never trained on', async () => {
    const d = (await call('POST', '/api/datasets', { name: 'Review me' })).json();
    await call('POST', `/api/datasets/${d.id}/items`, { items: [{ input: 'a', output: '1' }, { input: 'b', output: '2' }] });
    const items = (await call('GET', `/api/datasets/${d.id}/items`)).json() as { id: number; input: string }[];
    await call('PATCH', `/api/datasets/items/${items.find((i) => i.input === 'a')!.id}`, { review: 'rejected' });
    expect(ds.trainableCount(d.id)).toBe(1);
    expect(ds.exportDataset(d.id).split('\n')).toHaveLength(1);
  });

  it('👍 on a run keeps its question and answer', async () => {
    db.prepare("INSERT INTO runs (id, owner_id, question, status, final, events) VALUES ('r-good', 'u2', 'Best pizza?', 'done', 'Margherita.', '[]')").run();
    const res = await call('POST', '/api/runs/r-good/thumbs', { dataset: 'Food answers' });
    expect(res.json().dataset).toMatchObject({ name: 'Food answers', items: 1 });
    // A second 👍 on the same run doesn't add it twice.
    await call('POST', '/api/runs/r-good/thumbs', { dataset: 'Food answers' });
    expect(res.json().dataset.items).toBe(1);
    expect((await call('POST', '/api/runs/nope/thumbs', {})).statusCode).toBe(404);
  });

  it('viewers can look but not change', async () => {
    expect((await call('GET', '/api/datasets', undefined, 'v1')).statusCode).toBe(200);
    expect((await call('POST', '/api/datasets', { name: 'x' }, 'v1')).statusCode).toBe(403);
  });

  it('Lab turns become DungeonMind DM examples: clean ones now, corrections once accepted', () => {
    db.prepare("INSERT INTO lab_runs (id, owner_id, name, config, status) VALUES ('lr', 'u1', 'sim', '{}', 'stopped')").run();
    const add = (output: string, errors: string, review: string | null, corrected: string | null = null) =>
      Number(
        db
          .prepare("INSERT INTO lab_turns (run_id, game, turn, seed, model, input, output, json_valid, error_types, review, corrected) VALUES ('lr', 0, 0, 1, 'm', 'act', ?, 1, ?, ?, ?)")
          .run(output, errors, review, corrected).lastInsertRowid,
      );
    const clean = add('{"ok":1}', '[]', null);
    const bad = add('{"bad":1}', '["roll"]', 'pending', '{"fixed":1}');
    ds.migrateLabTurns();
    const dm = ds.findDataset('u1', ds.DM_DATASET)!;
    expect(dm.items).toBe(1);
    db.prepare("UPDATE lab_turns SET review = 'accepted' WHERE id = ?").run(bad);
    ds.syncLabTurn('u1', bad);
    expect(ds.exportDataset(dm.id)).toContain('fixed');
    expect(ds.trainableCount(dm.id)).toBe(2);
    expect(clean).toBeGreaterThan(0);
  });
});
