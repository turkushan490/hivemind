import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { deleteSchedule, getSchedule, saveSchedule } from '../services/schedules.js';
import { requireUser, type User } from './auth.js';
import { canvasFor, startCanvasRun } from './runs.js';

/** Schedules: a workflow (yours or a shared one) runs by itself at a time of day, as you. */
export function scheduleRoutes(app: FastifyInstance) {
  const canvasId = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/api/workflows/:id/schedule', { preHandler: requireUser }, async (req, reply) => {
    if (!canvasFor(req.user!, canvasId(req))) return reply.code(404).send({ error: 'Workflow not found' });
    return getSchedule(req.user!.id, canvasId(req)) ?? reply.code(404).send({ error: 'This workflow has no schedule' });
  });

  app.put('/api/workflows/:id/schedule', { preHandler: requireUser }, async (req, reply) => {
    if (!canvasFor(req.user!, canvasId(req))) return reply.code(404).send({ error: 'Workflow not found (save it first)' });
    return saveSchedule(req.user!.id, canvasId(req), (req.body ?? {}) as Record<string, unknown>);
  });

  app.delete('/api/workflows/:id/schedule', { preHandler: requireUser }, async (req, reply) =>
    deleteSchedule(req.user!.id, canvasId(req)) ? { ok: true } : reply.code(404).send({ error: 'This workflow has no schedule' }),
  );
}

/** What the minute ticker does for a due schedule: run the saved workflow like POST /api/runs, as its owner. */
export function runScheduled(s: { canvasId: string; ownerId: string; time: string }) {
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(s.ownerId) as User | undefined;
  if (!user) throw new Error('its owner no longer exists');
  startCanvasRun(user, { canvasId: s.canvasId, question: `Scheduled run (${s.time})` }, { scheduled: true });
}
