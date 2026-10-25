import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { logError } from '../errors.js';
import { authenticate, requireUser } from './auth.js';

/** Admins see every problem; users see their own plus server-wide ones. */
const scope = (admin: boolean) => (admin ? '1 = 1' : '(user_id = ? OR user_id IS NULL)');

export function problemRoutes(app: FastifyInstance) {
  app.get('/api/problems', { preHandler: requireUser }, async (req) => {
    const admin = req.user!.role === 'admin';
    const args = admin ? [] : [req.user!.id];
    return db
      .prepare(
        `SELECT id, at, source, message, detail, run_id AS runId, seen FROM error_log WHERE ${scope(admin)} ORDER BY id DESC LIMIT 200`,
      )
      .all(...args)
      .map((r: any) => ({ ...r, seen: !!r.seen }));
  });

  app.get('/api/problems/unseen', { preHandler: requireUser }, async (req) => {
    const admin = req.user!.role === 'admin';
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM error_log WHERE seen = 0 AND ${scope(admin)}`)
      .get(...(admin ? [] : [req.user!.id])) as { n: number };
    return { unseen: row.n };
  });

  app.post('/api/problems/seen', { preHandler: requireUser }, async (req) => {
    const admin = req.user!.role === 'admin';
    db.prepare(`UPDATE error_log SET seen = 1 WHERE ${scope(admin)}`).run(...(admin ? [] : [req.user!.id]));
    return { ok: true };
  });

  app.delete('/api/problems', { preHandler: requireUser }, async (req) => {
    const admin = req.user!.role === 'admin';
    db.prepare(`DELETE FROM error_log WHERE ${admin ? '1 = 1' : 'user_id = ?'}`).run(...(admin ? [] : [req.user!.id]));
    return { ok: true };
  });

  // The web page reports its own crashes here (also before login, so the login page can't fail silently).
  const recent: number[] = [];
  app.post('/api/problems/report', async (req, reply) => {
    const now = Date.now();
    while (recent.length && recent[0] < now - 60_000) recent.shift();
    if (recent.length >= 30) return reply.code(429).send({ error: 'Too many reports' });
    recent.push(now);
    const body = (req.body ?? {}) as { message?: string; detail?: string };
    if (!body.message) return reply.code(400).send({ error: 'message required' });
    const id = logError({ source: 'web', message: String(body.message), detail: body.detail ? String(body.detail) : undefined, userId: authenticate(req)?.id });
    return { id };
  });
}
