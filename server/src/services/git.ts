import type { GithubSettings, GitStatus } from '@hivemind/shared';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decrypt, encrypt } from '../crypto.js';
import { db } from '../db/index.js';
import { rootOf, touchProject } from './projects.js';

/**
 * Git and GitHub for projects, with the git CLI inside the HiveMind image. The token never goes into .git/config
 * or a remote URL: each call gets it as an Authorization header through git's environment (GIT_CONFIG_*), and
 * every message that leaves here has it masked.
 */

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** owner/name, as GitHub allows them. */
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,100}(?<![./])$/;

export const githubApi = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

/** Where a repo is cloned from: github.com, or (tests) a folder of bare repos in HIVEMIND_GIT_REMOTE_BASE. */
export function remoteUrl(repo: string): string {
  const base = process.env.HIVEMIND_GIT_REMOTE_BASE;
  return base ? join(base, `${repo}.git`) : `https://github.com/${repo}.git`;
}

export function checkBranch(branch: unknown): string {
  const b = String(branch ?? '').trim() || 'main';
  if (!BRANCH_RE.test(b)) throw err(400, `Not a valid branch name: ${b.slice(0, 60)}`);
  return b;
}

// ---- Settings → GitHub (per user) ----

interface AccountRow {
  token_enc: string;
  last4: string;
  login: string | null;
  author_name: string | null;
  author_email: string | null;
}

const account = (userId: string) => db.prepare('SELECT token_enc, last4, login, author_name, author_email FROM github_accounts WHERE user_id = ?').get(userId) as AccountRow | undefined;

export function githubSettings(userId: string): GithubSettings {
  const a = account(userId);
  if (!a) return { hasToken: false };
  return { hasToken: true, last4: a.last4, ...(a.login && { login: a.login }), ...(a.author_name && { authorName: a.author_name }), ...(a.author_email && { authorEmail: a.author_email }) };
}

/** The user's token, decrypted (only inside the server). */
export function githubToken(userId: string): string | undefined {
  const a = account(userId);
  return a ? decrypt(a.token_enc) : undefined;
}

export async function saveGithubSettings(userId: string, body: { token?: unknown; authorName?: unknown; authorEmail?: unknown }) {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const name = typeof body.authorName === 'string' ? body.authorName.trim().slice(0, 100) : undefined;
  const email = typeof body.authorEmail === 'string' ? body.authorEmail.trim().slice(0, 200) : undefined;
  if (email && !/^[^\s@<>]+@[^\s@<>]+$/.test(email)) throw err(400, 'Not a valid e-mail address');
  if (token) {
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw err(400, 'That does not look like a GitHub token');
    const login = await githubLogin(token).catch((e: Error) => {
      throw err(400, `GitHub did not accept the token: ${e.message}`);
    });
    db.prepare(
      `INSERT INTO github_accounts (user_id, token_enc, last4, login, author_name, author_email) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET token_enc = excluded.token_enc, last4 = excluded.last4, login = excluded.login,
         author_name = COALESCE(excluded.author_name, author_name), author_email = COALESCE(excluded.author_email, author_email)`,
    ).run(userId, encrypt(token), token.slice(-4), login ?? null, name || null, email || null);
  } else {
    if (!account(userId)) throw err(400, 'Add a GitHub token first');
    if (name !== undefined) db.prepare('UPDATE github_accounts SET author_name = ? WHERE user_id = ?').run(name || null, userId);
    if (email !== undefined) db.prepare('UPDATE github_accounts SET author_email = ? WHERE user_id = ?').run(email || null, userId);
  }
  return githubSettings(userId);
}

export const removeGithub = (userId: string) => db.prepare('DELETE FROM github_accounts WHERE user_id = ?').run(userId);

/** Calls the GitHub API with the token; errors carry GitHub's message (never the token). */
export async function githubFetch<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${githubApi()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'HiveMind',
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
      msg = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ') || msg;
    } catch {}
    throw err(res.status === 401 || res.status === 403 ? 400 : 502, `GitHub ${res.status}: ${mask(msg, token)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const githubLogin = async (token: string) => (await githubFetch<{ login?: string }>(token, '/user')).login;

/** Settings → GitHub → Test: who the token belongs to. */
export async function testGithub(userId: string): Promise<{ login?: string }> {
  const token = githubToken(userId);
  if (!token) throw err(400, 'Add a GitHub token first');
  const login = await githubLogin(token);
  if (login) db.prepare('UPDATE github_accounts SET login = ? WHERE user_id = ?').run(login, userId);
  return { login };
}

/** The repos the token can reach (for the Connect dialog). */
export async function listRepos(userId: string): Promise<{ fullName: string; private: boolean; defaultBranch: string }[]> {
  const token = githubToken(userId);
  if (!token) throw err(400, 'Add a GitHub token first (Settings → GitHub)');
  const repos = await githubFetch<{ full_name: string; private: boolean; default_branch: string }[]>(token, '/user/repos?per_page=100&sort=updated');
  return repos.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch }));
}

// ---- The git CLI ----

/** Hides the token (and its Basic form) in anything shown to people or logged. */
export function mask(text: string, token?: string): string {
  if (!token) return text;
  let out = text.split(token).join('***');
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  out = out.split(basic).join('***');
  return out;
}

export interface GitOpts {
  /** The token for this call (fetch/push/clone). */
  token?: string;
  author?: { name: string; email: string };
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Runs git in a folder. Hooks are off, links are written as plain files, no prompts, no system or user config.
 * The token goes in as an extra header through the environment, for this call only.
 */
export function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: tmpdir(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    LC_ALL: 'C',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const config: [string, string][] = [
    ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    ['core.symlinks', 'false'],
    ['protocol.file.allow', process.env.HIVEMIND_GIT_REMOTE_BASE ? 'always' : 'never'],
    ['protocol.ext.allow', 'never'],
    ['safe.directory', '*'],
  ];
  if (opts.token) config.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`]);
  if (opts.author) {
    config.push(['user.name', opts.author.name], ['user.email', opts.author.email]);
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = opts.author.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = opts.author.email;
  }
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(err(500, `git could not start: ${(e as Error).message}`));
    }
    let out = '';
    let errText = '';
    child.stdout.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-200_000)));
    child.stderr.on('data', (d: Buffer) => (errText = (errText + d.toString()).slice(-20_000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err(500, e.code === 'ENOENT' ? 'git is not installed in this HiveMind image' : mask(e.message, opts.token)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) return resolvePromise(out);
      const msg = mask((errText || out).trim().split('\n').slice(-6).join('\n'), opts.token);
      reject(err(400, `git ${args[0]} failed: ${msg || `exit code ${code}`}`));
    });
  });
}

const isRepo = (cwd: string) => {
  try {
    return readdirSync(cwd).includes('.git');
  } catch {
    return false;
  }
};

interface ProjectGit {
  id: string;
  owner_id: string;
  github_repo: string | null;
  github_branch: string | null;
}

function needRepo(p: ProjectGit): { repo: string; branch: string; cwd: string } {
  if (!p.github_repo || !isRepo(rootOf(p))) throw err(400, 'This project is not connected to GitHub (Project → Connect to GitHub)');
  return { repo: p.github_repo, branch: p.github_branch ?? 'main', cwd: rootOf(p) };
}

function needToken(userId: string): string {
  const t = githubToken(userId);
  if (!t && !process.env.HIVEMIND_GIT_REMOTE_BASE) throw err(400, 'Add a GitHub token first (Settings → GitHub)');
  return t ?? '';
}

/** Who commits: Settings → GitHub, else the token's login, else "HiveMind". */
function authorOf(userId: string): { name: string; email: string } {
  const a = account(userId);
  const name = a?.author_name || a?.login || 'HiveMind';
  const email = a?.author_email || (a?.login ? `${a.login}@users.noreply.github.com` : 'hivemind@localhost');
  return { name, email };
}

/**
 * Connects a project to a GitHub repo: a new private one (create), or an existing one. An empty project gets the
 * repo's files (clone); a project with files starts the branch with them, which only works when that branch is
 * still empty on GitHub.
 */
export async function connectProject(p: ProjectGit, userId: string, body: { repo?: unknown; branch?: unknown; create?: unknown }) {
  const token = needToken(userId);
  const branch = checkBranch(body.branch);
  let repo = String(body.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (body.create) {
    const name = repo.includes('/') ? repo.split('/')[1] : repo;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw err(400, 'Give the new repo a name (letters, numbers, . - _)');
    const made = await githubFetch<{ full_name: string }>(token, '/user/repos', { method: 'POST', body: { name, private: true, auto_init: false } });
    repo = made.full_name;
  }
  if (!REPO_RE.test(repo)) throw err(400, 'Pick a repo as owner/name');
  const cwd = rootOf(p);
  if (isRepo(cwd)) rmSync(join(cwd, '.git'), { recursive: true, force: true });
  const url = remoteUrl(repo);
  const remoteHas = (await git(cwd, ['ls-remote', '--heads', url, branch], { token })).trim().length > 0;
  const empty = readdirSync(cwd).length === 0;
  if (remoteHas && empty) {
    await git(cwd, ['clone', '--branch', branch, '--single-branch', url, '.'], { token, timeoutMs: 600_000 });
  } else if (remoteHas) {
    throw err(409, `The project already has files and ${repo} already has commits on ${branch}: connect an empty project to get the repo's files, or pick a new branch`);
  } else {
    await git(cwd, ['init', '-b', branch], {});
    await git(cwd, ['remote', 'add', 'origin', url], {});
  }
  db.prepare("UPDATE projects SET github_repo = ?, github_branch = ?, updated_at = datetime('now') WHERE id = ?").run(repo, branch, p.id);
  return { repo, branch, cloned: remoteHas };
}

export function disconnectProject(p: ProjectGit) {
  rmSync(join(rootOf(p), '.git'), { recursive: true, force: true });
  db.prepare('UPDATE projects SET github_repo = NULL, github_branch = NULL WHERE id = ?').run(p.id);
}

export async function gitStatus(p: ProjectGit): Promise<GitStatus> {
  if (!p.github_repo || !isRepo(rootOf(p))) return { connected: false, changes: [], ahead: 0 };
  const cwd = rootOf(p);
  const branch = p.github_branch ?? 'main';
  const changes = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean).slice(0, 500);
  let ahead = 0;
  try {
    ahead = Number((await git(cwd, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim()) || 0;
  } catch {
    ahead = Number((await git(cwd, ['rev-list', '--count', 'HEAD']).catch(() => '0')).trim()) || 0;
  }
  let lastCommit: GitStatus['lastCommit'];
  const log = (await git(cwd, ['log', '-1', '--format=%H%x1f%s%x1f%cI']).catch(() => '')).trim();
  if (log) {
    const [sha, message, at] = log.split('\x1f');
    lastCommit = { sha, message, at };
  }
  return { repo: p.github_repo, branch, connected: true, changes, ahead, ...(lastCommit && { lastCommit }) };
}

/** The last commits (the project page's history). */
export async function gitLog(p: ProjectGit, limit = 30): Promise<{ sha: string; message: string; at: string; author: string }[]> {
  if (!p.github_repo || !isRepo(rootOf(p))) return [];
  const out = await git(rootOf(p), ['log', `-${limit}`, '--format=%H%x1f%s%x1f%cI%x1f%an']).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, message, at, author] = l.split('\x1f');
      return { sha, message, at, author };
    });
}

export async function gitCommit(p: ProjectGit, userId: string, message: string, signal?: AbortSignal): Promise<{ sha?: string; nothing?: boolean }> {
  const { cwd } = needRepo(p);
  await git(cwd, ['add', '-A'], { signal });
  if (!(await git(cwd, ['status', '--porcelain'], { signal })).trim()) return { nothing: true };
  const msg = message.trim().slice(0, 5000) || 'Update from HiveMind';
  await git(cwd, ['commit', '-q', '-m', msg], { author: authorOf(userId), signal });
  touchProject(p.id);
  return { sha: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
}

/** Pushes the branch. Never with --force: when GitHub has newer commits it fails, and Pull comes first. */
export async function gitPush(p: ProjectGit, userId: string, signal?: AbortSignal, toBranch?: string): Promise<{ branch: string; url: string }> {
  const { repo, branch, cwd } = needRepo(p);
  const token = needToken(userId);
  const target = toBranch ?? branch;
  await git(cwd, ['push', 'origin', `HEAD:refs/heads/${target}`], { token, signal, timeoutMs: 600_000 });
  await git(cwd, ['fetch', '-q', 'origin', target], { token, signal }).catch(() => {});
  return { branch: target, url: `https://github.com/${repo}/tree/${encodeURIComponent(target)}` };
}

/**
 * Gets GitHub's newest commits. Your own commits that GitHub doesn't have yet are put on top of them (rebase);
 * when both changed the same lines, nothing changes and the message names the files. Uncommitted edits are
 * committed first, so they can't be lost.
 */
export async function gitPull(p: ProjectGit, userId: string, signal?: AbortSignal): Promise<{ updated: boolean }> {
  const { branch, cwd } = needRepo(p);
  const token = needToken(userId);
  const author = authorOf(userId);
  const before = (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  await git(cwd, ['fetch', '-q', 'origin', branch], { token, signal, timeoutMs: 600_000 });
  await git(cwd, ['add', '-A'], { signal });
  if ((await git(cwd, ['status', '--porcelain'], { signal })).trim()) await git(cwd, ['commit', '-q', '-m', 'Changes made in HiveMind'], { author, signal });
  if (!before) {
    await git(cwd, ['reset', '-q', '--hard', `origin/${branch}`], { signal });
  } else {
    try {
      await git(cwd, ['rebase', '-q', `origin/${branch}`], { author, signal, timeoutMs: 300_000 });
    } catch (e) {
      const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean);
      await git(cwd, ['rebase', '--abort']).catch(() => {});
      throw err(409, conflicts.length ? `Your changes and GitHub's changes touch the same lines in: ${conflicts.join(', ')}. Nothing was changed; fix it on GitHub, or make a pull request instead` : (e as Error).message);
    }
  }
  touchProject(p.id);
  return { updated: (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim() !== before };
}

/** Commits on a new branch, pushes it and opens a pull request into the project's branch. */
export async function gitPullRequest(p: ProjectGit, userId: string, opts: { title: string; body: string; branch?: string; signal?: AbortSignal }): Promise<{ url: string; branch: string; sha?: string }> {
  const { repo, branch, cwd } = needRepo(p);
  const token = needToken(userId);
  const head = checkBranch(opts.branch || `hivemind/${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`);
  const current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(cwd, ['checkout', '-q', '-B', head], { signal: opts.signal });
  try {
    const c = await gitCommit(p, userId, opts.title, opts.signal);
    await gitPush(p, userId, opts.signal, head);
    let url = `https://github.com/${repo}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(head)}`;
    if (!process.env.HIVEMIND_GIT_REMOTE_BASE) {
      const pr = await githubFetch<{ html_url: string }>(token, `/repos/${repo}/pulls`, { method: 'POST', body: { title: opts.title.slice(0, 250), body: opts.body.slice(0, 60_000), head, base: branch } });
      url = pr.html_url;
    }
    return { url, branch: head, sha: c.sha };
  } finally {
    await git(cwd, ['checkout', '-q', current]).catch(() => {});
  }
}

/** A throwaway folder for imports (skills from GitHub). */
export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
