import { EVERYTHING_PROFILE, type AccessOverview } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { cleanProviders, getProfile, keepComfyCopy, listProfiles, newUsersProfile, setKeepComfyCopy, setNewUsersProfile, userProfileId } from '../services/access.js';
import { requireAdmin } from './auth.js';

/** Settings → Access (admins): access profiles, who has which, and the ComfyUI copy option. */
export function accessRoutes(app: FastifyInstance) {
  app.get('/api/access', { preHandler: requireAdmin }, async (): Promise<AccessOverview> => {
    const users = db.prepare('SELECT id, username, role FROM users ORDER BY created_at').all() as { id: string; username: string; role: 'admin' | 'user' | 'viewer' }[];
    const tokens = db
      .prepare('SELECT t.id, t.name, t.prefix, t.user_id AS userId, u.username, t.profile_id AS profileId FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY u.username, t.created_at')
      .all() as { id: string; name: string; prefix: string; userId: string; username: string; profileId: string | null }[];
    return {
      profiles: listProfiles(),
      users: users.map((u) => ({ ...u, profileId: userProfileId(u) })),
      tokens: tokens.map(({ profileId, ...t }) => ({ ...t, ...(profileId && { profileId }) })),
      newUsers: newUsersProfile(),
      keepComfyCopy: keepComfyCopy(),
    };
  });

  app.post('/api/access/profiles', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; providers?: unknown };
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Give the profile a name' });
    const providers = cleanProviders(body.providers ?? {});
    const id = newId();
    try {
      db.prepare('INSERT INTO access_profiles (id, name, providers) VALUES (?, ?, ?)').run(id, name, JSON.stringify(providers));
    } catch {
      return reply.code(409).send({ error: `There is already a profile called "${name}"` });
    }
    return getProfile(id);
  });

  app.put('/api/access/profiles/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === EVERYTHING_PROFILE) return reply.code(400).send({ error: 'Everything is built in and cannot be changed' });
    const cur = getProfile(id);
    if (!cur) return reply.code(404).send({ error: 'No such profile' });
    const body = (req.body ?? {}) as { name?: unknown; providers?: unknown };
    const name = body.name === undefined ? cur.name : String(body.name).trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Give the profile a name' });
    const providers = body.providers === undefined ? cur.providers : cleanProviders(body.providers);
    try {
      db.prepare('UPDATE access_profiles SET name = ?, providers = ? WHERE id = ?').run(name, JSON.stringify(providers), id);
    } catch {
      return reply.code(409).send({ error: `There is already a profile called "${name}"` });
    }
    return getProfile(id);
  });

  /** Its users go back to the "New users get" profile; its tokens to what their user has. */
  app.delete('/api/access/profiles/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === EVERYTHING_PROFILE) return reply.code(400).send({ error: 'Everything is built in and cannot be deleted' });
    if (!getProfile(id)) return reply.code(404).send({ error: 'No such profile' });
    if (id === newUsersProfile()) return reply.code(400).send({ error: 'New users get this profile: pick another one for them first' });
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET profile_id = ? WHERE profile_id = ?').run(newUsersProfile(), id);
      db.prepare('UPDATE api_tokens SET profile_id = NULL WHERE profile_id = ?').run(id);
      db.prepare('DELETE FROM access_profiles WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true };
  });

  app.put('/api/access/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { newUsers?: unknown; keepComfyCopy?: unknown };
    if (body.newUsers !== undefined) {
      if (typeof body.newUsers !== 'string' || !getProfile(body.newUsers)) return reply.code(400).send({ error: 'No such profile' });
      setNewUsersProfile(body.newUsers);
    }
    if (body.keepComfyCopy !== undefined) {
      if (typeof body.keepComfyCopy !== 'boolean') return reply.code(400).send({ error: 'keepComfyCopy must be true or false' });
      setKeepComfyCopy(body.keepComfyCopy);
    }
    return { newUsers: newUsersProfile(), keepComfyCopy: keepComfyCopy() };
  });

  /** Body: {profileId}. Admins always have Everything. */
  app.put('/api/access/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const profileId = (req.body as { profileId?: unknown } | undefined)?.profileId;
    if (typeof profileId !== 'string' || !getProfile(profileId)) return reply.code(400).send({ error: 'No such profile' });
    if (!db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(profileId, id).changes) return reply.code(404).send({ error: 'No such user' });
    return { ok: true };
  });

  /** Body: {profileId} or {profileId: null} (the token has what its user has). */
  app.put('/api/access/tokens/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const profileId = (req.body as { profileId?: unknown } | undefined)?.profileId;
    if (profileId !== null && (typeof profileId !== 'string' || !getProfile(profileId))) return reply.code(400).send({ error: 'No such profile' });
    if (!db.prepare('UPDATE api_tokens SET profile_id = ? WHERE id = ?').run(profileId, id).changes) return reply.code(404).send({ error: 'No such token' });
    return { ok: true };
  });
}
