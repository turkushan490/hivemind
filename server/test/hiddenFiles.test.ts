import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, testApp } from './helpers.js';

/** Unlock mode: files uploaded in or saved by a hidden workflow are hidden — only their owner sees them, only while unlocked. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let unlock: typeof import('../src/services/unlock.js');
let files: typeof import('../src/services/files.js');

const screen = { cookies: { hm_session: 'screen' } };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const upload = (name: string, query = '', auth: object = screen) =>
  app.inject({ method: 'POST', url: `/api/files?name=${encodeURIComponent(name)}${query}`, headers: { 'content-type': 'application/octet-stream', ...(auth as { headers?: object }).headers }, ...('cookies' in auth ? { cookies: (auth as { cookies: Record<string, string> }).cookies } : {}), payload: PNG });
const list = async (auth: object = screen) => ((await app.inject({ method: 'GET', url: '/api/files', ...auth })).json() as { path: string; hidden?: boolean }[]).map((f) => f.path);
const raw = (path: string, auth: object = screen) => app.inject({ method: 'GET', url: `/api/files/raw?path=${encodeURIComponent(path)}`, ...auth });

beforeAll(async () => {
  ({ app, db } = await testApp('hiddenfiles', [
    ['u1', 'admin'],
    ['u2', 'admin'],
  ]));
  unlock = await import('../src/services/unlock.js');
  files = await import('../src/services/files.js');
  const { sha256 } = await import('../src/crypto.js');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('screen'), 'u1', Date.now() + 3_600_000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256('other'), 'u2', Date.now() + 3_600_000);
  db.prepare("UPDATE users SET profile_id = 'everything'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
  // A fake Ollama that sees pictures: it says how many it got.
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { images?: string[] }[] };
      const n = body.messages.reduce((a, m) => a + (m.images?.length ?? 0), 0);
      return new Response(`${JSON.stringify({ message: { content: `saw ${n} picture(s)` } })}
${JSON.stringify({ done: true })}
`);
    }
    return new Response('not found', { status: 404 });
  });
});
afterAll(() => app.close());

describe('hidden files', () => {
  it('a hidden upload needs unlock mode, and then only shows for its owner while unlocked', async () => {
    unlock.setUnlocked({ id: 'u1' }, false);
    expect((await upload('uploads/secret.png', '&hidden=1')).statusCode).toBe(403);
    unlock.setUnlocked({ id: 'u1' }, true);
    const res = await upload('uploads/secret.png', '&hidden=1');
    expect(res.statusCode).toBe(200);
    const path = (res.json() as { path: string }).path;
    const normal = ((await upload('uploads/normal.png')).json() as { path: string }).path;

    expect(await list()).toEqual(expect.arrayContaining([path, normal]));
    expect(((await app.inject({ method: 'GET', url: '/api/files', ...screen })).json() as { path: string; hidden?: boolean }[]).find((f) => f.path === path)?.hidden).toBe(true);
    expect((await raw(path)).statusCode).toBe(200);

    // Locked: gone from the list, and "not found" when opened.
    unlock.setUnlocked({ id: 'u1' }, false);
    expect(await list()).not.toContain(path);
    expect(await list()).toContain(normal);
    expect((await raw(path)).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/files?path=${encodeURIComponent(path)}`, ...screen })).statusCode).toBe(404);

    // Another admin never sees it (even unlocked), and an API token can't open it.
    unlock.setUnlocked({ id: 'u2' }, true);
    expect(await list({ cookies: { hm_session: 'other' } })).not.toContain(path);
    expect(await list({ cookies: { hm_session: 'other' } })).toContain(normal);
    expect((await raw(path, { cookies: { hm_session: 'other' } })).statusCode).toBe(404);
    unlock.setUnlocked({ id: 'u1' }, true);
    expect((await raw(path, { headers: bearer('u1') })).statusCode).toBe(404);
  });

  it('a hidden workflow hides the pictures in its question and what it saves; a run reads them while locked', async () => {
    unlock.setUnlocked({ id: 'u1' }, true);
    const pic = ((await upload('uploads/from-phone.png', '', { headers: bearer('u1') })).json() as { path: string }).path;
    expect(await list()).toContain(pic);
    const graph = {
      nodes: [
        { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
        { id: 'm', type: 'llm', position: { x: 1, y: 0 }, config: { model: { providerId: 'ollama', model: 'llava' }, pictures: 'direct' } },
        { id: 's', type: 'save', position: { x: 2, y: 0 }, config: { format: 'txt', fileName: 'described' } },
        { id: 'o', type: 'output', position: { x: 3, y: 0 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 'm' },
        { id: 'e2', source: 'm', target: 's' },
        { id: 'e3', source: 'm', target: 'o' },
      ],
    };
    const saved = await app.inject({ method: 'PUT', url: '/api/canvases', ...screen, payload: { name: 'Hidden pics', hidden: true, ...graph } });
    expect(saved.statusCode).toBe(200);
    const canvasId = (saved.json() as { id: string }).id;

    // Started unlocked, locked while it runs: it still reads the picture.
    const start = await app.inject({ method: 'POST', url: '/api/runs', ...screen, payload: { canvasId, question: `what is this?\n\n![p](hm-file:${pic})` } });
    expect(start.statusCode).toBe(200);
    unlock.setUnlocked({ id: 'u1' }, false);
    const runId = (start.json() as { runId: string }).runId;
    let r: { status: string; final: string | null } | undefined;
    for (let i = 0; i < 200; i++) {
      r = db.prepare('SELECT status, final FROM runs WHERE id = ?').get(runId) as typeof r;
      if (r && r.status !== 'running') break;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    expect(r?.status).toBe('done');
    expect(r?.final).toContain('saw 1 picture(s)');

    const row = (p: string) => db.prepare('SELECT hidden FROM files WHERE path = ?').get(p) as { hidden: number } | undefined;
    expect(row(pic)?.hidden).toBe(1);
    const out = (db.prepare("SELECT path, hidden FROM files WHERE path LIKE 'outputs/described%'").all() as { path: string; hidden: number }[]);
    expect(out.length).toBe(1);
    expect(out[0].hidden).toBe(1);
    expect(await list()).not.toContain(pic);
    expect(await list()).not.toContain(out[0].path);
  });

  it('once: files that earlier hidden runs used or saved become hidden; others stay', async () => {
    const old = ((await upload('uploads/old.png', '', { headers: bearer('u1') })).json() as { path: string }).path;
    const keep = ((await upload('uploads/keep.png', '', { headers: bearer('u1') })).json() as { path: string }).path;
    const oldOut = files.writeUnique('outputs/old-answer.md', 'x', 'u1');
    const hiddenCanvas = (db.prepare('SELECT id FROM canvases WHERE hidden = 1 LIMIT 1').get() as { id: string }).id;
    db.prepare("INSERT INTO runs (id, owner_id, canvas_id, question, status, events) VALUES ('oldrun', 'u1', ?, ?, 'done', ?)").run(
      hiddenCanvas,
      `look ![a](hm-file:${old})`,
      JSON.stringify([{ type: 'node_done', files: [{ path: oldOut, kind: 'text' }] }]),
    );
    db.prepare("INSERT INTO runs (id, owner_id, canvas_id, question, status) VALUES ('openrun', 'u1', NULL, ?, 'done')").run(`look ![b](hm-file:${keep})`);
    db.prepare("DELETE FROM settings WHERE key = 'files.hiddenBackfill'").run();
    files.hideFilesOfHiddenRuns();
    const h = (p: string) => (db.prepare('SELECT hidden FROM files WHERE path = ?').get(p) as { hidden: number }).hidden;
    expect(h(old)).toBe(1);
    expect(h(oldOut)).toBe(1);
    expect(h(keep)).toBe(0);
  });
});
