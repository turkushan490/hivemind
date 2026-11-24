// Settings → Log file: off / on / debug, look at the end of it, download it, or clear it. Admin only.
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './auth.js';
import { clearLog, logAll, logMode, logPath, logSize, logTail, setLogMode, type LogMode } from '../logfile.js';

const state = () => ({ mode: logMode(), path: logPath(), ...logSize() });

export function logRoutes(app: FastifyInstance) {
  app.get('/api/settings/log', { preHandler: requireAdmin }, async () => state());

  app.put('/api/settings/log', { preHandler: requireAdmin }, async (req, reply) => {
    const m = (req.body as { mode?: LogMode } | undefined)?.mode;
    if (m !== 'off' && m !== 'on' && m !== 'debug') return reply.code(400).send({ error: 'mode must be off, on or debug' });
    setLogMode(m);
    return state();
  });

  app.get('/api/logs/tail', { preHandler: requireAdmin }, async (req) => {
    const n = Number((req.query as { lines?: string }).lines) || 200;
    return { text: logTail(n), ...state() };
  });

  app.get('/api/logs/download', { preHandler: requireAdmin }, async (_req, reply) => {
    const day = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="hivemind-${day}.log"`)
      .send(logAll());
  });

  app.delete('/api/logs', { preHandler: requireAdmin }, async () => {
    clearLog();
    return state();
  });
}
