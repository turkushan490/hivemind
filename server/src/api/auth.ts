import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../crypto.js';
import { db } from '../db/index.js';

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
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
    .prepare('SELECT u.id, u.username, u.role, t.id AS tid FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
    .get(sha256(token)) as (User & { tid: string }) | undefined;
  if (!row) return;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.tid);
  return { id: row.id, username: row.username, role: row.role };
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

export function createUser(username: string, pwHash: string, role: 'admin' | 'user'): string {
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
      return { id: createUser(username as string, await hashPassword(password as string), role === 'admin' ? 'admin' : 'user') };
    } catch {
      return reply.code(409).send({ error: 'Username already taken' });
    }
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user!.id) return reply.code(400).send({ error: "You can't delete yourself" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---- API tokens: each user makes their own for the phone app, Home Assistant, scripts ----
  app.get('/api/tokens', { preHandler: requireUser }, async (req) =>
    db
      .prepare('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? ORDER BY created_at')
      .all(req.user!.id),
  );

  app.post('/api/tokens', { preHandler: requireUser }, async (req, reply) => {
    const name = String((req.body as { name?: string })?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Give the token a name' });
    const token = `hm_${randomToken(24)}`;
    const id = newId();
    db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?, ?)').run(id, req.user!.id, name, sha256(token), token.slice(0, 7));
    // Only time the full token is shown.
    return { id, name, token };
  });

  app.delete('/api/tokens/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run((req.params as { id: string }).id, req.user!.id);
    return { ok: true };
  });
}
