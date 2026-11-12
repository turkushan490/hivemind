// H11 — Memory as Markdown files: the robot's (and owner's) memory is a tree of .md files under <dataDir>/memory/<user>.
// Characters read them before answering and write them after; the owner can view/edit on the Memory page. Every write
// keeps up to 20 versions and records who changed it; delete moves to archive/deleted (never really gone).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { config } from '../config.js';

const KEEP_VERSIONS = 20;
/** Folders kept out of the tree and searches (version snapshots and the "changed by" sidecars). */
const HIDDEN = new Set(['.versions', '.meta']);

export interface MemFile {
  /** Posix path relative to the memory root, e.g. "topics/food/potatoes.md". */
  path: string;
  size: number;
  /** ISO time of the last change. */
  at?: string;
  /** Who last changed it: "owner", a character name, or a job. */
  by?: string;
  /** The first non-empty, non-heading line, for the tree preview. */
  title?: string;
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The memory root for a user, or the guest sub-tree. Created on first use. */
function root(userId: string, guest = false): string {
  const base = join(config.dataDir, 'memory', userId, guest ? 'guest' : '');
  mkdirSync(base, { recursive: true });
  return base;
}

/** A safe absolute path for a relative memory path (no escaping the root, .md only for files). */
function at(userId: string, rel: string, guest = false): { full: string; rel: string; base: string } {
  const base = root(userId, guest);
  const clean = posix.normalize(rel.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!clean || clean === '.' || clean.startsWith('..') || clean.includes('/../') || clean.endsWith('/..')) throw err(400, 'Bad memory path');
  if (/[^a-zA-Z0-9/_.-]/.test(clean)) throw err(400, 'A memory path has only letters, digits, / _ . and -');
  const full = join(base, clean);
  if (full !== base && !full.startsWith(base + sep)) throw err(400, 'That path is outside the memory folder');
  return { full, rel: clean, base };
}

const metaPath = (base: string, rel: string) => join(base, '.meta', `${rel}.json`);
const versionDir = (base: string, rel: string) => join(base, '.versions', rel);

function readMeta(base: string, rel: string): { by?: string; at?: string } {
  try {
    return JSON.parse(readFileSync(metaPath(base, rel), 'utf8')) as { by?: string; at?: string };
  } catch {
    return {};
  }
}

/** The first line worth showing in the tree (a heading's text, else the first non-empty line). */
function titleOf(full: string): string | undefined {
  try {
    for (const line of readFileSync(full, 'utf8').split('\n').slice(0, 20)) {
      const t = line.replace(/^#+\s*/, '').trim();
      if (t) return t.slice(0, 120);
    }
  } catch {}
  return undefined;
}

/** Every .md file in the tree (not the hidden folders), with its size, last change and preview. */
export function tree(userId: string, guest = false): MemFile[] {
  const base = root(userId, guest);
  const out: MemFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (HIDDEN.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.md')) {
        const rel = relative(base, full).split(sep).join('/');
        const meta = readMeta(base, rel);
        out.push({ path: rel, size: st.size, at: meta.at ?? st.mtime.toISOString(), by: meta.by, title: titleOf(full) });
      }
    }
  };
  walk(base);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one or several files; missing ones come back with content undefined. */
export function read(userId: string, paths: string[], guest = false): { path: string; content?: string }[] {
  return paths.map((p) => {
    const { full, rel } = at(userId, p, guest);
    try {
      return { path: rel, content: readFileSync(full, 'utf8') };
    } catch {
      return { path: rel, content: undefined };
    }
  });
}

/** Snapshots the current content as a version (keeping the newest 20), before it is overwritten. */
function snapshot(base: string, rel: string) {
  const full = join(base, rel);
  if (!existsSync(full)) return;
  const vdir = versionDir(base, rel);
  mkdirSync(vdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const meta = readMeta(base, rel);
  writeFileSync(join(vdir, `${stamp}__${meta.by ?? 'unknown'}.md`), readFileSync(full));
  const versions = readdirSync(vdir).filter((f) => f.endsWith('.md')).sort();
  for (const old of versions.slice(0, Math.max(0, versions.length - KEEP_VERSIONS))) {
    try {
      rmSync(join(vdir, old), { force: true });
    } catch {}
  }
}

/** Write (replace) or append to a file, keeping a version and recording who changed it. */
export function write(userId: string, path: string, text: string, opts: { mode?: 'replace' | 'append'; by?: string; guest?: boolean } = {}): MemFile {
  const { full, rel, base } = at(userId, path, opts.guest);
  if (!rel.endsWith('.md')) throw err(400, 'Memory files end in .md');
  mkdirSync(dirname(full), { recursive: true });
  snapshot(base, rel);
  if (opts.mode === 'append' && existsSync(full)) {
    const prev = readFileSync(full, 'utf8');
    writeFileSync(full, `${prev}${prev.endsWith('\n') ? '' : '\n'}${text}`);
  } else {
    writeFileSync(full, text);
  }
  const meta = { by: opts.by || 'owner', at: new Date().toISOString() };
  mkdirSync(dirname(metaPath(base, rel)), { recursive: true });
  writeFileSync(metaPath(base, rel), JSON.stringify(meta));
  const st = statSync(full);
  return { path: rel, size: st.size, at: meta.at, by: meta.by, title: titleOf(full) };
}

/** Move/rename a file (and its versions + meta), recording who did it. */
export function move(userId: string, from: string, to: string, by?: string, guest = false): void {
  const a = at(userId, from, guest);
  const b = at(userId, to, guest);
  if (!existsSync(a.full)) throw err(404, `No memory file "${a.rel}"`);
  if (!b.rel.endsWith('.md')) throw err(400, 'Memory files end in .md');
  mkdirSync(dirname(b.full), { recursive: true });
  renameSync(a.full, b.full);
  for (const side of [metaPath, (base: string, rel: string) => versionDir(base, rel)]) {
    try {
      const src = side(a.base, a.rel);
      if (existsSync(src)) {
        mkdirSync(dirname(side(b.base, b.rel)), { recursive: true });
        renameSync(src, side(b.base, b.rel));
      }
    } catch {}
  }
  write(userId, to, readFileSync(b.full, 'utf8'), { by: by || 'owner', guest }); // record the move as a change (keeps a version)
}

/** Delete a file by moving it under archive/deleted (never really gone). */
export function remove(userId: string, path: string, guest = false): void {
  const { full, rel, base } = at(userId, path, guest);
  if (!existsSync(full)) return;
  const dest = join(base, 'archive', 'deleted', `${new Date().toISOString().replace(/[:.]/g, '-')}__${rel.split('/').join('__')}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(full, dest);
  try {
    rmSync(metaPath(base, rel), { force: true });
  } catch {}
}

/** Search file names and contents; returns each match with a short snippet. */
export function search(userId: string, query: string, guest = false, limit = 20): { path: string; title?: string; snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const base = root(userId, guest);
  const out: { path: string; title?: string; snippet: string }[] = [];
  for (const f of tree(userId, guest)) {
    if (out.length >= limit) break;
    let content = '';
    try {
      content = readFileSync(join(base, f.path), 'utf8');
    } catch {}
    const lower = content.toLowerCase();
    const inName = f.path.toLowerCase().includes(q);
    const i = lower.indexOf(q);
    if (!inName && i < 0) continue;
    const snippet = i >= 0 ? content.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, ' ').trim() : f.title ?? '';
    out.push({ path: f.path, title: f.title, snippet });
  }
  return out;
}

/** The saved versions of a file, newest first (name = timestamp + who). */
export function versions(userId: string, path: string, guest = false): { id: string; at: string; by?: string }[] {
  const { rel, base } = at(userId, path, guest);
  const vdir = versionDir(base, rel);
  if (!existsSync(vdir)) return [];
  return readdirSync(vdir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => {
      const [stamp, who] = f.replace(/\.md$/, '').split('__');
      return { id: f, at: stamp, by: who };
    });
}

/** Restore a version back into the file (the current content is snapshotted first). */
export function restore(userId: string, path: string, versionId: string, by?: string, guest = false): MemFile {
  const { rel, base } = at(userId, path, guest);
  if (/[\\/]/.test(versionId)) throw err(400, 'Bad version id');
  const vfile = join(versionDir(base, rel), versionId);
  if (!existsSync(vfile)) throw err(404, 'No such version');
  return write(userId, rel, readFileSync(vfile, 'utf8'), { by: by || 'owner', guest });
}
