import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * Outside folders: folders of other apps mounted into this container (for example T3 Code's projects as /projects),
 * which HiveMind may open as projects, so workflows read and change the same files the other app works on.
 * Off by default; an admin switches it on in Settings → Projects. Only folders below a listed root are reachable,
 * and deleting such a project never deletes the folder.
 */

export interface OutsideFolders {
  enabled: boolean;
  /** Folders inside this container, each mounted from the host in the Docker template (e.g. /projects). */
  roots: string[];
}

const KEY = 'outside.folders';
const DEFAULT: OutsideFolders = { enabled: false, roots: ['/projects'] };

export function outsideFolders(): OutsideFolders {
  try {
    const s = JSON.parse(getSetting(KEY) ?? '{}') as Partial<OutsideFolders>;
    return { enabled: !!s.enabled, roots: Array.isArray(s.roots) ? s.roots.filter((r) => typeof r === 'string') : DEFAULT.roots };
  } catch {
    return { ...DEFAULT };
  }
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Folders HiveMind itself keeps: never an "outside" root. */
const OWN = ['/', '/app', '/data', '/opt', '/usr', '/etc', '/bin', '/sbin', '/lib', '/proc', '/sys', '/dev', '/root', '/var', '/tmp'];

export function saveOutsideFolders(patch: Partial<OutsideFolders>): OutsideFolders {
  const next = outsideFolders();
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.roots !== undefined) {
    if (!Array.isArray(patch.roots)) throw err(400, 'roots must be a list of folders');
    const roots = [...new Set(patch.roots.map((r) => String(r).trim().replace(/\/+$/, '')).filter(Boolean))];
    for (const r of roots) {
      if (!isAbsolute(r) || r.includes('..')) throw err(400, `"${r}" must be an absolute folder inside the container, like /projects`);
      if (OWN.some((o) => r === o || (o !== '/' && r.startsWith(`${o}/`) && o !== '/tmp'))) throw err(400, `"${r}" is one of HiveMind's own folders`);
      const data = resolve(config.dataDir);
      if (resolve(r) === data || resolve(r).startsWith(data + sep) || data.startsWith(resolve(r) + sep)) throw err(400, `"${r}" holds HiveMind's own data`);
    }
    next.roots = roots.slice(0, 10);
  }
  setSetting(KEY, JSON.stringify(next));
  return next;
}

/** The real path of an outside folder, when it is below a listed root and the feature is on; throws otherwise. */
export function checkOutside(path: string): string {
  const s = outsideFolders();
  if (!s.enabled) throw err(403, 'Outside folders are off (Settings → Projects → Folders of other apps)');
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw err(404, `The folder ${path} is not there (is it mounted into the HiveMind container?)`);
  }
  for (const root of s.roots) {
    let r: string;
    try {
      r = realpathSync(root);
    } catch {
      continue;
    }
    if (real === r || real.startsWith(r + sep)) return real;
  }
  throw err(403, `${path} is not inside an allowed folder (${s.roots.join(', ') || 'none'})`);
}

/** The folders one level below each root (the other app's projects), for the "Open as project" list. */
export function listOutside(): { root: string; mounted: boolean; folders: { name: string; path: string; git: boolean }[] }[] {
  return outsideFolders().roots.map((root) => {
    const mounted = existsSync(root);
    let folders: { name: string; path: string; git: boolean }[] = [];
    if (mounted) {
      try {
        folders = readdirSync(root)
          .filter((n) => !n.startsWith('.'))
          .map((n) => ({ name: n, path: join(root, n) }))
          .filter((f) => {
            try {
              return statSync(f.path).isDirectory();
            } catch {
              return false;
            }
          })
          .map((f) => ({ ...f, git: existsSync(join(f.path, '.git')) }))
          .slice(0, 500);
      } catch {}
    }
    return { root, mounted, folders };
  });
}
