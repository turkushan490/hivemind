// H13 — Night work settings + "run it now". Settings are admin-only; running now is for an admin or the robot token
// ("Jarvis, run the night work now" / "sort the memory").
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from './auth.js';
import { nightSettings, runNightWork, saveNightSettings } from '../services/nightWork.js';
import { logError } from '../errors.js';

export function nightWorkRoutes(app: FastifyInstance) {
  app.get('/api/settings/night-work', { preHandler: requireAdmin }, async () => nightSettings());

  app.put('/api/settings/night-work', { preHandler: requireAdmin }, async (req) => {
    const b = (req.body ?? {}) as Partial<ReturnType<typeof nightSettings>>;
    return saveNightSettings(b, req.user!.id);
  });

  /** Start the night work now (admin, or the robot token). Runs in the background; returns at once. */
  app.post('/api/night-work/run', { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    if (!(u.role === 'admin' || u.scope?.robot)) return reply.code(403).send({ error: 'Only an admin or a robot token can start the night work' });
    runNightWork('asked now').catch((err) => logError({ source: 'server', message: `Night work failed: ${(err as Error).message}` }));
    return { started: true };
  });
}
