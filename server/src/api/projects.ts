import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { buildProject } from '../services/build.js';
import { connectProject, disconnectProject, gitCommit, gitLog, gitPull, gitPullRequest, gitPush, gitStatus, githubSettings, listRepos, removeGithub, saveGithubSettings, testGithub } from '../services/git.js';
import {
  checkPreviewToken,
  createProject,
  deleteProject,
  deleteProjectPath,
  getProject,
  isTextPath,
  listProjects,
  makeFolder,
  moveProjectPath,
  previewUrl,
  projectFolders,
  projectHistory,
  projectPath,
  projectTree,
  readProjectFile,
  recordChanges,
  renameProject,
  toProject,
  writeProjectFile,
  createOutsideProject,
} from '../services/projects.js';
import { createZip, readZip } from '../services/zip.js';
import { requireAdmin, requireUser } from './auth.js';
import { listOutside, outsideFolders, saveOutsideFolders } from '../services/outsideFolders.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.wasm': 'application/wasm',
};

type Params = { id: string };
const q = (req: { query: unknown }) => req.query as Record<string, string | undefined>;

/** Errors with a status (400, 404, 409, 413) go to the client as they are. */
async function safe(reply: FastifyReply, fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (!code) throw e;
    return reply.code(code).send({ error: (e as Error).message });
  }
}

export function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', { preHandler: requireUser }, async (req) => listProjects(req.user!));

  app.post('/api/projects', { preHandler: requireUser }, async (req, reply) => safe(reply, () => createProject(req.user!, (req.body as { name?: unknown } | undefined)?.name)));

  // Folders of other apps (T3 Code's /projects): the switch, the allowed roots, and their folders. Admins only.
  app.get('/api/outside-folders', { preHandler: requireAdmin }, async () => ({ ...outsideFolders(), list: listOutside() }));
  app.put('/api/outside-folders', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => ({ ...saveOutsideFolders((req.body ?? {}) as { enabled?: boolean; roots?: string[] }), list: listOutside() })),
  );
  /** Opens one of those folders as a project, in place: { path, name? }. */
  app.post('/api/projects/outside', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => {
      const b = (req.body ?? {}) as { path?: unknown; name?: unknown };
      return createOutsideProject(req.user!, b.path, b.name);
    }),
  );

  app.get('/api/projects/:id', { preHandler: requireUser }, async (req, reply) => safe(reply, () => toProject(getProject(req.user!, (req.params as Params).id))));

  app.patch('/api/projects/:id', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => renameProject(req.user!, (req.params as Params).id, (req.body as { name?: unknown } | undefined)?.name)),
  );

  app.delete('/api/projects/:id', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      deleteProject(req.user!, (req.params as Params).id);
      return { ok: true };
    }),
  );

  /** Every file (not .git) and folder, plus a fresh preview link. */
  app.get('/api/projects/:id/tree', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const p = getProject(req.user!, (req.params as Params).id);
      return { files: projectTree(p), folders: projectFolders(p), previewUrl: previewUrl(p.id) };
    }),
  );

  /** A file: ?path=… (text as JSON {path, text}; ?raw=1 for the file itself, as a download). */
  app.get('/api/projects/:id/file', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const p = getProject(req.user!, (req.params as Params).id);
      const path = q(req).path ?? '';
      const data = readProjectFile(p, path);
      if (q(req).raw === '1' || !isTextPath(path)) {
        return reply
          .header('content-type', 'application/octet-stream')
          .header('x-content-type-options', 'nosniff')
          .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`)
          .send(data);
      }
      return { path, text: data.toString('utf8') };
    }),
  );

  /** Saves a file: JSON {text} (the editor) or the raw file body (upload). ?path=… */
  app.put('/api/projects/:id/file', { preHandler: requireUser, bodyLimit: 60 * 1024 * 1024 }, async (req, reply) =>
    safe(reply, () => {
      const p = getProject(req.user!, (req.params as Params).id);
      const path = q(req).path ?? '';
      const body = req.body as Buffer | { text?: unknown } | undefined;
      const data = Buffer.isBuffer(body) ? body : typeof body?.text === 'string' ? body.text : undefined;
      if (data === undefined) return reply.code(400).send({ error: 'Send {text} or the file itself' });
      const change = writeProjectFile(p, path, data);
      recordChanges(p.id, [change], Buffer.isBuffer(body) ? 'Upload' : 'Editor');
      return change;
    }),
  );

  app.delete('/api/projects/:id/file', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const p = getProject(req.user!, (req.params as Params).id);
      const changes = deleteProjectPath(p, q(req).path ?? '');
      recordChanges(p.id, changes, 'Deleted');
      return { ok: true, changes };
    }),
  );

  app.post('/api/projects/:id/folder', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      makeFolder(getProject(req.user!, (req.params as Params).id), String((req.body as { path?: unknown } | undefined)?.path ?? ''));
      return { ok: true };
    }),
  );

  app.post('/api/projects/:id/move', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const b = (req.body ?? {}) as { from?: unknown; to?: unknown };
      moveProjectPath(getProject(req.user!, (req.params as Params).id), String(b.from ?? ''), String(b.to ?? ''));
      return { ok: true };
    }),
  );

  /** Upload a .zip: its files go into the project (optionally under ?folder=), replacing ones with the same path. */
  app.post('/api/projects/:id/zip', { preHandler: requireUser, bodyLimit: 200 * 1024 * 1024 }, async (req, reply) =>
    safe(reply, () => {
      const p = getProject(req.user!, (req.params as Params).id);
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the .zip as application/zip' });
      const folder = (q(req).folder ?? '').replace(/^\/+|\/+$/g, '');
      const entries = readZip(req.body, { file: 50 * 1024 * 1024, total: 200 * 1024 * 1024 }) as { name: string; data: Buffer }[];
      // A zip with everything in one top folder (as most exports are) is unpacked without that folder.
      const names = entries.map((e) => e.name.replace(/\\/g, '/')).filter((n) => !n.endsWith('/'));
      const tops = new Set(names.map((n) => n.split('/')[0]));
      const strip = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
      const changes = [];
      const refused: string[] = [];
      for (const e of entries) {
        const name = e.name.replace(/\\/g, '/');
        if (name.endsWith('/') || name.split('/').includes('__MACOSX')) continue;
        const rel = `${folder ? `${folder}/` : ''}${name.slice(strip.length)}`;
        try {
          changes.push(writeProjectFile(p, rel, e.data));
        } catch (err) {
          refused.push(`${rel}: ${(err as Error).message}`);
        }
      }
      recordChanges(p.id, changes, 'Zip upload');
      return { added: changes.filter((c) => c.status !== 'skipped').length, refused };
    }),
  );

  /** The whole project as a .zip (not .git). */
  app.get('/api/projects/:id/zip', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const p = getProject(req.user!, (req.params as Params).id);
      const zip = createZip(projectTree(p).map((f) => ({ name: `${p.name}/${f.path}`, data: readProjectFile(p, f.path) })));
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.name.replace(/[\\/:*?"<>|]+/g, '-'))}.zip`)
        .send(zip);
    }),
  );

  /** What runs and edits changed, newest first. */
  app.get('/api/projects/:id/history', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, async () => {
      const p = getProject(req.user!, (req.params as Params).id);
      return { changes: projectHistory(p.id), commits: await gitLog(p) };
    }),
  );

  // ---- Build ----
  app.post('/api/projects/:id/build', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      if (req.user!.scope) return reply.code(403).send({ error: 'This API token may not build projects' });
      const p = getProject(req.user!, (req.params as Params).id);
      const b = (req.body ?? {}) as { script?: string; outDir?: string };
      return buildProject(p, { script: b.script, outDir: b.outDir });
    }),
  );

  // ---- Git ----
  app.get('/api/projects/:id/git', { preHandler: requireUser }, async (req, reply) => safe(reply, () => gitStatus(getProject(req.user!, (req.params as Params).id))));

  /** Body: {repo: "owner/name", branch?, create?: true (a new private repo)}. */
  app.post('/api/projects/:id/git/connect', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => connectProject(getProject(req.user!, (req.params as Params).id), req.user!.id, (req.body ?? {}) as Record<string, unknown>)),
  );

  app.post('/api/projects/:id/git/disconnect', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      disconnectProject(getProject(req.user!, (req.params as Params).id));
      return { ok: true };
    }),
  );

  app.post('/api/projects/:id/git/commit', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => gitCommit(getProject(req.user!, (req.params as Params).id), req.user!.id, String((req.body as { message?: unknown } | undefined)?.message ?? ''))),
  );

  app.post('/api/projects/:id/git/push', { preHandler: requireUser }, async (req, reply) => safe(reply, () => gitPush(getProject(req.user!, (req.params as Params).id), req.user!.id)));

  app.post('/api/projects/:id/git/pull', { preHandler: requireUser }, async (req, reply) => safe(reply, () => gitPull(getProject(req.user!, (req.params as Params).id), req.user!.id)));

  app.post('/api/projects/:id/git/pr', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const b = (req.body ?? {}) as { title?: unknown; body?: unknown; branch?: unknown };
      const title = String(b.title ?? '').trim() || 'Changes from HiveMind';
      return gitPullRequest(getProject(req.user!, (req.params as Params).id), req.user!.id, { title, body: String(b.body ?? title), branch: b.branch ? String(b.branch) : undefined });
    }),
  );

  // ---- Settings → GitHub (per user; the token is never sent back) ----
  app.get('/api/settings/github', { preHandler: requireUser }, async (req) => githubSettings(req.user!.id));
  app.put('/api/settings/github', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => saveGithubSettings(req.user!.id, (req.body ?? {}) as Record<string, unknown>)),
  );
  app.delete('/api/settings/github', { preHandler: requireUser }, async (req) => {
    removeGithub(req.user!.id);
    return { ok: true };
  });
  app.post('/api/settings/github/test', { preHandler: requireUser }, async (req, reply) => safe(reply, () => testGithub(req.user!.id)));
  app.get('/api/github/repos', { preHandler: requireUser }, async (req, reply) => safe(reply, () => listRepos(req.user!.id)));

  // ---- Preview: the project as a static site on a signed link, sandboxed (no access to HiveMind) ----
  app.get('/api/projects/preview/:token/*', async (req, reply) => {
    const { token } = req.params as { token: string };
    const projectId = checkPreviewToken(token);
    if (!projectId) return reply.code(404).send('This preview link is not valid any more: open the preview again from the project');
    let rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '').replace(/^\/+/, '');
    const root = { id: projectId };
    let full: string;
    try {
      if (!rel || rel.endsWith('/')) rel += 'index.html';
      full = projectPath(root, rel);
      if (statSync(full).isDirectory()) full = projectPath(root, `${rel.replace(/\/+$/, '')}/index.html`);
      if (!statSync(full).isFile()) throw new Error();
    } catch {
      return reply.code(404).header('content-type', 'text/plain; charset=utf-8').send(`Not found in the project: ${rel}`);
    }
    const ext = extname(full).toLowerCase();
    return reply
      .header('content-type', MIME[ext] ?? 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      // A sandbox without allow-same-origin: the page runs on its own, can't use the HiveMind login or read its pages.
      .header('content-security-policy', "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'")
      .send(createReadStream(full));
  });
}
