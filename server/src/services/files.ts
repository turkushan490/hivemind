import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';

/** The files folder (appdata/hivemind/files): things you drop in for canvases, and what blocks save. */
export const filesDir = resolve(config.dataDir, 'files');
mkdirSync(join(filesDir, 'outputs'), { recursive: true });

export interface FileEntry {
  path: string;
  size: number;
  modified: string;
  kind: FileKind;
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

/** Everything in the folder, newest first (capped, so a huge folder can't stall the page). */
export function listFiles(): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (out.length >= 3000) return;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push({ path: relative(filesDir, full).split(sep).join('/'), size: st.size, modified: st.mtime.toISOString(), kind: kindOf(name) });
    }
  };
  walk(filesDir);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Writes a file without overwriting: "x.md" becomes "x (2).md" when taken. Returns the path used. */
export function writeUnique(rel: string, data: Buffer | string): string {
  let full = safePath(rel);
  const ext = extname(full);
  const base = full.slice(0, full.length - ext.length);
  for (let i = 2; existsAt(full); i++) full = `${base} (${i})${ext}`;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  return relative(filesDir, full).split(sep).join('/');
}

const existsAt = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

export function deleteFile(rel: string) {
  rmSync(safePath(rel), { force: true });
}

/** A file name from free text: no slashes or odd characters, at most 80 chars. */
export function cleanName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
}
