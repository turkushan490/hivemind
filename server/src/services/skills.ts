import type { Skill } from '@hivemind/shared';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { newId } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';
import { githubToken, REPO_RE } from './git.js';
import { binaryPath, cleanName as cleanSkillName, findSkills, isTextFile, readSkillText, toSkillMd, unpack, type SkillFile } from './skillFormats.js';
import { createZip, readZip } from './zip.js';
import { isUnlocked } from './unlock.js';

// Unlock mode: a locked (hidden) skill only shows for its owner while unlocked, and only hidden workflows use it.
// Added here, outside the numbered migrations, so it never clashes with them.
if (!(db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]).some((c) => c.name === 'hidden')) {
  db.exec('ALTER TABLE skills ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}

/**
 * Skills: a folder with a SKILL.md (frontmatter name + description, then instructions) and optional extra text
 * files, the same format as Claude skills. Blocks put a skill's instructions in their system prompt. Files are
 * only ever read as text: nothing in a skill is run.
 */

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const skillsDir = resolve(config.dataDir, 'skills');
mkdirSync(skillsDir, { recursive: true });

export const SKILL_LIMITS = { fileBytes: 1024 * 1024, totalBytes: 10 * 1024 * 1024, files: 200, promptChars: 30_000 };

export interface SkillMd {
  name: string;
  description: string;
  body: string;
}

/**
 * Reads a SKILL.md leniently: frontmatter (YAML or TOML) with name and description when there is one; a missing or
 * odd name is made from the heading or `fallbackName`, a missing description from the first sentence.
 */
export function parseSkillMd(text: string, fallbackName?: string): SkillMd {
  const m = readSkillText(text, 'SKILL.md', { folder: fallbackName });
  return { name: m.name, description: m.description, body: m.body };
}

interface SkillRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  shared: number;
  folder: string;
  updated_at: string;
  hidden?: number;
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
    ...(row.hidden ? { hidden: true } : {}),
  };
}

/** Your own skills and the shared ones (a full admin: all of them). */
export function listSkills(user: SkillUser): Skill[] {
  const rows = db
    .prepare(`SELECT s.*, u.username FROM skills s LEFT JOIN users u ON u.id = s.owner_id ${isFullAdmin(user) ? '' : 'WHERE s.owner_id = ? OR s.shared = 1'} ORDER BY s.name COLLATE NOCASE`)
    .all(...(isFullAdmin(user) ? [] : [user.id])) as unknown as SkillRow[];
  // Locked skills: only your own, only while unlocked (also for an admin). Locked ones first.
  return rows
    .filter((r) => seesSkill(user, r))
    .sort((a, b) => (b.hidden ?? 0) - (a.hidden ?? 0))
    .map((r) => toSkill(r, user));
}

/** A locked skill: only its owner, only while unlocked. Others: everyone who may use it. */
const seesSkill = (user: SkillUser, row: SkillRow) => !row.hidden || (row.owner_id === user.id && isUnlocked(user as Parameters<typeof isUnlocked>[0]));

/** A skill this user may use (own or shared); edit=true: only its owner (or a full admin). */
function getSkill(user: SkillUser, id: string, edit = false, run = false): SkillRow {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
  // run: a hidden workflow's own run reads and saves its owner's locked skills, also when the lock came on meanwhile.
  const may = row && (run ? !row.hidden || row.owner_id === user.id : seesSkill(user, row)) && (row.owner_id === user.id || isFullAdmin(user) || (!edit && row.shared));
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

/**
 * Stores a skill from its files (SKILL.md + extras). Non-text files are left out (listed in skipped). An existing
 * skill of yours with the same name is replaced. A SKILL.md without a proper name/description gets one written.
 */
export function saveSkill(user: SkillUser, files: SkillFile[], opts: { replaceId?: string; fallbackName?: string; run?: boolean } = {}): { skill: Skill; skipped: string[] } {
  const md = files.find((f) => f.path.toUpperCase() === 'SKILL.MD');
  if (!md) throw err(400, 'No SKILL.md found (it must be at the top of the skill folder)');
  if (!isTextFile(md)) throw err(400, 'SKILL.md is not a text file');
  const text = md.data.toString('utf8');
  const full = readSkillText(text, 'SKILL.md', { folder: opts.fallbackName });
  const meta = { name: full.name, description: full.description, body: full.body };
  // Keep it as written when it already says its name and description; otherwise write them in.
  const fm = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const proper = new RegExp(`^name:\\s*['"]?${meta.name.replace(/[.]/g, '\\.')}['"]?\\s*$`, 'm').test(fm) && /^description:\s*\S/m.test(fm);
  const mdData = proper ? md.data : Buffer.from(toSkillMd(full));
  const keep: SkillFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files) {
    const path = cleanSkillPath(f.path);
    if (f.data.length > SKILL_LIMITS.fileBytes || !isTextFile({ path, data: f.data })) {
      skipped.push(path);
      continue;
    }
    const isMd = path.toUpperCase() === 'SKILL.MD';
    total += isMd ? mdData.length : f.data.length;
    if (total > SKILL_LIMITS.totalBytes) throw err(413, `The skill is too big (at most ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB of text)`);
    keep.push(isMd ? { path: 'SKILL.md', data: mdData } : { path, data: f.data });
  }
  if (keep.length > SKILL_LIMITS.files) throw err(413, `A skill may have at most ${SKILL_LIMITS.files} files`);
  const existing = opts.replaceId
    ? getSkill(user, opts.replaceId, true, opts.run)
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
  return { skill: toSkill(getSkill(user, id, false, opts.run), user), skipped };
}

export interface ImportResult {
  /** The first skill (older clients read only this one). */
  skill: Skill;
  skills: Skill[];
  skipped: string[];
}

/** Saves every skill found in these files (any format, see skillFormats.ts). */
export function importSkillFiles(user: SkillUser, files: SkillFile[], opts: { under?: string; hintName?: string } = {}): ImportResult {
  const found = findSkills(files, opts);
  const skills: Skill[] = [];
  const skipped: string[] = [];
  for (const s of found) {
    const r = saveSkill(user, s.files, { fallbackName: opts.hintName });
    skills.push(r.skill);
    skipped.push(...r.skipped.map((p) => (found.length > 1 ? `${r.skill.name}/${p}` : p)));
  }
  return { skill: skills[0], skills, skipped };
}

/** An uploaded file: a .zip / .skill / .tar(.gz) with one or more skills, or one skill file in any format. */
export function importSkillZip(user: SkillUser, buf: Buffer, filename = ''): ImportResult {
  const stem = (filename.split(/[\\/]/).pop() ?? '').replace(/(\.(tar|prompt|instructions))?\.[A-Za-z0-9]+$/i, '');
  return importSkillFiles(user, unpack(buf, filename), { hintName: stem || undefined });
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
  const entries = readZip(buf, { file: 50 * 1024 * 1024, total: 300 * 1024 * 1024 }).map((e) => ({
    // GitHub puts everything in one "owner-repo-sha/" folder.
    path: e.name.replace(/\\/g, '/').split('/').slice(1).join('/'),
    data: e.data as Buffer,
  }));
  return importSkillFiles(
    user,
    entries.filter((e) => e.path),
    { under: path, hintName: (path.split('/').pop() || repo.split('/')[1]) ?? undefined },
  );
}

/** Writes (or replaces) one file of your skill; SKILL.md is checked first. */
export function writeSkillFile(user: SkillUser, id: string, path: string, content: string): Skill {
  const row = getSkill(user, id, true);
  const clean = cleanSkillPath(path);
  if (binaryPath(clean)) throw err(400, 'Skills hold text files only');
  if (Buffer.byteLength(content) > SKILL_LIMITS.fileBytes) throw err(413, 'That file is too big (at most 1 MB)');
  const files = skillFiles(row)
    .filter((f) => f.path !== clean)
    .map((f) => ({ path: f.path, data: readFileSync(join(dirOf(row), f.path)) }));
  files.push({ path: clean, data: Buffer.from(content) });
  return saveSkill(user, files, { replaceId: row.id, fallbackName: row.name }).skill;
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

/** Admins: shared skills can be used by every user. A locked skill is never shared. */
export function shareSkill(id: string, shared: boolean) {
  db.prepare('UPDATE skills SET shared = ? WHERE id = ? AND hidden = 0').run(shared ? 1 : 0, id);
}

/** Lock (hide) or unlock a skill: only its owner, only while unlocked. Locking stops sharing it. */
export function lockSkill(user: SkillUser, id: string, hidden: boolean): Skill {
  const row = getSkill(user, id, true);
  if (row.owner_id !== user.id) throw err(403, 'Only the owner can lock or unlock a skill');
  db.prepare(`UPDATE skills SET hidden = ?${hidden ? ', shared = 0' : ''} WHERE id = ?`).run(hidden ? 1 : 0, row.id);
  return toSkill(getSkill(user, id), user);
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
export function skillsForRun(user: SkillUser, opts: { hidden?: boolean } = {}) {
  // A hidden workflow also gets its owner's locked skills; every other run never sees them.
  const rows = (
    db.prepare(`SELECT * FROM skills WHERE (owner_id = ? OR shared = 1)${opts.hidden ? ' AND (hidden = 0 OR owner_id = ?)' : ' AND hidden = 0'} ORDER BY hidden DESC, owner_id = ? DESC`).all(
      ...(opts.hidden ? [user.id, user.id, user.id] : [user.id, user.id]),
    ) as unknown as SkillRow[]
  ).filter(
    (r, i, all) => all.findIndex((x) => x.name.toLowerCase() === r.name.toLowerCase()) === i,
  );
  const byName = (name: string) => rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
  return {
    list: () => rows.map((r) => ({ name: r.name, description: r.description })),
    /** A skill's text files as they are (the Skill block, to edit it). */
    raw: (name: string): { path: string; text: string }[] | undefined => {
      const row = byName(name);
      if (!row) return;
      return skillFiles(row)
        .filter((f) => f.size < 60_000)
        .map((f) => ({ path: f.path, text: readFileSync(join(dirOf(row), f.path), 'utf8') }));
    },
    /**
     * Saves a SKILL.md (the Skill block): a new skill, or an update of the person's own skill with that name. A hidden
     * workflow's new skill is locked; a normal run never touches a locked skill.
     */
    save: (md: string, name?: string): { name: string; created: boolean; locked: boolean } => {
      const full = readSkillText(md, 'SKILL.md');
      // A name given ("Save as"): the skill is saved under that name, whatever the text says (the old one stays as it was).
      const as = name ? cleanSkillName(name) : '';
      const finalName = as || full.name;
      const text = as && as !== full.name ? toSkillMd({ ...full, name: as }) : md;
      const own = db.prepare('SELECT id, hidden FROM skills WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(user.id, finalName) as { id: string; hidden: number } | undefined;
      if (own?.hidden && !opts.hidden) throw err(409, `A skill named "${finalName}" can't be changed here: give it another name`);
      const r = saveSkill(user, [{ path: 'SKILL.md', data: Buffer.from(text) }], { fallbackName: finalName, run: true, ...(own && { replaceId: own.id }) });
      const locked = own ? !!own.hidden : !!opts.hidden;
      if (!own && opts.hidden) db.prepare('UPDATE skills SET hidden = 1, shared = 0 WHERE id = ?').run(r.skill.id);
      return { name: r.skill.name, created: !own, locked };
    },
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

// ---- Built-in skills (server/skills/*/SKILL.md): shared with everyone, owned by the first admin ----

const here = dirname(fileURLToPath(import.meta.url));
const builtinDir = () => [resolve(here, '../skills'), resolve(here, '../../skills')].find((d) => existsSync(d));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/**
 * Installs the skills that come with HiveMind (e.g. "hivemind-workflows", the guide to building workflows) and
 * updates them with new versions, unless an admin changed the skill: then their version stays.
 */
export function seedBuiltinSkills() {
  const dir = builtinDir();
  const admin = db.prepare("SELECT id, role FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as { id: string; role: string } | undefined;
  if (!dir || !admin) return;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const data = readFileSync(file);
    const meta = parseSkillMd(data.toString('utf8'));
    const key = `skills.builtin.${meta.name}`;
    const row = db.prepare('SELECT * FROM skills WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(admin.id, meta.name) as SkillRow | undefined;
    if (row) {
      let current = '';
      try {
        current = sha(readFileSync(join(dirOf(row), 'SKILL.md')));
      } catch {}
      // Changed by an admin since it was installed: leave it.
      if (current !== getSetting(key) || current === sha(data)) continue;
    }
    try {
      const { skill } = saveSkill(admin, [{ path: 'SKILL.md', data }]);
      shareSkill(skill.id, true);
      setSetting(key, sha(data));
    } catch (e) {
      console.error(`Built-in skill ${name}: ${(e as Error).message}`);
    }
  }
}
