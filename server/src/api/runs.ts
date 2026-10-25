import type { CanvasGraph, RunSummary } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { validateGraph } from '../engine/graph.js';
import { cancelRun, startRun, subscribe } from '../events/runs.js';
import { requireUser } from './auth.js';
import { resolverFor } from './providers.js';

interface CanvasRow {
  id: string;
  name: string;
  description: string | null;
  graph: string;
  updated_at: string;
}

const toCanvas = (r: CanvasRow) => ({ id: r.id, name: r.name, description: r.description ?? undefined, ...JSON.parse(r.graph), updatedAt: r.updated_at });

export function runRoutes(app: FastifyInstance) {
  // ---- Canvases ----
  app.get('/api/canvases', { preHandler: requireUser }, async (req) =>
    (db.prepare('SELECT * FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC').all(req.user!.id) as unknown as CanvasRow[]).map(toCanvas),
  );

  app.get('/api/canvases/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = db.prepare('SELECT * FROM canvases WHERE id = ? AND owner_id = ?').get((req.params as { id: string }).id, req.user!.id) as CanvasRow | undefined;
    return row ? toCanvas(row) : reply.code(404).send({ error: 'Not found' });
  });

  app.put('/api/canvases/:id?', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string } & Partial<CanvasGraph>;
    const graph = { nodes: body.nodes ?? [], edges: body.edges ?? [] };
    if (!body.name?.trim()) return reply.code(400).send({ error: 'Canvas needs a name' });
    const id = (req.params as { id?: string }).id ?? newId();
    const owned = db.prepare('SELECT owner_id FROM canvases WHERE id = ?').get(id) as { owner_id: string } | undefined;
    if (owned && owned.owner_id !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    db.prepare(
      `INSERT INTO canvases (id, owner_id, name, description, graph, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, graph = excluded.graph, updated_at = excluded.updated_at`,
    ).run(id, req.user!.id, body.name.trim(), body.description ?? null, JSON.stringify(graph));
    return toCanvas(db.prepare('SELECT * FROM canvases WHERE id = ?').get(id) as unknown as CanvasRow);
  });

  app.delete('/api/canvases/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM canvases WHERE id = ? AND owner_id = ?').run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });

  // ---- Runs ----
  /** Body: { question, canvasId } to run a saved canvas, or { question, graph } for an ad-hoc one. */
  app.post('/api/runs', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { question?: string; canvasId?: string; graph?: CanvasGraph };
    const question = body.question?.trim();
    if (!question) return reply.code(400).send({ error: 'Ask a question' });
    // A graph in the body wins (the editor runs what is on screen, saved or not); canvasId links the run to it.
    let graph = body.graph;
    if (body.canvasId) {
      const row = db.prepare('SELECT graph FROM canvases WHERE id = ? AND owner_id = ?').get(body.canvasId, req.user!.id) as { graph: string } | undefined;
      if (!row) return reply.code(404).send({ error: 'Canvas not found' });
      graph ??= JSON.parse(row.graph);
    }
    if (!graph) return reply.code(400).send({ error: 'Send a canvasId or a graph' });
    try {
      validateGraph(graph);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const runId = startRun({ ownerId: req.user!.id, canvasId: body.canvasId, graph, question, resolve: resolverFor(req.user!) });
    return { runId };
  });

  app.get('/api/runs', { preHandler: requireUser }, async (req): Promise<RunSummary[]> =>
    (
      db
        .prepare('SELECT id, canvas_id, question, status, started_at, finished_at, final, cost FROM runs WHERE owner_id = ? ORDER BY started_at DESC LIMIT 100')
        .all(req.user!.id) as Record<string, any>[]
    ).map((r) => ({
      id: r.id,
      canvasId: r.canvas_id ?? undefined,
      question: r.question,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      final: r.final ?? undefined,
      cost: r.cost ?? undefined,
    })),
  );

  /** Server-Sent Events: all past events of the run, then live ones. Also replays finished runs. */
  app.get('/api/runs/:id/events', { preHandler: requireUser }, (req, reply) => {
    const { id } = req.params as { id: string };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const end = () => {
      clearInterval(ping);
      res.write('event: end\ndata: {}\n\n');
      res.end();
    };
    const unsubscribe = subscribe(id, req.user!.id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`), end);
    if (!unsubscribe) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Run not found' })}\n\n`);
      clearInterval(ping);
      return res.end();
    }
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.post('/api/runs/:id/cancel', { preHandler: requireUser }, async (req, reply) =>
    cancelRun((req.params as { id: string }).id, req.user!.id) ? { ok: true } : reply.code(404).send({ error: 'No running run with that id' }),
  );
}
