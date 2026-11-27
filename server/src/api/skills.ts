import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Skill } from '@hivemind/shared';
import { deleteSkill, deleteSkillFile, exportSkill, importSkillFiles, importSkillGithub, importSkillZip, listSkills, lockSkill, readSkillFile, saveSkill, shareSkill, skillView, writeSkillFile } from '../services/skills.js';
import { isUnlocked } from '../services/unlock.js';
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

  // ?hidden=1 on a new or imported skill (unlock mode on): it is made as a locked skill.
  const mayLock = (req: { user?: Parameters<typeof isUnlocked>[0]; query: unknown }) => {
    const h = (req.query as { hidden?: string } | undefined)?.hidden;
    if ((h === '1' || h === 'true') && (!req.user || !isUnlocked(req.user))) throw Object.assign(new Error('Turn on unlock mode first'), { statusCode: 403 });
  };
  const lockNew = <T,>(req: { user?: unknown; query: unknown }, out: T): T => {
    const h = (req.query as { hidden?: string } | undefined)?.hidden;
    // Only a result with skills in it (an error reply passes through untouched).
    if ((h !== '1' && h !== 'true') || !out || typeof out !== 'object' || !('skill' in out)) return out;
    const r = out as unknown as { skill?: Skill; skills?: Skill[] };
    const user = req.user as Parameters<typeof lockSkill>[0];
    const locked = (r.skills ?? (r.skill ? [r.skill] : [])).map((s) => lockSkill(user, s.id, true));
    return { ...r, ...(r.skill && { skill: locked[0] }), ...(r.skills && { skills: locked }) } as unknown as T;
  };

  /** Lock (hide) or unlock a skill: {hidden: boolean}. Only its owner, only while unlocked. */
  app.put('/api/skills/:id/hidden', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => {
      if (!isUnlocked(req.user!)) return reply.code(403).send({ error: 'Turn on unlock mode first' });
      return lockSkill(req.user!, (req.params as Params).id, !!(req.body as { hidden?: unknown } | undefined)?.hidden);
    }),
  );

  app.get('/api/skills/:id', { preHandler: requireUser }, async (req, reply) => safe(reply, () => skillView(req.user!, (req.params as Params).id)));

  /** A new skill from the editor: {skillMd: "---\nname: …"} (more files can be added after). */
  app.post('/api/skills', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, () => {
      mayLock(req);
      const md = (req.body as { skillMd?: unknown } | undefined)?.skillMd;
      if (typeof md !== 'string') return reply.code(400).send({ error: 'Send {skillMd}' });
      return lockNew(req, saveSkill(req.user!, [{ path: 'SKILL.md', data: Buffer.from(md) }]));
    }),
  );

  /**
   * Skills in any format (Claude, Codex/ChatGPT, OpenCode/T3, Cursor, Copilot, Gemini, plain markdown, JSON, YAML,
   * TOML), one or many:
   * - raw body (application/zip or application/octet-stream, ?name=<file name>): a .zip / .skill / .tar(.gz) or one file;
   * - JSON {files: [{path, data (base64) | text}]}: a folder picked in the browser, or several files;
   * - JSON {text, name?}: pasted instructions.
   */
  app.post('/api/skills/import', { preHandler: [requireUser, noTokens], bodyLimit: 40 * 1024 * 1024 }, async (req, reply) =>
    safe(reply, () => lockNew(req, (() => {
      mayLock(req);
      const name = String((req.query as { name?: string }).name ?? '').slice(0, 200);
      if (Buffer.isBuffer(req.body)) return importSkillZip(req.user!, req.body, name);
      const b = (req.body ?? {}) as { files?: unknown; text?: unknown; name?: unknown };
      if (typeof b.text === 'string') {
        const n = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'pasted.md';
        return importSkillZip(req.user!, Buffer.from(b.text), /\.[a-z]+$/i.test(n) ? n : `${n}.md`);
      }
      if (Array.isArray(b.files) && b.files.length) {
        if (b.files.length > 2000) return reply.code(413).send({ error: 'Too many files' });
        const files = b.files.map((f: { path?: unknown; data?: unknown; text?: unknown }) => ({
          path: String(f.path ?? ''),
          data: typeof f.text === 'string' ? Buffer.from(f.text) : Buffer.from(String(f.data ?? ''), 'base64'),
        }));
        // One archive picked among the files: unpack it.
        if (files.length === 1) return importSkillZip(req.user!, files[0].data, files[0].path);
        const top = files[0].path.replace(/\\/g, '/').split('/')[0];
        return importSkillFiles(req.user!, files, { hintName: files.every((f) => f.path.replace(/\\/g, '/').startsWith(`${top}/`)) ? top : undefined });
      }
      return reply.code(415).send({ error: 'Send a file (.zip, .skill, .tar.gz, .md, .json, …), {files: [...]} or {text}' });
    })())),
  );

  /** {repo: "owner/name", path?: "skills/my-skill", ref?: "main"}. */
  app.post('/api/skills/import/github', { preHandler: [requireUser, noTokens] }, async (req, reply) =>
    safe(reply, async () => (mayLock(req), lockNew(req, await importSkillGithub(req.user!, (req.body ?? {}) as Record<string, unknown>)))),
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
