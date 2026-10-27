import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let app: FastifyInstance;
const auth = { authorization: 'Bearer hm_export' };

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hm-export-'));
  const { buildApp } = await import('../src/app.js');
  const { db } = await import('../src/db/index.js');
  const { sha256 } = await import('../src/crypto.js');
  db.prepare("INSERT INTO users (id, username, pw_hash, role) VALUES ('u', 'u1', 'x', 'user')").run();
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES ('t', 'u', 't', ?, 'hm_')").run(sha256('hm_export'));
  const graph = {
    nodes: [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, config: {} },
      { id: 't', type: 'template', label: 'Shape it', position: { x: 0, y: 0 }, config: { prompt: 'Answer to {{question}} ![pic](hm-file:outputs/a-b.png)' } },
      { id: 'out', type: 'output', position: { x: 0, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'a', source: 'q', target: 't' },
      { id: 'b', source: 't', target: 'out' },
    ],
  };
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('c', 'u', 'Exporter', ?)").run(JSON.stringify(graph));
  app = await buildApp({ logger: false, web: false });
  await app.ready();
});
afterAll(() => app?.close());

describe('run export', () => {
  it('exports a finished run as Markdown and JSON', async () => {
    // A non-streamed API call returns only when the run is finished.
    const done = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: { model: 'c', messages: [{ role: 'user', content: 'life' }] } });
    const runId = done.json().id.replace('chatcmpl-', '');

    const json = await app.inject({ url: `/api/runs/${runId}/export.json`, headers: auth });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-disposition']).toContain('life.json');
    const report = json.json();
    expect(report).toMatchObject({ type: 'run-report', question: 'life', canvas: 'Exporter', status: 'done' });
    expect(report.blocks.map((b: { label: string }) => b.label)).toEqual(['Shape it', 'output']);

    const md = await app.inject({ url: `/api/runs/${runId}/export.md`, headers: { ...auth, host: 'hive.local:4820' } });
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('# life');
    expect(md.body).toContain('**Canvas:** Exporter');
    expect(md.body).toContain('### Shape it');
    expect(md.body).toContain('(http://hive.local:4820/api/files/raw?inline=1&path=outputs%2Fa-b.png)');

    expect((await app.inject({ url: `/api/runs/${runId}/export.zip`, headers: auth })).headers['content-type']).toContain('zip');
    expect((await app.inject({ url: `/api/runs/${runId}/export.exe`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/runs/nope/export.md', headers: auth })).statusCode).toBe(404);
  });
});
