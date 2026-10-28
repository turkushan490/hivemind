import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../crypto.js';
import { db } from '../db/index.js';

export const ROLES = ['admin', 'user', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  username: string;
  /** admin: everything; user: builds and runs own canvases; viewer: only uses canvases in Use mode. */
  role: Role;
  /** Set when an API token is limited to some canvases and memory keys (see scope.ts). */
  scope?: TokenScope;
}

/** What a limited API token may use: canvas ids and memory keys, exact or ending in "*" ("dnd-*", "rules:*"). */
export interface TokenScope {
  canvases: string[];
  memory: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

const COOKIE = 'hm_session';
const SESSION_DAYS = 30;

const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

function findUserBySession(token: string): User | undefined {
  return db
    .prepare('SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha256(token), Date.now()) as User | undefined;
}

function findUserByApiToken(token: string): User | undefined {
  const row = db
    .prepare('SELECT u.id, u.username, u.role, t.id AS tid, t.scope FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
    .get(sha256(token)) as (User & { tid: string; scope: string | null }) | undefined;
  if (!row) return;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.tid);
  return { id: row.id, username: row.username, role: row.role, ...(row.scope && { scope: JSON.parse(row.scope) as TokenScope }) };
}

/** Session cookie for the web UI, `Authorization: Bearer hm_…` for apps (phone, Home Assistant). */
export function authenticate(req: FastifyRequest): User | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return findUserByApiToken(auth.slice(7).trim());
  const cookie = req.cookies[COOKIE];
  return cookie ? findUserBySession(cookie) : undefined;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  req.user = authenticate(req);
  if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  req.user = authenticate(req);
  if (!req.user) return reply.code(401).send({ error: 'Not logged in' });
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Admins only' });
}

/**
 * The only writes a viewer may make: log in and out, run (saved) canvases, cancel and clear their own runs,
 * voice, their own API tokens, and the Problems list. Everything else is refused for viewers in viewerGuard.
 */
export const VIEWER_WRITES = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/setup',
  'POST /api/problems/report',
  'POST /api/problems/seen',
  'POST /api/runs',
  'POST /api/runs/:id/cancel',
  'DELETE /api/runs/:id',
  'DELETE /api/runs',
  'POST /api/voice/transcribe',
  'POST /api/voice/speak',
  'POST /api/tokens',
  'DELETE /api/tokens/:id',
  'POST /v1/chat/completions',
]);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** onRequest hook: checks the role on every write route, before the route runs. */
export async function viewerGuard(req: FastifyRequest, reply: FastifyReply) {
  if (!WRITE_METHODS.has(req.method)) return;
  const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
  if (VIEWER_WRITES.has(route)) return;
  const user = authenticate(req);
  if (user?.role === 'viewer') return reply.code(403).send({ error: 'Viewers can only use canvases (ask an admin for more rights)' });
}

// Simple in-memory brute-force guard: 10 failed logins per IP per 15 minutes.
const failures = new Map<string, { n: number; until: number }>();
function tooManyFailures(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.until > Date.now() && f.n >= 10;
}
function noteFailure(ip: string) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else f.n++;
}

function validCredentials(username: unknown, password: unknown): string | undefined {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return 'Username: 3-32 letters, digits, _ . -';
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
}

function startSession(reply: FastifyReply, userId: string) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: SESSION_DAYS * 86400 });
}

export function createUser(username: string, pwHash: string, role: Role): string {
  const id = newId();
  db.prepare('INSERT INTO users (id, username, pw_hash, role) VALUES (?, ?, ?, ?)').run(id, username, pwHash, role);
  return id;
}

export function authRoutes(app: FastifyInstance) {
  app.get('/api/setup', async () => ({ needsSetup: userCount() === 0 }));

  // First run: whoever opens the app first creates the admin account.
  app.post('/api/setup', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already done' });
    const bad = validCredentials(username, password);
    if (bad) return reply.code(400).send({ error: bad });
    const id = createUser(username as string, await hashPassword(password as string), 'admin');
    startSession(reply, id);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (tooManyFailures(req.ip)) return reply.code(429).send({ error: 'Too many attempts, try again later' });
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const row = db.prepare('SELECT id, pw_hash FROM users WHERE username = ?').get(String(username ?? '')) as { id: string; pw_hash: string } | undefined;
    if (!row || !(await verifyPassword(String(password ?? ''), row.pw_hash))) {
      noteFailure(req.ip);
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    startSession(reply, row.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookie = req.cookies[COOKIE];
    if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(cookie));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => req.user);

  // ---- Users (admin) ----
  app.get('/api/users', { preHandler: requireAdmin }, async () =>
    db.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY created_at').all(),
  );

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { username, password, role } = (req.body ?? {}) as Record<string, unknown>;
    const bad = validCredentials(username, password);
    if (bad) return reply.code(400).send({ error: bad });
    try {
      return { id: createUser(username as string, await hashPassword(password as string), ROLES.includes(role as Role) ? (role as Role) : 'user') };
    } catch {
      return reply.code(409).send({ error: 'Username already taken' });
    }
  });

  /** Change a user's role and/or set a new password. */
  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, password } = (req.body ?? {}) as { role?: string; password?: string };
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as { id: string; role: Role } | undefined;
    if (!target) return reply.code(404).send({ error: 'No such user' });
    if (role !== undefined) {
      if (!ROLES.includes(role as Role)) return reply.code(400).send({ error: `Role must be one of ${ROLES.join(', ')}` });
      if (id === req.user!.id && role !== 'admin') return reply.code(400).send({ error: "You can't take away your own admin rights" });
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(password), id);
      // Logged out everywhere except the admin's own session.
      if (id !== req.user!.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    return db.prepare('SELECT id, username, role, created_at AS createdAt FROM users WHERE id = ?').get(id);
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user!.id) return reply.code(400).send({ error: "You can't delete yourself" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---- API tokens: each user makes their own for the phone app, Home Assistant, scripts ----
  app.get('/api/tokens', { preHandler: requireUser }, async (req) =>
    (
      db
        .prepare('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, scope FROM api_tokens WHERE user_id = ? ORDER BY created_at')
        .all(req.user!.id) as { scope: string | null }[]
    ).map(({ scope, ...t }) => ({ ...t, ...(scope && { scope: JSON.parse(scope) }) })),
  );

  app.post('/api/tokens', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; canvases?: unknown; memory?: unknown };
    const name = String(body.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Give the token a name' });
    // A limited token can't make tokens with more rights than itself.
    if (req.user!.scope) return reply.code(403).send({ error: 'A limited API token cannot make new tokens' });
    const list = (v: unknown, what: string) => {
      if (v === undefined || v === null) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 120)) throw new Error(`${what} must be a list of ids or patterns like "dnd-*"`);
      return [...new Set((v as string[]).map((x) => x.trim()))];
    };
    let scope: TokenScope | undefined;
    try {
      const canvases = list(body.canvases, 'canvases');
      const memory = list(body.memory, 'memory');
      if (canvases || memory) scope = { canvases: canvases ?? [], memory: memory ?? [] };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const token = `hm_${randomToken(24)}`;
    const id = newId();
    db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      req.user!.id,
      name,
      sha256(token),
      token.slice(0, 7),
      scope ? JSON.stringify(scope) : null,
    );
    // Only time the full token is shown.
    return { id, name, token, ...(scope && { scope }) };
  });

  app.delete('/api/tokens/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });
}
