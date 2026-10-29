import type { CanvasGraph, RunEvent, RunRequest, RunSummary } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { validateGraph } from '../engine/graph.js';
import { checkVars } from '../engine/vars.js';
import { cancelRun, startRun, subscribe } from '../events/runs.js';
import { nodeOutputs } from '../services/runOutputs.js';
import { requireUser, type User } from './auth.js';
import { canvasAllowed } from './scope.js';
import { gpuFreerFor, resolverFor, trainingFor } from './providers.js';
import { batchStatus, startBatch, stopBatch } from '../services/batch.js';

export interface CanvasRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  graph: string;
  updated_at: string;
  shared: number;
  owner_name?: string;
}

const toCanvas = (r: CanvasRow, user: User) => ({
  id: r.id,
  name: r.name,
  description: r.description ?? undefined,
  ...JSON.parse(r.graph),
  updatedAt: r.updated_at,
  shared: !!r.shared,
  mine: r.owner_id === user.id,
  ...(r.owner_id !== user.id && r.owner_name && { ownerName: r.owner_name }),
});

/** Your own canvases plus the ones others share with everyone. */
export const canvasesFor = (user: User) =>
  (
    db
      .prepare('SELECT c.*, u.username AS owner_name FROM canvases c JOIN users u ON u.id = c.owner_id WHERE c.owner_id = ? OR c.shared = 1 ORDER BY c.updated_at DESC')
      .all(user.id) as unknown as CanvasRow[]
  ).filter((r) => canvasAllowed(user, r.id));

export const canvasFor = (user: User, id: string) =>
  canvasAllowed(user, id)
    ? (db.prepare('SELECT c.*, u.username AS owner_name FROM canvases c JOIN users u ON u.id = c.owner_id WHERE c.id = ? AND (c.owner_id = ? OR c.shared = 1)').get(id, user.id) as
        | CanvasRow
        | undefined)
    : undefined;

const userById = (id: string) => db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as User | undefined;

/**
 * What a run of this canvas may use: a canvas shared by someone else runs as stored, with its owner's AI providers
 * (their keys pay); your own canvas can run what is on screen.
 */
export function runSetup(user: User, row: CanvasRow | undefined, bodyGraph: CanvasGraph | undefined): { graph?: CanvasGraph; providerUser: User } {
  if (!row) return { graph: user.role === 'viewer' ? undefined : bodyGraph, providerUser: user };
  const mine = row.owner_id === user.id;
  const stored = JSON.parse(row.graph) as CanvasGraph;
  if (mine && user.role !== 'viewer') return { graph: bodyGraph ?? stored, providerUser: user };
  return { graph: stored, providerUser: mine ? user : (userById(row.owner_id) ?? user) };
}

export function runRoutes(app: FastifyInstance) {
  // ---- Canvases ----
  app.get('/api/canvases', { preHandler: requireUser }, async (req) => canvasesFor(req.user!).map((r) => toCanvas(r, req.user!)));

  app.get('/api/canvases/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = canvasFor(req.user!, (req.params as { id: string }).id);
    return row ? toCanvas(row, req.user!) : reply.code(404).send({ error: 'Not found' });
  });

  app.put('/api/canvases/:id?', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string; shared?: boolean } & Partial<CanvasGraph>;
    const graph = { nodes: body.nodes ?? [], edges: body.edges ?? [] };
    if (!body.name?.trim()) return reply.code(400).send({ error: 'Canvas needs a name' });
    const id = (req.params as { id?: string }).id ?? newId();
    const owned = db.prepare('SELECT owner_id, shared FROM canvases WHERE id = ?').get(id) as { owner_id: string; shared: number } | undefined;
    if (owned && owned.owner_id !== req.user!.id) return reply.code(404).send({ error: 'Not found' });
    const shared = body.shared === undefined ? (owned?.shared ?? 0) : body.shared ? 1 : 0;
    db.prepare(
      `INSERT INTO canvases (id, owner_id, name, description, graph, shared, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, graph = excluded.graph, shared = excluded.shared, updated_at = excluded.updated_at`,
    ).run(id, req.user!.id, body.name.trim(), body.description ?? null, JSON.stringify(graph), shared);
    return toCanvas(canvasFor(req.user!, id)!, req.user!);
  });

  app.delete('/api/canvases/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM canvases WHERE id = ? AND owner_id = ?').run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });

  // ---- Runs ----
  /** Body: { question, canvasId } to run a saved canvas, or { question, graph } for an ad-hoc one; optional vars for {{vars.name}}. */
  app.post('/api/runs', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as RunRequest;
    const question = body.question?.trim();
    if (!question) return reply.code(400).send({ error: 'Ask a question' });
    let vars: Record<string, string>;
    try {
      vars = checkVars(body.vars);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    // A graph in the body wins for your own canvas (the editor runs what is on screen, saved or not); canvasId links the run to it.
    // Shared canvases of others, and everything a viewer runs, run exactly as saved.
    const row = body.canvasId ? canvasFor(req.user!, body.canvasId) : undefined;
    if (body.canvasId && !row) return reply.code(404).send({ error: 'Canvas not found' });
    const { graph, providerUser } = runSetup(req.user!, row, body.graph);
    if (!graph) return reply.code(400).send({ error: req.user!.role === 'viewer' ? 'Viewers can only run saved canvases' : 'Send a canvasId or a graph' });
    try {
      validateGraph(graph);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const runId = startRun({ ownerId: req.user!.id, user: req.user!, canvasId: body.canvasId, graph, question, vars, resolve: resolverFor(providerUser), freeGpu: gpuFreerFor(providerUser), training: trainingFor(req.user!) });
    return { runId };
  });

  // ---- Run repeatedly (batch) ----
  app.get('/api/batch', { preHandler: requireUser }, async (req) => batchStatus(req.user!.id));

  /** Body: {canvasId, questions: string[], times (0 = until stopped), vars}. The canvas runs as saved. */
  app.post('/api/batch', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { canvasId?: string; questions?: unknown; times?: number; vars?: unknown };
    const row = body.canvasId ? canvasFor(req.user!, body.canvasId) : undefined;
    if (!row) return reply.code(404).send({ error: 'Save the canvas first, then run it repeatedly' });
    const questions = (Array.isArray(body.questions) ? body.questions : []).map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, 10_000);
    let vars: Record<string, string>;
    try {
      vars = checkVars(body.vars);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const { graph, providerUser } = runSetup(req.user!, row, undefined);
    try {
      validateGraph(graph!);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const user = req.user!;
    return startBatch({
      ownerId: user.id,
      canvasId: row.id,
      canvasName: row.name,
      graph: graph!,
      questions,
      times: Math.max(0, Math.min(100_000, Math.floor(Number(body.times) || 0))),
      vars,
      start: (question, v) =>
        startRun({ ownerId: user.id, user, canvasId: row.id, graph: graph!, question, vars: v, resolve: resolverFor(providerUser), freeGpu: gpuFreerFor(providerUser), training: trainingFor(user) }),
    });
  });

  app.post('/api/batch/stop', { preHandler: requireUser }, async (req, reply) =>
    stopBatch(req.user!.id) ? { ok: true } : reply.code(404).send({ error: 'Nothing is running repeatedly' }),
  );

  app.get('/api/runs', { preHandler: requireUser }, async (req): Promise<RunSummary[]> =>
    (
      db
        .prepare(
          `SELECT r.id, r.canvas_id, r.question, r.status, r.started_at, r.finished_at, r.final, r.cost, c.name AS canvas_name
           FROM runs r LEFT JOIN canvases c ON c.id = r.canvas_id
           WHERE r.owner_id = ? ORDER BY r.started_at DESC LIMIT 200`,
        )
        .all(req.user!.id) as Record<string, any>[]
    ).map((r) => ({
      id: r.id,
      canvasId: r.canvas_id ?? undefined,
      canvasName: r.canvas_name ?? undefined,
      question: r.question,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      final: r.final ?? undefined,
      cost: r.cost ?? undefined,
    })),
  );

  /** One stored run with all its events, for replaying it as an animation. */
  app.get('/api/runs/:id', { preHandler: requireUser }, async (req, reply) => {
    const row = db
      .prepare('SELECT id, question, status, started_at, finished_at, final, cost, events FROM runs WHERE id = ? AND owner_id = ?')
      .get((req.params as { id: string }).id, req.user!.id) as Record<string, any> | undefined;
    if (!row) return reply.code(404).send({ error: 'Run not found' });
    if (row.status === 'running') return reply.code(409).send({ error: 'This run is still going' });
    const events = JSON.parse(row.events ?? '[]') as RunEvent[];
    return { id: row.id, question: row.question, status: row.status, final: row.final ?? undefined, cost: row.cost ?? undefined, outputs: nodeOutputs(events), events };
  });

  app.delete('/api/runs/:id', { preHandler: requireUser }, async (req) => {
    db.prepare("DELETE FROM runs WHERE id = ? AND owner_id = ? AND status != 'running'").run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });

  app.delete('/api/runs', { preHandler: requireUser }, async (req) => {
    db.prepare("DELETE FROM runs WHERE owner_id = ? AND status != 'running'").run(req.user!.id);
    return { ok: true };
  });

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
