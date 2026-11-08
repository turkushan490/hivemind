import type { FileChange, Project, ProjectChange, ProjectFile } from '@hivemind/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { lineDiff } from './diff.js';
import { filesDir, type FileUser, seesAllFiles } from './files.js';
import { checkOutside } from './outsideFolders.js';

/** Projects live in the files folder (files/projects/<id>/), but never show in the Files tab. */
export const projectsDir = join(filesDir, 'projects');
mkdirSync(projectsDir, { recursive: true });

export const PROJECT_LIMITS = {
  /** Everything in one project (not counting .git). */
  totalBytes: 200 * 1024 * 1024,
  /** One file written by a block. */
  blockFileBytes: 2 * 1024 * 1024,
  /** One file uploaded or saved in the editor. */
  uploadFileBytes: 50 * 1024 * 1024,
  files: 5000,
};

/** File types a block may never write (they could be run on someone's computer). */
const BLOCKED_EXT = new Set(['.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.sh', '.bash', '.msi', '.scr', '.jar', '.app', '.so', '.dylib']);

const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.json', '.md', '.markdown', '.txt',
  '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.csv', '.py', '.rb', '.php', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sql', '.env', '.gitignore',
  '.webmanifest', '.map', '.lock', '.astro', '.njk', '.hbs', '.ejs', '.liquid', '.graphql',
]);
export const isTextPath = (p: string) => TEXT_EXT.has(extname(p).toLowerCase()) || !extname(p);

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  folder: string;
  github_repo: string | null;
  github_branch: string | null;
  /** A folder of another app, opened in place (Settings → Projects → Folders of other apps). */
  external?: string | null;
  created_at: string;
  updated_at: string;
  username?: string | null;
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export const projectNotFound = () => err(404, 'Project not found');

/** Outside folders by project id (a row read once; null = an ordinary project). */
const outside = new Map<string, string | null>();
const externalOf = (id: string): string | null => {
  if (!outside.has(id)) outside.set(id, (db.prepare('SELECT external FROM projects WHERE id = ?').get(id) as { external: string | null } | undefined)?.external ?? null);
  return outside.get(id)!;
};
export const isOutside = (p: { id: string }) => !!externalOf(p.id);

/** The project folder on disk: files/projects/<id>, or the other app's folder (only while outside folders are on). */
export const rootOf = (p: { id: string }) => {
  const ext = externalOf(p.id);
  return ext ? checkOutside(ext) : join(projectsDir, p.id);
};

/** Folders of other apps hold dependencies HiveMind should not walk through or count. */
const OUTSIDE_SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache']);
const skipName = (p: { id: string }, name: string) => isOutside(p) && OUTSIDE_SKIP.has(name);
/** Other apps' projects can be bigger than HiveMind's own. */
const limitsOf = (p: { id: string }) => (isOutside(p) ? { ...PROJECT_LIMITS, files: 20000, totalBytes: 2 * 1024 ** 3 } : PROJECT_LIMITS);

/** Files written into another app's folder belong to that folder's owner, so the app can still change them. */
function sameOwner(p: { id: string }, full: string) {
  if (!isOutside(p)) return;
  try {
    const st = statSync(rootOf(p));
    chownSync(full, st.uid, st.gid);
  } catch {}
}

/** Opens a folder of another app as a project (it stays where it is). */
export function createOutsideProject(user: FileUser, path: unknown, name?: unknown): Project {
  const real = checkOutside(String(path ?? ''));
  const taken = db.prepare('SELECT id FROM projects WHERE external = ?').get(real) as { id: string } | undefined;
  if (taken) throw err(409, 'That folder is already a project');
  const id = newId().replace(/[^a-zA-Z0-9]/g, 'x');
  db.prepare('INSERT INTO projects (id, owner_id, name, folder, external) VALUES (?, ?, ?, ?, ?)').run(id, user.id, cleanProjectName(name || basename(real)), real, real);
  outside.delete(id);
  return toProject(getProject(user, id));
}

/** A project its owner or a full admin may use; everyone else gets "not found". */
export function getProject(user: FileUser, id: string): ProjectRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row || (row.owner_id !== user.id && !seesAllFiles(user))) throw projectNotFound();
  return row;
}

/** Finds a project by id or name among those this user may use (blocks name projects either way). */
export function findProject(user: FileUser, idOrName: string): ProjectRow {
  const key = idOrName.trim();
  if (!key) throw err(400, 'No project given: pick one on the block, or send vars.project');
  const byId = db.prepare('SELECT * FROM projects WHERE id = ?').get(key) as ProjectRow | undefined;
  if (byId && (byId.owner_id === user.id || seesAllFiles(user))) return byId;
  const byName = db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE ORDER BY owner_id = ? DESC').get(key, user.id) as ProjectRow | undefined;
  if (byName && (byName.owner_id === user.id || seesAllFiles(user))) return byName;
  throw err(404, `Project "${key}" not found`);
}

export function toProject(row: ProjectRow): Project {
  // An outside folder that is switched off or no longer mounted still shows in the list (it just can't be opened).
  let files = 0;
  let bytes = 0;
  try {
    ({ files, bytes } = usage(row));
  } catch {}
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ...(row.username && { owner: row.username }),
    ...(row.github_repo && { githubRepo: row.github_repo, githubBranch: row.github_branch ?? 'main' }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files,
    sizeBytes: bytes,
    ...(row.external && { outside: row.external }),
  };
}

export function listProjects(user: FileUser): Project[] {
  const rows = seesAllFiles(user)
    ? (db.prepare('SELECT p.*, u.username FROM projects p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.updated_at DESC').all() as unknown as ProjectRow[])
    : (db.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC').all(user.id) as unknown as ProjectRow[]);
  // An admin sees whose each project is (not for their own).
  return rows.map((r) => toProject(r.owner_id === user.id ? { ...r, username: null } : r));
}

const cleanProjectName = (name: unknown) => {
  const n = String(name ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80);
  if (!n) throw err(400, 'Give the project a name');
  return n;
};

export function createProject(user: FileUser, name: unknown): Project {
  const id = newId().replace(/[^a-zA-Z0-9]/g, 'x');
  db.prepare('INSERT INTO projects (id, owner_id, name, folder) VALUES (?, ?, ?, ?)').run(id, user.id, cleanProjectName(name), `projects/${id}`);
  mkdirSync(rootOf({ id }), { recursive: true });
  return toProject(getProject(user, id));
}

export function renameProject(user: FileUser, id: string, name: unknown): Project {
  getProject(user, id);
  db.prepare("UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?").run(cleanProjectName(name), id);
  return toProject(getProject(user, id));
}

export function deleteProject(user: FileUser, id: string) {
  const row = getProject(user, id);
  // Another app's folder stays: only HiveMind forgets it.
  if (!row.external) rmSync(rootOf(row), { recursive: true, force: true });
  outside.delete(id);
  rmSync(join(config.dataDir, 'builds', row.id), { recursive: true, force: true });
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export const touchProject = (id: string) => db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);

/**
 * A path inside the project, in its stored form ("a/b.html"). Refuses "..", absolute paths, empty parts, the
 * .git folder, and anything that leads outside the project through a link.
 */
export function cleanRel(rel: unknown): string {
  const clean = String(rel ?? '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.includes('\u0000')) throw err(400, `Not a valid path in the project: ${String(rel ?? '').slice(0, 120)}`);
  const parts = clean.replace(/\/+$/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw err(400, `Not a valid path in the project: ${clean.slice(0, 120)}`);
  if (clean.length > 400) throw err(400, 'That path is too long');
  return parts.join('/');
}

/** The full path of rel inside this project (checked, also against links that lead out). */
export function projectPath(project: { id: string }, rel: unknown): string {
  const root = rootOf(project);
  const clean = cleanRel(rel);
  const full = resolve(root, clean);
  if (!full.startsWith(root + sep)) throw err(400, 'Not a valid path in the project');
  // Every part that exists must be a real file or folder inside the project, never a link.
  let at = root;
  for (const part of clean.split('/')) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      break;
    }
    if (st.isSymbolicLink()) throw err(400, `Links are not allowed in projects: ${relative(root, at).split(sep).join('/')}`);
  }
  if (existsSync(full)) {
    const real = realpathSync(full);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw err(400, 'Not a valid path in the project');
  }
  return full;
}

/** Every file of the project (not .git, not links), sorted by path. */
export function projectTree(project: { id: string }, max = PROJECT_LIMITS.files): ProjectFile[] {
  const root = rootOf(project);
  const out: ProjectFile[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= max) return;
      if (dir === root && name === '.git') continue;
      if (skipName(project, name)) continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else {
        const path = relative(root, full).split(sep).join('/');
        out.push({ path, size: st.size, modified: st.mtime.toISOString(), text: isTextPath(path) });
      }
    }
  };
  walk(root);
  return out;
}

/** Folders of the project (for the tree: empty folders show too). */
export function projectFolders(project: { id: string }): string[] {
  const root = rootOf(project);
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (dir === root && name === '.git') continue;
      if (skipName(project, name)) continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        out.push(relative(root, full).split(sep).join('/'));
        if (out.length < 2000) walk(full);
      }
    }
  };
  walk(root);
  return out;
}

function usage(project: { id: string }): { files: number; bytes: number } {
  const tree = projectTree(project, limitsOf(project).files + 1);
  return { files: tree.length, bytes: tree.reduce((n, f) => n + f.size, 0) };
}

/** A text file of the project, or undefined when it doesn't exist. */
export function readProjectText(project: { id: string }, rel: string): string | undefined {
  const full = projectPath(project, rel);
  try {
    if (!statSync(full).isFile()) return;
    return readFileSync(full, 'utf8');
  } catch {
    return;
  }
}

export function readProjectFile(project: { id: string }, rel: string): Buffer {
  const full = projectPath(project, rel);
  try {
    if (!statSync(full).isFile()) throw new Error();
    return readFileSync(full);
  } catch {
    throw err(404, 'File not found');
  }
}

/**
 * Writes one file (folders are made). Checks the type (blocks), the size and the project's limits. Returns what
 * changed, with a diff for text files.
 */
export function writeProjectFile(
  project: { id: string },
  rel: string,
  data: string | Buffer,
  opts: { byBlock?: boolean; mode?: 'overwrite' | 'new' } = {},
): FileChange {
  const clean = cleanRel(rel);
  const full = projectPath(project, clean);
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  if (opts.byBlock && BLOCKED_EXT.has(extname(clean).toLowerCase())) throw err(400, `Blocks may not write ${extname(clean)} files: ${clean}`);
  const lim = limitsOf(project);
  const maxFile = opts.byBlock ? lim.blockFileBytes : lim.uploadFileBytes;
  if (size > maxFile) throw err(413, `${clean} is too big (${Math.round(size / 1024)} KB; at most ${Math.round(maxFile / 1024 / 1024)} MB)`);
  let before: Buffer | undefined;
  try {
    const st = statSync(full);
    if (st.isDirectory()) throw err(400, `${clean} is a folder`);
    before = readFileSync(full);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode) throw e;
  }
  if (before && opts.mode === 'new') return { path: clean, status: 'skipped', added: 0, removed: 0 };
  const { files, bytes } = usage(project);
  if (!before && files >= lim.files) throw err(413, `The project is full: at most ${lim.files} files`);
  if (bytes - (before?.length ?? 0) + size > lim.totalBytes) throw err(413, `The project is full: at most ${lim.totalBytes / 1024 / 1024} MB`);
  const madeFrom = firstMissing(dirname(full));
  mkdirSync(dirname(full), { recursive: true });
  if (madeFrom) for (let d = dirname(full); d.length >= madeFrom.length; d = dirname(d)) sameOwner(project, d);
  // The parent may have been made just now: check again that nothing leads out of the project.
  projectPath(project, clean);
  writeFileSync(full, data);
  if (!before) sameOwner(project, full);
  touchProject(project.id);
  const text = isTextPath(clean);
  if (before && Buffer.compare(before, typeof data === 'string' ? Buffer.from(data) : data) === 0) return { path: clean, status: 'skipped', added: 0, removed: 0 };
  const d = text ? lineDiff(before?.toString('utf8'), typeof data === 'string' ? data : data.toString('utf8')) : { added: 0, removed: 0 };
  return { path: clean, status: before ? 'changed' : 'added', ...d };
}

/** Deletes a file or a folder (with everything in it). */
export function deleteProjectPath(project: { id: string }, rel: string): FileChange[] {
  const clean = cleanRel(rel);
  const full = projectPath(project, clean);
  let st;
  try {
    st = statSync(full);
  } catch {
    throw err(404, 'File not found');
  }
  const changes: FileChange[] = [];
  if (st.isDirectory()) {
    for (const f of projectTree(project).filter((f) => f.path.startsWith(`${clean}/`))) changes.push({ path: f.path, status: 'deleted', added: 0, removed: 0 });
    rmSync(full, { recursive: true, force: true });
  } else {
    const before = isTextPath(clean) ? readFileSync(full, 'utf8') : undefined;
    rmSync(full, { force: true });
    changes.push({ path: clean, status: 'deleted', ...(before !== undefined ? lineDiff(before, undefined) : { added: 0, removed: 0 }) });
  }
  touchProject(project.id);
  return changes;
}

/** The highest folder of `dir` that doesn't exist yet (undefined when it all exists). */
function firstMissing(dir: string): string | undefined {
  let missing: string | undefined;
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing = d;
    if (dirname(d) === d) break;
  }
  return missing;
}

export function makeFolder(project: { id: string }, rel: string) {
  const full = projectPath(project, rel);
  const madeFrom = firstMissing(full);
  mkdirSync(full, { recursive: true });
  if (madeFrom) for (let d = full; d.length >= madeFrom.length; d = dirname(d)) sameOwner(project, d);
  projectPath(project, rel);
  touchProject(project.id);
}

export function moveProjectPath(project: { id: string }, from: string, to: string) {
  const src = projectPath(project, from);
  const dest = projectPath(project, to);
  if (!existsSync(src)) throw err(404, 'File not found');
  if (existsSync(dest)) throw err(409, `${cleanRel(to)} already exists`);
  if (dest.startsWith(src + sep)) throw err(400, 'A folder cannot move into itself');
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
  touchProject(project.id);
}

/** Stores what a run (or an edit) changed, for the project's history. */
export function recordChanges(projectId: string, changes: FileChange[], source: string, runId?: string) {
  const real = changes.filter((c) => c.status !== 'skipped');
  if (!real.length) return;
  db.prepare('INSERT INTO project_changes (project_id, run_id, source, changes) VALUES (?, ?, ?, ?)').run(projectId, runId ?? null, source, JSON.stringify(real));
  // Keep the last 500 entries per project.
  db.prepare('DELETE FROM project_changes WHERE project_id = ? AND id NOT IN (SELECT id FROM project_changes WHERE project_id = ? ORDER BY id DESC LIMIT 500)').run(projectId, projectId);
}

export function projectHistory(projectId: string, limit = 100): ProjectChange[] {
  return (db.prepare('SELECT id, at, run_id, source, changes FROM project_changes WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as {
    id: number;
    at: string;
    run_id: string | null;
    source: string;
    changes: string;
  }[]).map((r) => ({ id: r.id, at: r.at, ...(r.run_id && { runId: r.run_id }), source: r.source, changes: JSON.parse(r.changes) as FileChange[] }));
}

// ---- Preview: the project as a static site, on a signed link (no cookie: the page runs sandboxed) ----

const PREVIEW_HOURS = 12;

const sign = (s: string) => createHmac('sha256', config.secretKey).update(`preview:${s}`).digest('base64url').slice(0, 32);

/** A link to the project's preview that works for PREVIEW_HOURS (the page itself can't use the HiveMind login). */
export function previewToken(projectId: string): string {
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_HOURS * 3600;
  return `${projectId}.${exp}.${sign(`${projectId}.${exp}`)}`;
}

export const previewUrl = (projectId: string, path = '') => `/api/projects/preview/${previewToken(projectId)}/${path}`;

/** The project id of a valid preview token, else undefined. */
export function checkPreviewToken(token: string): string | undefined {
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now() / 1000) return;
  const want = Buffer.from(sign(`${id}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return;
  return id;
}
