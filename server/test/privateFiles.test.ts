import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

/** Every file has an owner: non-admins see, open, use and delete only their own; admins see all. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

const upload = (who: string, name: string, data: Buffer) =>
  app.inject({ method: 'POST', url: `/api/files?name=${encodeURIComponent(name)}`, headers: { ...bearer(who), 'content-type': 'application/octet-stream' }, payload: data });
const list = async (who: string) => (await app.inject({ method: 'GET', url: '/api/files', headers: bearer(who) })).json() as { path: string; owner?: string }[];
const raw = (who: string, path: string) => app.inject({ method: 'GET', url: `/api/files/raw?path=${encodeURIComponent(path)}`, headers: bearer(who) });
const del = (who: string, path: string) => app.inject({ method: 'DELETE', url: `/api/files?path=${encodeURIComponent(path)}`, headers: bearer(who) });

let picture: string;

beforeAll(async () => {
  ({ app, db } = await testApp('files', [
    ['admin', 'admin'],
    ['a', 'user'],
    ['b', 'user'],
  ]));
  const res = await upload('a', 'outputs/image-a.png', PNG);
  expect(res.statusCode).toBe(200);
  picture = res.json().path;
});
afterAll(() => app?.close());

describe('private files', () => {
  it("B can't list, open or delete A's picture", async () => {
    expect((await list('a')).map((f) => f.path)).toEqual([picture]);
    expect((await list('b')).map((f) => f.path)).not.toContain(picture);
    expect((await raw('a', picture)).statusCode).toBe(200);
    expect((await raw('b', picture)).statusCode).toBe(404);
    expect((await del('b', picture)).statusCode).toBe(404);
    expect((await raw('a', picture)).statusCode).toBe(200);
  });

  it("B can't use A's picture in a block", async () => {
    const graph = chain(
      node('q', 'input'),
      node('t', 'template', { prompt: `![x](hm-file:${picture})` }),
      node('d', 'decide', { model: { providerId: 'none', model: 'jev' }, questions: [{ name: 'cat', type: 'box', instructions: 'Where is the cat?' }] }),
      node('o', 'output'),
    );
    db.prepare("UPDATE users SET profile_id = 'everything' WHERE id = 'b'").run();
    const run = await runAndWait(app, { question: 'x', graph }, 'b');
    expect(run.events.find((e) => e.type === 'error' && e.nodeId === 'd')?.error).toBe('File not found');
  });

  it('an admin sees both, with the owner', async () => {
    await upload('b', 'notes.txt', Buffer.from('hello'));
    const all = await list('admin');
    expect(all.find((f) => f.path === picture)?.owner).toBe('user_a');
    expect(all.find((f) => f.path === 'notes.txt')?.owner).toBe('user_b');
    expect((await raw('admin', picture)).statusCode).toBe(200);
  });

  it('a file without an owner is admin-only', async () => {
    const { writeFileSync } = await import('node:fs');
    const { filesDir } = await import('../src/services/files.js');
    writeFileSync(`${filesDir}/by-hand.txt`, 'x');
    expect((await raw('a', 'by-hand.txt')).statusCode).toBe(404);
    expect((await list('a')).map((f) => f.path)).not.toContain('by-hand.txt');
    expect((await raw('admin', 'by-hand.txt')).statusCode).toBe(200);
  });

  it("run outputs belong to whoever runs it, also on someone else's shared canvas", async () => {
    const graph = chain(node('q', 'input'), node('s', 'save', { format: 'txt', fileName: 'shared-out' }), node('o', 'output'));
    expect((await app.inject({ method: 'PUT', url: '/api/canvases/shared-save', headers: bearer('a'), payload: { name: 'Save', shared: true, ...graph } })).statusCode).toBe(200);
    const run = await runAndWait(app, { question: 'hello', canvasId: 'shared-save' }, 'b');
    const path = run.events.find((e) => e.type === 'node_done' && e.files?.length)!.files![0].path;
    expect((await list('b')).map((f) => f.path)).toContain(path);
    expect((await list('a')).map((f) => f.path)).not.toContain(path);
    // The run (and its export with the file) is B's, not the canvas owner's.
    expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export.zip`, headers: bearer('a') })).statusCode).toBe(404);
    const zip = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export.zip`, headers: bearer('b') });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.includes(Buffer.from(`files/${path}`))).toBe(true);
  });

  it('the owner can delete their own file', async () => {
    expect((await del('a', picture)).statusCode).toBe(200);
    expect((await raw('a', picture)).statusCode).toBe(404);
    expect(db.prepare('SELECT 1 FROM files WHERE path = ?').get(picture)).toBeUndefined();
  });
});
