import type { Skill } from '@hivemind/shared';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { githubToken, REPO_RE } from './git.js';
import { createZip, readZip } from './zip.js';

/**
 * Skills: a folder with a SKILL.md (frontmatter name + description, then instructions) and optional extra text
 * files, the same format as Claude skills. Blocks put a skill's instructions in their system prompt. Files are
 * only ever read as text: nothing in a skill is run.
 */

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const skillsDir = join(config.dataDir, 'skills');
mkdirSync(skillsDir, { recursive: true });

export const SKILL_LIMITS = { fileBytes: 1024 * 1024, totalBytes: 10 * 1024 * 1024, files: 200, promptChars: 30_000 };

/** Text files a skill may hold (anything else is left out on import). */
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.sql', '.xml', '.svg', '.ini', '.cfg']);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export interface SkillMd {
  name: string;
  description: string;
  body: string;
}

/** Reads SKILL.md: a "---" frontmatter with name and description (single line, or "|" / ">" with indented lines). */
export function parseSkillMd(text: string): SkillMd {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw err(400, 'SKILL.md must start with a --- block with name and description');
  const fields: Record<string, string> = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    }
    fields[kv[1].toLowerCase()] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  const name = (fields.name ?? '').trim();
  if (!NAME_RE.test(name)) throw err(400, 'SKILL.md needs a name (letters, numbers, spaces, . - _; at most 64)');
  const description = (fields.description ?? '').trim().slice(0, 1024);
  if (!description) throw err(400, 'SKILL.md needs a description: when to use the skill');
  return { name, description, body: m[2].trim() };
}

interface SkillRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  shared: number;
  folder: string;
  updated_at: string;
  username?: string | null;
}

interface SkillUser {
  id: string;
  role: string;
  scope?: unknown;
}

const isFullAdmin = (u: SkillUser) => u.role === 'admin' && !u.scope;
const dirOf = (row: { id: string }) => join(skillsDir, row.id);

function skillFiles(row: { id: string }): { path: string; size: number }[] {
  const root = dirOf(row);
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push({ path: relative(root, full).split(sep).join('/'), size: st.size });
    }
  };
  walk(root);
  return out;
}

function toSkill(row: SkillRow, user: SkillUser): Skill {
  const files = skillFiles(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    shared: !!row.shared,
    mine: row.owner_id === user.id,
    ...(row.username && row.owner_id !== user.id && { owner: row.username }),
    files,
    sizeBytes: files.reduce((n, f) => n + f.size, 0),
    updatedAt: row.updated_at,
  };
}

/** Your own skills and the shared ones (a full admin: all of them). */
export function listSkills(user: SkillUser): Skill[] {
  const rows = db
    .prepare(`SELECT s.*, u.username FROM skills s LEFT JOIN users u ON u.id = s.owner_id ${isFullAdmin(user) ? '' : 'WHERE s.owner_id = ? OR s.shared = 1'} ORDER BY s.name COLLATE NOCASE`)
    .all(...(isFullAdmin(user) ? [] : [user.id])) as unknown as SkillRow[];
  return rows.map((r) => toSkill(r, user));
}

/** A skill this user may use (own or shared); edit=true: only its owner (or a full admin). */
function getSkill(user: SkillUser, id: string, edit = false): SkillRow {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
  const may = row && (row.owner_id === user.id || isFullAdmin(user) || (!edit && row.shared));
  if (!row || !may) throw err(404, 'Skill not found');
  return row;
}

export const skillView = (user: SkillUser, id: string) => toSkill(getSkill(user, id), user);

/** Path checks inside a skill folder. */
function cleanSkillPath(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!clean || clean.split('/').some((x) => !x || x === '.' || x === '..') || clean.length > 300) throw err(400, `Not a valid file path: ${p.slice(0, 80)}`);
  return clean;
}

const isText = (p: string) => TEXT_EXT.has(extname(p).toLowerCase()) || p.toUpperCase() === 'SKILL.MD';

/**
 * Stores a skill from its files (SKILL.md + extras). Non-text files are left out (listed in skipped). An existing
 * skill of yours with the same name is replaced.
 */
export function saveSkill(user: SkillUser, files: { path: string; data: Buffer }[], opts: { replaceId?: string } = {}): { skill: Skill; skipped: string[] } {
  const md = files.find((f) => f.path.toUpperCase() === 'SKILL.MD');
  if (!md) throw err(400, 'No SKILL.md found (it must be at the top of the skill folder)');
  const meta = parseSkillMd(md.data.toString('utf8'));
  const keep: { path: string; data: Buffer }[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files) {
    const path = cleanSkillPath(f.path);
    if (!isText(path) || f.data.length > SKILL_LIMITS.fileBytes || f.data.includes(0)) {
      skipped.push(path);
      continue;
    }
    total += f.data.length;
    if (total > SKILL_LIMITS.totalBytes) throw err(413, `The skill is too big (at most ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB of text)`);
    keep.push({ path: path.toUpperCase() === 'SKILL.MD' ? 'SKILL.md' : path, data: f.data });
  }
  if (keep.length > SKILL_LIMITS.files) throw err(413, `A skill may have at most ${SKILL_LIMITS.files} files`);
  const existing = opts.replaceId
    ? getSkill(user, opts.replaceId, true)
    : (db.prepare('SELECT * FROM skills WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(user.id, meta.name) as SkillRow | undefined);
  const clash = db.prepare('SELECT id FROM skills WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(existing?.owner_id ?? user.id, meta.name) as { id: string } | undefined;
  if (clash && clash.id !== existing?.id) throw err(409, `You already have a skill named "${meta.name}"`);
  const id = existing?.id ?? newId().replace(/[^a-zA-Z0-9]/g, 'x');
  const root = dirOf({ id });
  rmSync(root, { recursive: true, force: true });
  for (const f of keep) {
    const full = resolve(root, f.path);
    if (!full.startsWith(root + sep)) throw err(400, 'Not a valid file path');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.data);
  }
  if (existing) db.prepare("UPDATE skills SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?").run(meta.name, meta.description, id);
  else db.prepare('INSERT INTO skills (id, owner_id, name, description, folder) VALUES (?, ?, ?, ?, ?)').run(id, user.id, meta.name, meta.description, `skills/${id}`);
  return { skill: toSkill(getSkill(user, id), user), skipped };
}

/** A .zip with SKILL.md at the top, or in one folder (as Claude exports them). */
export function importSkillZip(user: SkillUser, buf: Buffer): { skill: Skill; skipped: string[] } {
  const entries = readZip(buf, { file: SKILL_LIMITS.fileBytes * 4, total: SKILL_LIMITS.totalBytes * 2 }) as { name: string; data: Buffer }[];
  return saveSkill(user, rootedAtSkill(entries.map((e) => ({ path: e.name.replace(/\\/g, '/'), data: e.data }))));
}

/** Files below the folder that holds SKILL.md (the shallowest one), with that folder taken off their paths. */
function rootedAtSkill(files: { path: string; data: Buffer }[], under = ''): { path: string; data: Buffer }[] {
  const prefix = under ? `${under.replace(/\/+$/, '')}/` : '';
  const mds = files
    .filter((f) => f.path.startsWith(prefix) && /(^|\/)SKILL\.md$/i.test(f.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (!mds.length) throw err(400, `No SKILL.md found${under ? ` in ${under}` : ''}`);
  const base = mds[0].path.slice(0, mds[0].path.length - 'SKILL.md'.length);
  return files.filter((f) => f.path.startsWith(base) && !f.path.endsWith('/')).map((f) => ({ path: f.path.slice(base.length), data: f.data }));
}

/** Imports a skill from a GitHub repo ("owner/name", optional folder and branch), with the user's token when set. */
export async function importSkillGithub(user: SkillUser, body: { repo?: unknown; path?: unknown; ref?: unknown }) {
  const repo = String(body.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!REPO_RE.test(repo)) throw err(400, 'Give the repo as owner/name');
  const path = String(body.path ?? '').trim().replace(/^\/+|\/+$/g, '');
  const ref = String(body.ref ?? '').trim();
  if (ref && !/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) throw err(400, 'Not a valid branch or tag');
  const token = githubToken(user.id);
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'HiveMind', ...(token && { authorization: `Bearer ${token}` }) };
  // The repo as a zip (GitHub sends it from codeload), then only the skill's folder is kept.
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const res = await fetch(`${api}/repos/${repo}/zipball${ref ? `/${encodeURIComponent(ref)}` : ''}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw err(res.status === 404 ? 404 : 502, `GitHub ${res.status}: could not download ${repo}${res.status === 404 ? ' (private? add a token in Settings → GitHub)' : ''}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 100 * 1024 * 1024) throw err(413, 'That repo is too big to import a skill from');
  const entries = (readZip(buf, { file: 50 * 1024 * 1024, total: 300 * 1024 * 1024 }) as { name: string; data: Buffer }[]).map((e) => ({
    // GitHub puts everything in one "owner-repo-sha/" folder.
    path: e.name.replace(/\\/g, '/').split('/').slice(1).join('/'),
    data: e.data,
  }));
  return saveSkill(user, rootedAtSkill(entries.filter((e) => e.path), path));
}

/** Writes (or replaces) one file of your skill; SKILL.md is checked first. */
export function writeSkillFile(user: SkillUser, id: string, path: string, content: string): Skill {
  const row = getSkill(user, id, true);
  const clean = cleanSkillPath(path);
  if (!isText(clean)) throw err(400, 'Skills hold text files only');
  if (Buffer.byteLength(content) > SKILL_LIMITS.fileBytes) throw err(413, 'That file is too big (at most 1 MB)');
  const files = skillFiles(row)
    .filter((f) => f.path !== clean)
    .map((f) => ({ path: f.path, data: readFileSync(join(dirOf(row), f.path)) }));
  files.push({ path: clean, data: Buffer.from(content) });
  return saveSkill(user, files, { replaceId: row.id }).skill;
}

export function deleteSkillFile(user: SkillUser, id: string, path: string): Skill {
  const row = getSkill(user, id, true);
  const clean = cleanSkillPath(path);
  if (clean.toUpperCase() === 'SKILL.MD') throw err(400, 'SKILL.md is the skill itself: delete the skill instead');
  rmSync(join(dirOf(row), clean), { force: true });
  db.prepare("UPDATE skills SET updated_at = datetime('now') WHERE id = ?").run(row.id);
  return toSkill(getSkill(user, id), user);
}

export function readSkillFile(user: SkillUser, id: string, path: string): string {
  const row = getSkill(user, id);
  const full = resolve(dirOf(row), cleanSkillPath(path));
  if (!full.startsWith(dirOf(row) + sep)) throw err(400, 'Not a valid file path');
  try {
    return readFileSync(full, 'utf8');
  } catch {
    throw err(404, 'File not found');
  }
}

export function deleteSkill(user: SkillUser, id: string) {
  const row = getSkill(user, id, true);
  rmSync(dirOf(row), { recursive: true, force: true });
  db.prepare('DELETE FROM skills WHERE id = ?').run(row.id);
}

/** Admins: shared skills can be used by every user. */
export function shareSkill(id: string, shared: boolean) {
  db.prepare('UPDATE skills SET shared = ? WHERE id = ?').run(shared ? 1 : 0, id);
}

export function exportSkill(user: SkillUser, id: string): { name: string; zip: Buffer } {
  const row = getSkill(user, id);
  const files = skillFiles(row).map((f) => ({ name: `${row.name}/${f.path}`, data: readFileSync(join(dirOf(row), f.path)) }));
  return { name: row.name, zip: createZip(files) };
}

/**
 * What a run's blocks may use: the person's own and shared skills, by name (their own wins over a shared one with
 * the same name).
 */
export function skillsForRun(user: SkillUser) {
  const rows = (db.prepare('SELECT * FROM skills WHERE owner_id = ? OR shared = 1 ORDER BY owner_id = ? DESC').all(user.id, user.id) as unknown as SkillRow[]).filter(
    (r, i, all) => all.findIndex((x) => x.name.toLowerCase() === r.name.toLowerCase()) === i,
  );
  const byName = (name: string) => rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  return {
    list: () => rows.map((r) => ({ name: r.name, description: r.description })),
    /** The skill's instructions for a system prompt: SKILL.md's body and its other files by name, cut at 30,000 chars. */
    load: (name: string): string | undefined => {
      const row = byName(name);
      if (!row) return;
      let md: SkillMd;
      try {
        md = parseSkillMd(readFileSync(join(dirOf(row), 'SKILL.md'), 'utf8'));
      } catch {
        return;
      }
      const extra = skillFiles(row).filter((f) => f.path !== 'SKILL.md');
      let text = `## Skill: ${md.name}\n${md.description}\n\n${md.body}`;
      // Small extra files come along whole, while they fit; the rest are only named.
      const named: string[] = [];
      for (const f of extra) {
        if (text.length + f.size + 40 < SKILL_LIMITS.promptChars && f.size < 20_000) text += `\n\n### ${f.path}\n${readFileSync(join(dirOf(row), f.path), 'utf8')}`;
        else named.push(f.path);
      }
      if (named.length) text += `\n\n(Other files in this skill, not included: ${named.join(', ')})`;
      if (text.length > SKILL_LIMITS.promptChars) text = `${text.slice(0, SKILL_LIMITS.promptChars)}\n\n(… skill cut off at ${SKILL_LIMITS.promptChars} characters)`;
      return text;
    },
  };
}
