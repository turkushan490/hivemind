import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { db, getSetting, setSetting } from '../db/index.js';

/** The files folder (appdata/hivemind/files): things you drop in for canvases, and what blocks save. */
export const filesDir = resolve(config.dataDir, 'files');
mkdirSync(join(filesDir, 'outputs'), { recursive: true });

export interface FileEntry {
  path: string;
  size: number;
  modified: string;
  kind: FileKind;
  /** Admins only: who the file belongs to (undefined: nobody, admin-only). */
  owner?: string;
  ownerId?: string;
}

/** Who asks for a file: a full admin (not a limited token) sees every file, everyone else only their own. */
export interface FileUser {
  id: string;
  role: string;
  scope?: unknown;
}

export const seesAllFiles = (u: FileUser) => u.role === 'admin' && !u.scope;

/** The form paths are stored in ("a\\b", "/a/b" and "./a/b" are all "a/b"); throws for paths outside the folder. */
const relOf = (p: string) => relative(filesDir, safePath(p)).split(sep).join('/');

const ownerOf = (rel: string) => (db.prepare('SELECT owner_id FROM files WHERE path = ?').get(relOf(rel)) as { owner_id: string | null } | undefined)?.owner_id ?? undefined;

/** May this user open, use or delete this file? A path without an owner is admin-only. */
export function mayUseFile(u: FileUser, rel: string): boolean {
  if (seesAllFiles(u)) return true;
  const owner = ownerOf(rel);
  return !!owner && owner === u.id;
}

const notFound = () => Object.assign(new Error('File not found'), { statusCode: 404 });

/** The full path of a file this user may use; someone else's file is "not found", like a missing one. */
export function ownPath(u: FileUser, rel: string): string {
  const full = safePath(rel);
  if (!mayUseFile(u, rel)) throw notFound();
  return full;
}

/** Reads a file this user may use (blocks: Decide image input). */
export const readOwnFile = (u: FileUser, rel: string): Buffer => {
  const full = ownPath(u, rel);
  try {
    return readFileSync(full);
  } catch {
    throw notFound();
  }
};

/** Records who owns a file (every write: uploads, Save file, Image blocks, imports). */
export function setOwner(rel: string, ownerId: string | null) {
  db.prepare("INSERT INTO files (path, owner_id, created_at) VALUES (?, ?, datetime('now')) ON CONFLICT(path) DO UPDATE SET owner_id = excluded.owner_id, created_at = excluded.created_at").run(
    relOf(rel),
    ownerId,
  );
}

/**
 * Once, after the files table came: every file already in the folder goes to the first admin. Files put in the
 * folder by hand later have no owner, so only admins see them.
 */
export function claimExistingFiles() {
  if (getSetting('files.claimed')) return;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
  if (!admin) return;
  const insert = db.prepare("INSERT OR IGNORE INTO files (path, owner_id) VALUES (?, ?)");
  db.exec('BEGIN');
  try {
    for (const f of walkFiles(Infinity)) insert.run(f.path, admin.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  setSetting('files.claimed', '1');
}

export type FileKind = 'image' | 'text' | 'html' | 'pdf' | 'other';

const KINDS: Record<string, FileKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.svg': 'image',
  '.html': 'html', '.htm': 'html',
  '.pdf': 'pdf',
  '.txt': 'text', '.md': 'text', '.csv': 'text', '.json': 'text', '.log': 'text', '.xml': 'text', '.yaml': 'text', '.yml': 'text',
  '.js': 'text', '.ts': 'text', '.py': 'text', '.css': 'text', '.sh': 'text', '.sql': 'text', '.go': 'text', '.java': 'text', '.c': 'text', '.cpp': 'text', '.rs': 'text',
};
export const kindOf = (p: string): FileKind => KINDS[extname(p).toLowerCase()] ?? 'other';

/** A path inside the files folder, or an error: never outside it. */
export function safePath(rel: string): string {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((p) => p === '..' || p === '')) throw Object.assign(new Error('Not a valid file path'), { statusCode: 400 });
  const full = resolve(filesDir, clean);
  if (!full.startsWith(filesDir + sep)) throw Object.assign(new Error('Not a valid file path'), { statusCode: 400 });
  return full;
}

function walkFiles(max: number, keep: (rel: string) => boolean = () => true): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (out.length >= max) return;
      // Projects (files/projects/<id>/) have their own page and owners.
      if (dir === filesDir && name === 'projects') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const path = relative(filesDir, full).split(sep).join('/');
        if (keep(path)) out.push({ path, size: st.size, modified: st.mtime.toISOString(), kind: kindOf(name) });
      }
    }
  };
  walk(filesDir);
  return out;
}

/**
 * The files this user may see, newest first (capped, so a huge folder can't stall the page): their own, or for an
 * admin every file with its owner.
 */
export function listFiles(u: FileUser): FileEntry[] {
  const rows = (db.prepare('SELECT f.path, f.owner_id, u.username FROM files f LEFT JOIN users u ON u.id = f.owner_id').all() as { path: string; owner_id: string | null; username: string | null }[]);
  const owners = new Map(rows.map((r) => [r.path, r]));
  const all = seesAllFiles(u);
  // Projects have their own page (and can hold thousands of files).
  const out = walkFiles(3000, (p) => !p.startsWith('projects/') && (all || owners.get(p)?.owner_id === u.id));
  if (all)
    for (const f of out) {
      const o = owners.get(f.path);
      if (o?.owner_id) Object.assign(f, { ownerId: o.owner_id, owner: o.username ?? o.owner_id });
    }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Writes a file without overwriting: "x.md" becomes "x (2).md" when taken. Returns the path used; ownerId owns it. */
export function writeUnique(rel: string, data: Buffer | string, ownerId: string | null): string {
  let full = safePath(rel);
  // Projects are written only through their own routes and blocks (owner checks, limits).
  if (relative(filesDir, full).split(sep)[0] === 'projects') throw Object.assign(new Error('Write project files on the Projects page'), { statusCode: 400 });
  const ext = extname(full);
  const base = full.slice(0, full.length - ext.length);
  for (let i = 2; existsAt(full); i++) full = `${base} (${i})${ext}`;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  const saved = relative(filesDir, full).split(sep).join('/');
  setOwner(saved, ownerId);
  return saved;
}

const existsAt = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Deletes a file this user may use (someone else's is "not found"). */
export function deleteFile(u: FileUser, rel: string) {
  rmSync(ownPath(u, rel), { force: true });
  db.prepare('DELETE FROM files WHERE path = ?').run(relOf(rel));
}

/** A file name from free text: no slashes or odd characters, at most 80 chars. */
export function cleanName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  // "." and ".." are never names of their own (safePath refuses them too, this is the second line of defence).
  return /^\.+$/.test(clean) || !clean ? 'file' : clean;
}
