import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * Installers: the apps that work with HiveMind, kept inside the container (/data/installers/<app>/<version>/<file>),
 * so the owner installs them from HiveMind: HiveBot for Windows (the .exe) and the robot firmware per board
 * (flashed from the browser over Web Serial). Apps upload a release themselves with a token that has the
 * "installers" permission, or HiveMind fetches the latest GitHub release with the owner's GitHub token.
 */

export const installersDir = resolve(config.dataDir, 'installers');

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const PART = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
/** What may be stored: programs, firmware, manifests and notes (no scripts that a browser would run). */
const ALLOWED = /\.(exe|msi|zip|bin|elf|json|md|txt|sha256|uf2|apk)$/i;

function dirOf(app: string, version?: string, file?: string): string {
  for (const p of [app, version, file]) if (p !== undefined && !PART.test(p)) throw err(400, `"${p}" is not a valid name`);
  const full = resolve(installersDir, ...[app, version, file].filter((x): x is string => x !== undefined));
  if (!full.startsWith(installersDir + sep)) throw err(400, 'Not a valid path');
  return full;
}

export interface InstallerFile {
  name: string;
  size: number;
  sha256?: string;
}
export interface InstallerVersion {
  version: string;
  files: InstallerFile[];
  added: string;
  notes?: string;
}
export interface InstallerApp {
  app: string;
  versions: InstallerVersion[];
  githubRepo?: string;
}

/** Natural version order, newest first ("v0.10.0" after "v0.9.4"). */
const byVersion = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });

export function listInstallers(): InstallerApp[] {
  if (!existsSync(installersDir)) return [];
  const repos = githubRepos();
  const apps = new Set([...readdirSync(installersDir).filter((a) => PART.test(a)), ...Object.keys(repos)]);
  return [...apps].sort().map((app) => {
    const dir = join(installersDir, app);
    const versions = existsSync(dir)
      ? readdirSync(dir)
          .filter((v) => PART.test(v) && statSync(join(dir, v)).isDirectory())
          .sort(byVersion)
          .map((version) => {
            const vdir = join(dir, version);
            const names = readdirSync(vdir).filter((f) => PART.test(f) && !f.endsWith('.sha256') && statSync(join(vdir, f)).isFile());
            const sums = (f: string) => (existsSync(join(vdir, `${f}.sha256`)) ? readFileSync(join(vdir, `${f}.sha256`), 'utf8').trim() : undefined);
            const notes = names.find((f) => /^(changelog|notes|release)\.md$/i.test(f));
            return {
              version,
              files: names.filter((f) => f !== notes).map((name) => ({ name, size: statSync(join(vdir, name)).size, ...(sums(name) && { sha256: sums(name) }) })),
              added: statSync(vdir).mtime.toISOString(),
              ...(notes && { notes: readFileSync(join(vdir, notes), 'utf8').slice(0, 20_000) }),
            };
          })
      : [];
    return { app, versions, ...(repos[app] && { githubRepo: repos[app] }) };
  });
}

/** Stores one file of a release (the app's build script calls this after each release). */
export function putInstallerFile(app: string, version: string, file: string, data: Buffer) {
  if (!ALLOWED.test(file)) throw err(400, `${file}: only .exe, .msi, .zip, .apk, .bin, .elf, .uf2, .json, .md and .txt files`);
  if (!data.length) throw err(400, 'The file is empty');
  if (data.length > 300 * 1024 * 1024) throw err(413, 'At most 300 MB per file');
  const vdir = dirOf(app, version);
  mkdirSync(vdir, { recursive: true });
  writeFileSync(join(vdir, file), data);
  writeFileSync(join(vdir, `${file}.sha256`), createHash('sha256').update(data).digest('hex'));
  return { app, version, file, size: data.length };
}

export function installerFilePath(app: string, version: string, file: string): string {
  const full = dirOf(app, version, file);
  if (!existsSync(full) || !statSync(full).isFile()) throw err(404, 'No such file');
  return full;
}

export function deleteInstallerVersion(app: string, version: string) {
  rmSync(dirOf(app, version), { recursive: true, force: true });
}

/** The newest version of an app that has a file matching `pick`. */
export function latestFile(app: string, pick: (name: string) => boolean): { version: string; file: string; sha256?: string } | undefined {
  const a = listInstallers().find((x) => x.app === app);
  for (const v of a?.versions ?? []) {
    const f = v.files.find((x) => pick(x.name));
    if (f) return { version: v.version, file: f.name, ...(f.sha256 && { sha256: f.sha256 }) };
  }
  return undefined;
}

// ---- GitHub releases ----

const REPOS_KEY = 'installers.repos';
/** The robot firmware app, and its files: <board>-bootloader|partitions|ota_data_initial|firmware|srmodels.bin. */
export const FIRMWARE_APP = 'hivebot-robot';
const FIRMWARE_FILE = /^(cores3|t-dongle-s3|sticks3)-[\w.-]+\.bin$|^firmware-version\.txt$/;
export function githubRepos(): Record<string, string> {
  try {
    return JSON.parse(getSetting(REPOS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
export function setGithubRepo(app: string, repo: string | null) {
  dirOf(app);
  const all = githubRepos();
  if (repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw err(400, 'The repository is "owner/name"');
    all[app] = repo;
  } else delete all[app];
  setSetting(REPOS_KEY, JSON.stringify(all));
}

/** Downloads the latest GitHub release of the app's repository (a private one with the owner's GitHub token). */
export async function fetchGithubRelease(app: string, token: string | undefined): Promise<{ version: string; files: string[] }> {
  const repo = githubRepos()[app];
  if (!repo) throw err(400, `Set the GitHub repository of ${app} first`);
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'HiveMind', ...(token && { authorization: `Bearer ${token}` }) };
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw err(404, `No release found in ${repo} (a private repository needs your GitHub token in Settings → GitHub)`);
  if (!res.ok) throw err(502, `GitHub: HTTP ${res.status}`);
  const rel = (await res.json()) as { tag_name: string; body?: string; assets: { name: string; url: string; size: number }[] };
  const version = rel.tag_name.replace(/[^A-Za-z0-9._+-]/g, '-');
  const files: string[] = [];
  for (const a of rel.assets.filter((x) => ALLOWED.test(x.name) && PART.test(x.name))) {
    const r = await fetch(a.url, { headers: { ...headers, accept: 'application/octet-stream' }, signal: AbortSignal.timeout(15 * 60_000) });
    if (!r.ok) throw err(502, `GitHub: downloading ${a.name} failed (HTTP ${r.status})`);
    // Robot firmware in the same release (<board>-*.bin, firmware-version.txt) goes to the firmware app.
    const target = FIRMWARE_FILE.test(a.name) ? FIRMWARE_APP : app;
    putInstallerFile(target, version, a.name, Buffer.from(await r.arrayBuffer()));
    files.push(target === app ? a.name : `${target}/${a.name}`);
  }
  if (rel.body) writeFileSync(join(dirOf(app, version), 'release.md'), rel.body.slice(0, 20_000));
  if (!files.length) throw err(404, `The release ${rel.tag_name} of ${repo} has no files HiveMind can keep`);
  return { version, files };
}
