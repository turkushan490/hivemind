// H11 — Memory (MD files) API, for the owner (full admin) and the robot token. A robot asks with ?guest / "guest":true
// when it is locked, and is then kept inside memory/guest only. Everything is the owner's memory under <dataDir>/memory.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from './auth.js';
import { isFullAdmin } from '../events/runs.js';
import { move, read, remove, restore, search, tree, versions, write } from '../services/memoryFiles.js';

/** The owner whose memory this is, and whether the caller may touch it at all (owner admin, or a robot token). */
function who(req: FastifyRequest, reply: FastifyReply): { userId: string } | undefined {
  const u = req.user!;
  if (isFullAdmin(u) || u.scope?.robot) return { userId: u.id };
  void reply.code(403).send({ error: 'Memory is for the owner (an admin) or a robot token' });
  return undefined;
}

const safe = async <T>(reply: FastifyReply, fn: () => T | Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    return reply.code((err as { statusCode?: number }).statusCode ?? 400).send({ error: (err as Error).message });
  }
};

export function memoryFilesRoutes(app: FastifyInstance) {
  /** The whole tree (paths, size, last change + who, preview). ?guest=1 for the guest memory. */
  app.get('/api/memory-files/tree', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const guest = String((req.query as { guest?: string }).guest ?? '') === '1';
    return { files: tree(w.userId, guest) };
  });

  /** Body: { paths: string[], guest? } → each file's content (missing = undefined). */
  app.post('/api/memory-files/read', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const b = (req.body ?? {}) as { paths?: unknown; guest?: boolean };
    const paths = Array.isArray(b.paths) ? b.paths.map(String).slice(0, 20) : [];
    return safe(reply, () => ({ files: read(w.userId, paths, !!b.guest) }));
  });

  /** Body: { path, text, mode?: replace|append, by?, guest? }. */
  app.put('/api/memory-files', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const b = (req.body ?? {}) as { path?: string; text?: string; mode?: 'replace' | 'append'; by?: string; guest?: boolean };
    if (!b.path || typeof b.text !== 'string') return reply.code(400).send({ error: 'Send { path, text }' });
    return safe(reply, () => write(w.userId, b.path!, b.text!, { mode: b.mode, by: b.by, guest: b.guest }));
  });

  /** Body: { from, to, by?, guest? }. */
  app.post('/api/memory-files/move', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const b = (req.body ?? {}) as { from?: string; to?: string; by?: string; guest?: boolean };
    if (!b.from || !b.to) return reply.code(400).send({ error: 'Send { from, to }' });
    return safe(reply, () => (move(w.userId, b.from!, b.to!, b.by, b.guest), { ok: true }));
  });

  /** Body: { path, guest? } → moves it to archive/deleted. */
  app.delete('/api/memory-files', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const b = (req.body ?? {}) as { path?: string; guest?: boolean };
    if (!b.path) return reply.code(400).send({ error: 'Send { path }' });
    return safe(reply, () => (remove(w.userId, b.path!, b.guest), { ok: true }));
  });

  /** ?q=&guest= → matches with a snippet. */
  app.get('/api/memory-files/search', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const q = req.query as { q?: string; guest?: string };
    return { results: search(w.userId, q.q ?? '', q.guest === '1') };
  });

  /** ?path=&guest= → the saved versions (newest first). */
  app.get('/api/memory-files/versions', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const q = req.query as { path?: string; guest?: string };
    if (!q.path) return reply.code(400).send({ error: 'Send ?path=' });
    return safe(reply, () => ({ versions: versions(w.userId, q.path!, q.guest === '1') }));
  });

  /** Body: { path, id, by?, guest? } → restores that version. */
  app.post('/api/memory-files/restore', { preHandler: requireUser }, async (req, reply) => {
    const w = who(req, reply);
    if (!w) return;
    const b = (req.body ?? {}) as { path?: string; id?: string; by?: string; guest?: boolean };
    if (!b.path || !b.id) return reply.code(400).send({ error: 'Send { path, id }' });
    return safe(reply, () => restore(w.userId, b.path!, b.id!, b.by, b.guest));
  });
}
