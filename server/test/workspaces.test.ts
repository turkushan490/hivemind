import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;
let ws: typeof import('../src/services/workspaces.js');
let db: typeof import('../src/db/index.js')['db'];

beforeAll(async () => {
  ({ app, db } = await testApp('workspaces'));
  ws = await import('../src/services/workspaces.js');
});
afterAll(() => app.close());

const good = JSON.stringify({
  nodes: [
    { id: 'q', type: 'input', config: {} },
    { id: 't', type: 'template', config: { prompt: 'Echo: {{question}}' } },
    { id: 'o', type: 'output', config: {} },
  ],
  edges: [
    { source: 'q', target: 't' },
    { source: 't', target: 'o' },
  ],
});

/** A workflow whose one block is a workflow block with this op, for character "ultron". */
const block = (config: Record<string, unknown>) => ({
  nodes: [node('q', 'input'), node('w', 'workflow', { workspace: 'ultron', ...config }), node('o', 'output')],
  edges: [
    { id: 'e1', source: 'q', target: 'w' },
    { id: 'e2', source: 'w', target: 'o' },
  ],
});

describe('Workflows the characters make themselves (H20)', () => {
  it('only in their own folder and with their own ids', () => {
    expect(ws.workspaceOf('Ultron')).toEqual({ name: 'ultron', folder: 'HiveBot · Ultron workspace', prefix: 'hivebot-ws-ultron-' });
    expect(() => ws.checkId('ultron', 'hivemind-other')).toThrow(/hivebot-ws-ultron-/);
    expect(() => ws.checkId('ultron', 'hivebot-ws-jarvis-1')).toThrow(/hivebot-ws-ultron-/);
    expect(ws.checkId('ultron', 'hivebot-ws-ultron-1')).toBe('hivebot-ws-ultron-1');
  });

  it('a graph with problems is not saved; the problems come back as text to fix', async () => {
    const bad = JSON.stringify({ nodes: [{ id: 'q', type: 'input' }, { id: 'x', type: 'nope' }], edges: [] });
    const r = await runAndWait(app, { question: bad, graph: block({ wfOp: 'create', canvas: 'hivebot-ws-ultron-1' }) });
    expect(r.final).toMatch(/NOT SAVED/);
    expect(r.final).toMatch(/Unknown node type "nope"|output/);
    expect(db.prepare('SELECT 1 FROM canvases WHERE id = ?').get('hivebot-ws-ultron-1')).toBeUndefined();
  });

  it('creates, lists, runs and deletes its own workflow; another id is refused', async () => {
    const made = await runAndWait(app, { question: '```json\n' + good + '\n```', graph: block({ wfOp: 'create', canvas: 'hivebot-ws-ultron-1' }) });
    expect(made.final).toBe('Made hivebot-ws-ultron-1');
    const row = db.prepare('SELECT folder, managed_by, ttl_days FROM canvases WHERE id = ?').get('hivebot-ws-ultron-1') as { folder: string; managed_by: string; ttl_days: number };
    expect(row).toEqual({ folder: 'HiveBot · Ultron workspace', managed_by: 'hivebot', ttl_days: 7 });

    const ran = await runAndWait(app, { question: 'hello there', graph: block({ wfOp: 'run', canvas: 'hivebot-ws-ultron-1' }) });
    expect(ran.final).toContain('Echo: hello there');

    const list = await app.inject({ method: 'GET', url: '/api/workspaces/ultron', headers: bearer() });
    expect(list.json().workflows[0]).toMatchObject({ id: 'hivebot-ws-ultron-1', ttlDays: 7, lastRun: { status: 'done' } });

    const other = await runAndWait(app, { question: good, graph: block({ wfOp: 'create', canvas: 'hivemind-other' }) });
    expect(other.status).toBe('error');

    const gone = await runAndWait(app, { question: 'x', graph: block({ wfOp: 'delete', canvas: 'hivebot-ws-ultron-1' }) });
    expect(gone.final).toBe('Deleted hivebot-ws-ultron-1');
  });

  it('deletes workspace workflows nobody used for their ttlDays', () => {
    db.prepare("INSERT INTO canvases (id, owner_id, name, graph, ttl_days, updated_at) VALUES ('hivebot-ws-jev-old', 'u1', 'old', ?, 2, datetime('now', '-3 days'))").run(good);
    db.prepare("INSERT INTO canvases (id, owner_id, name, graph, ttl_days, updated_at) VALUES ('hivebot-ws-jev-new', 'u1', 'new', ?, 2, datetime('now'))").run(good);
    expect(ws.sweepWorkspaces()).toBe(1);
    expect(db.prepare("SELECT id FROM canvases WHERE id LIKE 'hivebot-ws-jev-%'").all()).toEqual([{ id: 'hivebot-ws-jev-new' }]);
  });
});
