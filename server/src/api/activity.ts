import type { ActiveTraining, ActivityRunning } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { activeRuns, isFullAdmin } from '../events/runs.js';
import { apiCalls, liveCalls } from '../services/activity.js';
import { requireUser } from './auth.js';

/** Training states that hold (or are about to take) the GPU. */
const TRAINING_NOW = ['starting', 'waiting', 'loading', 'training', 'exporting', 'importing'];

/**
 * Activity page: what is running now and what came in through the API. A full admin sees everything, anyone
 * else only their own. Not in SCOPED_ROUTES: limited API tokens can't read it.
 */
export function activityRoutes(app: FastifyInstance) {
  app.get('/api/activity/running', { preHandler: requireUser }, async (req): Promise<ActivityRunning> => {
    const user = req.user!;
    const all = isFullAdmin(user);
    const training = (
      db
        .prepare(
          `SELECT t.id, t.name, t.base, t.state, t.started_at, u.username FROM lab_trains t JOIN users u ON u.id = t.owner_id
           WHERE t.state IN (${TRAINING_NOW.map(() => '?').join(', ')}) ${all ? '' : 'AND t.owner_id = ?'} ORDER BY t.started_at`,
        )
        .all(...TRAINING_NOW, ...(all ? [] : [user.id])) as { id: string; name: string; base: string; state: string; started_at: string; username: string }[]
    ).map((t): ActiveTraining => ({ id: t.id, name: t.name, base: t.base, state: t.state, owner: t.username, startedAt: t.started_at }));
    return { runs: activeRuns(user), training, apiCalls: liveCalls(all ? undefined : user.id) };
  });

  /** ?limit=200 (at most 1000), ?token=<name>, ?failed=1. */
  app.get('/api/activity/calls', { preHandler: requireUser }, async (req) => {
    const q = (req.query ?? {}) as { limit?: string; token?: string; failed?: string };
    const user = req.user!;
    return apiCalls({
      ownerId: isFullAdmin(user) ? undefined : user.id,
      limit: q.limit ? Number(q.limit) : 200,
      token: q.token || undefined,
      failed: ['1', 'true'].includes(String(q.failed ?? '')),
    });
  });
}
