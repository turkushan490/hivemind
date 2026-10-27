import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { safePath, writeUnique } from '../services/files.js';
import { runMarkdown, runReport } from '../services/runExport.js';
import { createZip, readZip, type ZipEntry } from '../services/zip.js';
import { requireUser, type User } from './auth.js';

/** File formats: { hivemind: 1, type: 'canvas' | 'run', ... }, so imports can tell what they got. */
interface CanvasExport {
  hivemind: 1;
  type: 'canvas';
  name: string;
  description?: string;
  nodes: CanvasGraph['nodes'];
  edges: CanvasGraph['edges'];
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled';

function sendFile(reply: FastifyReply, name: string, data: Buffer | string, type: string) {
  return reply
    .header('content-type', type)
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    .send(data);
}

function canvasExport(row: { name: string; description: string | null; graph: string }): CanvasExport {
  const g = JSON.parse(row.graph) as CanvasGraph;
  return { hivemind: 1, type: 'canvas', name: row.name, description: row.description ?? undefined, nodes: g.nodes, edges: g.edges };
}

/** Everything about one finished task, as files people can open without HiveMind. */
function taskEntries(user: User, id: string, prefix = ''): ZipEntry[] {
  const r = db
    .prepare(
      `SELECT r.*, c.name AS canvas_name FROM runs r LEFT JOIN canvases c ON c.id = r.canvas_id WHERE r.id = ? AND r.owner_id = ? AND r.status != 'running'`,
    )
    .get(id, user.id) as Record<string, any> | undefined;
  if (!r) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  const events = JSON.parse(r.events ?? '[]') as RunEvent[];
  const graph = events.find((e) => e.type === 'run_start')?.graph;
  const label = (nodeId?: string) => {
    const n = graph?.nodes.find((x) => x.id === nodeId);
    return n?.label || n?.type || nodeId || 'block';
  };
  const entries: ZipEntry[] = [];
  const meta = [`Status: ${r.status}`, `Started: ${r.started_at} UTC`, r.canvas_name && `Canvas: ${r.canvas_name}`, r.cost ? `Cost: $${Number(r.cost).toFixed(4)}` : '']
    .filter(Boolean)
    .join('  \n');
  entries.push({ name: `${prefix}README.md`, data: `# ${r.question}\n\n${meta}\n\n## Final answer\n\n${r.final ?? '_No final answer._'}\n` });
  entries.push({ name: `${prefix}answer.md`, data: r.final ?? '' });
  let i = 0;
  for (const e of events) {
    if (e.type !== 'node_done' || !e.text || e.nodeType === 'input') continue;
    entries.push({ name: `${prefix}blocks/${String(++i).padStart(2, '0')}-${safeName(label(e.nodeId))}.md`, data: `# ${label(e.nodeId)}${e.model ? ` (${e.model})` : ''}\n\n${e.text}\n` });
  }
  const files = [...new Set(events.flatMap((e) => (e.type === 'node_done' ? (e.files ?? []).map((f) => f.path) : [])))];
  for (const f of files) {
    try {
      entries.push({ name: `${prefix}files/${f}`, data: readFileSync(safePath(f)) });
    } catch {
      // The file was deleted from the folder since; the rest of the task still exports.
    }
  }
  entries.push({
    name: `${prefix}run.json`,
    data: JSON.stringify({ hivemind: 1, type: 'run', question: r.question, status: r.status, final: r.final, cost: r.cost, startedAt: r.started_at, finishedAt: r.finished_at, canvasName: r.canvas_name, events }),
  });
  return entries;
}

export function exportRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: 300 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // One run as a document: Markdown (also what the print / PDF view shows) or JSON.
  app.get('/api/runs/:id/export.:format', { preHandler: requireUser }, async (req, reply) => {
    const { id, format } = req.params as { id: string; format: string };
    if (format !== 'md' && format !== 'json') return reply.callNotFound();
    const report = runReport(req.user!.id, id);
    if (!report) return reply.code(404).send({ error: 'Run not found (or still running)' });
    const name = `${safeName(report.question)}.${format}`;
    if (format === 'json') return sendFile(reply, name, JSON.stringify(report, null, 2), 'application/json; charset=utf-8');
    const base = `${req.protocol}://${req.headers.host ?? 'localhost'}`;
    return sendFile(reply, name, runMarkdown(report, (req.query as { relative?: string }).relative ? '' : base), 'text/markdown; charset=utf-8');
  });

  // ---- Canvases ----
  app.get('/api/canvases/:id/export', { preHandler: requireUser }, async (req, reply) => {
    const row = db.prepare('SELECT name, description, graph FROM canvases WHERE id = ? AND owner_id = ?').get((req.params as { id: string }).id, req.user!.id) as
      | { name: string; description: string | null; graph: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'Canvas not found' });
    return sendFile(reply, `${safeName(row.name)}.hivemind.json`, JSON.stringify(canvasExport(row), null, 2), 'application/json');
  });

  app.get('/api/export/canvases.zip', { preHandler: requireUser }, async (req, reply) => {
    const rows = db.prepare('SELECT name, description, graph FROM canvases WHERE owner_id = ? ORDER BY name').all(req.user!.id) as { name: string; description: string | null; graph: string }[];
    const seen = new Map<string, number>();
    const entries = rows.map((r) => {
      const base = safeName(r.name);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { name: `${base}${n > 1 ? ` (${n})` : ''}.hivemind.json`, data: JSON.stringify(canvasExport(r), null, 2) };
    });
    return sendFile(reply, 'hivemind-canvases.zip', createZip(entries), 'application/zip');
  });

  /** Body: a .hivemind.json (one canvas, or { canvases: [...] }) or a ZIP of them. Always added as new canvases. */
  app.post('/api/import/canvases', { preHandler: requireUser, bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    const items: unknown[] = [];
    if (Buffer.isBuffer(req.body)) {
      for (const e of readZip(req.body)) if (e.name.endsWith('.json')) items.push(JSON.parse(e.data.toString('utf8')));
    } else items.push(req.body);
    const canvases = items.flatMap((x) => (Array.isArray((x as { canvases?: unknown[] }).canvases) ? (x as { canvases: unknown[] }).canvases : [x])) as Partial<CanvasExport>[];
    const valid = canvases.filter((c) => c && Array.isArray(c.nodes) && Array.isArray(c.edges));
    if (!valid.length) return reply.code(400).send({ error: 'No HiveMind canvases found in this file' });
    const names = new Set((db.prepare('SELECT name FROM canvases WHERE owner_id = ?').all(req.user!.id) as { name: string }[]).map((r) => r.name));
    const created: { id: string; name: string }[] = [];
    for (const c of valid) {
      const base = String(c.name || 'Imported canvas').slice(0, 80);
      let name = base;
      for (let i = 1; names.has(name); i++) name = `${base} (imported${i > 1 ? ` ${i}` : ''})`;
      names.add(name);
      const id = newId();
      db.prepare("INSERT INTO canvases (id, owner_id, name, description, graph, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run(
        id,
        req.user!.id,
        name,
        c.description ?? null,
        JSON.stringify({ nodes: c.nodes, edges: c.edges }),
      );
      created.push({ id, name });
    }
    return { created };
  });

  // ---- Tasks (finished runs) ----
  app.get('/api/runs/:id/export.zip', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = (db.prepare('SELECT question FROM runs WHERE id = ? AND owner_id = ?').get(id, req.user!.id) as { question: string } | undefined)?.question ?? 'task';
    return sendFile(reply, `${safeName(q).slice(0, 40)}.zip`, createZip(taskEntries(req.user!, id)), 'application/zip');
  });

  /** ?ids=a,b,c or all finished tasks. Each task in its own folder. */
  app.get('/api/export/tasks.zip', { preHandler: requireUser }, async (req, reply) => {
    const ids = String((req.query as { ids?: string }).ids ?? '')
      .split(',')
      .filter(Boolean);
    const rows = (
      ids.length
        ? ids.map((id) => ({ id }))
        : (db.prepare("SELECT id FROM runs WHERE owner_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 500").all(req.user!.id) as { id: string }[])
    ) as { id: string }[];
    const entries: ZipEntry[] = [];
    rows.forEach((r, i) => {
      try {
        const q = (db.prepare('SELECT question FROM runs WHERE id = ?').get(r.id) as { question: string }).question;
        entries.push(...taskEntries(req.user!, r.id, `${String(i + 1).padStart(3, '0')}-${safeName(q).slice(0, 40)}/`));
      } catch {}
    });
    return sendFile(reply, 'hivemind-tasks.zip', createZip(entries), 'application/zip');
  });

  /** A task ZIP (or several) back into the history, with its files, so it can be replayed. */
  app.post('/api/import/tasks', { preHandler: requireUser, bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the task ZIP' });
    const all = readZip(req.body);
    const runs = all.filter((e) => e.name === 'run.json' || e.name.endsWith('/run.json'));
    if (!runs.length) return reply.code(400).send({ error: 'No HiveMind tasks (run.json) found in this ZIP' });
    let imported = 0;
    for (const r of runs) {
      const prefix = r.name.slice(0, -'run.json'.length);
      const data = JSON.parse(r.data.toString('utf8')) as { question?: string; status?: string; final?: string; cost?: number; startedAt?: string; finishedAt?: string; events?: RunEvent[] };
      if (!Array.isArray(data.events)) continue;
      let events = JSON.stringify(data.events);
      // Bring the task's files back into the folder; if a name is taken, point the task at the new name.
      for (const f of all.filter((e) => e.name.startsWith(`${prefix}files/`))) {
        const original = f.name.slice(`${prefix}files/`.length);
        const saved = writeUnique(original, f.data as Buffer);
        if (saved !== original) events = events.split(JSON.stringify(original).slice(1, -1)).join(JSON.stringify(saved).slice(1, -1));
      }
      db.prepare('INSERT INTO runs (id, owner_id, question, status, started_at, finished_at, final, cost, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        newId(),
        req.user!.id,
        String(data.question ?? 'Imported task'),
        data.status === 'error' || data.status === 'cancelled' ? data.status : 'done',
        data.startedAt ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
        data.finishedAt ?? null,
        data.final ?? null,
        data.cost ?? null,
        events,
      );
      imported++;
    }
    return { imported };
  });
}
