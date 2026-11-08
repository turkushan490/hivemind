import type { FastifyInstance, FastifyReply } from 'fastify';
import { deleteSkill, deleteSkillFile, exportSkill, importSkillGithub, importSkillZip, listSkills, readSkillFile, saveSkill, shareSkill, skillView, writeSkillFile } from '../services/skills.js';
import { requireAdmin, requireUser } from './auth.js';

type Params = { id: string };

async function safe(reply: FastifyReply, fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (!code) throw e;
    return reply.code(code).send({ error: (e as Error).message });
  }
}

/** Settings → Skills: your own skills and the shared ones (limited API tokens may only read them). */
export function skillRoutes(app: FastifyInstance) {
  // A limited token changes skills only when its scope says skills: true (scope.ts lets those routes through).
  const noTokens = async (req: { user?: { scope?: { skills?: boolean } } }, reply: FastifyReply) => {
    if (req.user?.scope && req.user.scope.skills !== true) return reply.code(403).send({ error: 'This API token may not change skills' });
  };

  app.get('/api/skills', { preHandler: requireUser }, async (req) => listSkills(req.user!));

  app.get('/api/skills/:id', { preHandler: requireUser }, async (req, reply) => safe(reply, () => skillView(req.user!, (req.params as Params).id)));

  /** A new skill from the editor: {skillMd: "---\nname: …"} (more files can be added after). */
  app.post('/api/skills', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => {
      const md = (req.body as { skillMd?: unknown } | undefined)?.skillMd;
      if (typeof md !== 'string') return reply.code(400).send({ error: 'Send {skillMd}' });
      return saveSkill(req.user!, [{ path: 'SKILL.md', data: Buffer.from(md) }]);
    }),
  );

  /** A .zip with SKILL.md at the top or in one folder. */
  app.post('/api/skills/import', { preHandler: [requireUser, noTokens], bodyLimit: 30 * 1024 * 1024 }, async (req, reply) =>
    safe(reply, () => {
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the .zip as application/zip' });
      return importSkillZip(req.user!, req.body);
    }),
  );

  /** {repo: "owner/name", path?: "skills/my-skill", ref?: "main"}. */
  app.post('/api/skills/import/github', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => importSkillGithub(req.user!, (req.body ?? {}) as Record<string, unknown>)),
  );

  app.get('/api/skills/:id/file', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => ({ text: readSkillFile(req.user!, (req.params as Params).id, String((req.query as { path?: string }).path ?? '')) })),
  );

  app.put('/api/skills/:id/file', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => {
      const b = (req.body ?? {}) as { path?: unknown; text?: unknown };
      if (typeof b.text !== 'string') return reply.code(400).send({ error: 'Send {path, text}' });
      return writeSkillFile(req.user!, (req.params as Params).id, String(b.path ?? ''), b.text);
    }),
  );

  app.delete('/api/skills/:id/file', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => deleteSkillFile(req.user!, (req.params as Params).id, String((req.query as { path?: string }).path ?? ''))),
  );

  app.delete('/api/skills/:id', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => {
      deleteSkill(req.user!, (req.params as Params).id);
      return { ok: true };
    }),
  );

  /** Admins: share a skill with every user (or stop sharing it). */
  app.put('/api/skills/:id/shared', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => {
      skillView(req.user!, (req.params as Params).id);
      shareSkill((req.params as Params).id, !!(req.body as { shared?: unknown } | undefined)?.shared);
      return skillView(req.user!, (req.params as Params).id);
    }),
  );

  app.get('/api/skills/:id/zip', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const { name, zip } = exportSkill(req.user!, (req.params as Params).id);
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip`).send(zip);
    }),
  );
}
