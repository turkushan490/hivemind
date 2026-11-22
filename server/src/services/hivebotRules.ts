// H31: HiveBot's rules as MD files in the owner's memory (hivebot/rules/names.md and listening.md): who answers to
// which (misheard) name, how it listens, the noise and TV filters. Read into JSON for the robot and the browser page;
// a broken file never breaks HiveBot (the last version that read fine is kept, and Problems says which line).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from '../db/index.js';
import { logError } from '../errors.js';
import * as mem from './memoryFiles.js';

export const CHARACTERS = ['jev', 'jarvis', 'ultron', 'vision', 'ghost', 'friday'];
export const NAMES_PATH = 'hivebot/rules/names.md';
export const LISTENING_PATH = 'hivebot/rules/listening.md';

export interface HiveBotRules {
  version: string;
  /** What speech-to-text heard → the character. */
  names: Record<string, string>;
  /** "ultr*, altr* (5-9 letters) → ultron". */
  prefixes: { starts: string[]; min: number; max: number; character: string }[];
  /** "default character: vision" → { defaultCharacter: "vision" }, numbers as numbers. */
  settings: Record<string, string | number>;
  noise: string[];
  oneWord: string[];
  additions: { starts: string[]; shortStarts: string[] };
  kinds: Record<string, string[]>;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The first versions, shipped with HiveMind (from the HiveBot repo's memory-seed). */
function seed(file: string): string | undefined {
  for (const dir of [join(here, '../../hivebot/rules'), join(here, '../hivebot/rules'), join(process.cwd(), 'server/hivebot/rules')]) {
    const p = join(dir, file);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return undefined;
}

/** "follow-up seconds" → "followUpSeconds". */
const camel = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');

/** Bullet lines ("- text") of a block of markdown. */
const bullets = (block: string) =>
  block
    .split('\n')
    .map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);

/** Splits markdown into its "## heading" sections (heading lower case → text). */
function sections(md: string, level = 2): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`^${'#'.repeat(level)}\\s+(.+)$`, 'gm');
  const heads = [...md.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    out.set(h[1].trim().toLowerCase(), md.slice(h.index! + h[0].length, end));
  });
  return out;
}

/** Reads the two files; every line that doesn't fit becomes a problem ("names.md line 14: no →"). */
export function parseRules(namesMd: string, listeningMd: string): { rules: Omit<HiveBotRules, 'version'>; problems: string[] } {
  const problems: string[] = [];
  const names: Record<string, string> = {};
  const prefixes: HiveBotRules['prefixes'] = [];
  let inStarts = false;
  namesMd.split('\n').forEach((line, i) => {
    const head = /^##\s+(.+)$/.exec(line);
    if (head) {
      inStarts = /word starts/i.test(head[1]);
      return;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line)?.[1];
    if (!item) return;
    const parts = item.split(/\s*(?:→|->)\s*/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return void problems.push(`names.md line ${i + 1}: no → in "${item.slice(0, 60)}"`);
    const character = parts[1].trim().toLowerCase();
    if (!CHARACTERS.includes(character)) return void problems.push(`names.md line ${i + 1}: unknown character "${character}"`);
    if (inStarts) {
      const m = /^(.*?)\s*\((\d+)\s*-\s*(\d+)[^)]*\)\s*$/.exec(parts[0]);
      const starts = (m ? m[1] : parts[0]).split(',').map((s) => s.trim().toLowerCase().replace(/\*$/, '')).filter(Boolean);
      if (!starts.length) return void problems.push(`names.md line ${i + 1}: no word start`);
      prefixes.push({ starts, min: m ? Number(m[2]) : 4, max: m ? Number(m[3]) : 12, character });
    } else {
      names[parts[0].trim().toLowerCase()] = character;
    }
  });
  if (!Object.keys(names).length) problems.push('names.md: no names at all');

  const sec = sections(listeningMd);
  const settings: Record<string, string | number> = {};
  for (const b of bullets(sec.get('settings') ?? '')) {
    const m = /^([^:]+):\s*([^\s(]+)/.exec(b);
    if (!m) {
      problems.push(`listening.md settings: "${b.slice(0, 60)}" is not "name: value"`);
      continue;
    }
    const v = m[2].trim();
    settings[camel(m[1])] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.toLowerCase();
  }
  if (settings.defaultCharacter && !CHARACTERS.includes(String(settings.defaultCharacter))) problems.push(`listening.md: unknown default character "${settings.defaultCharacter}"`);
  const additionsText = sec.get('additions') ?? '';
  const [first, rest] = additionsText.split(/\n\s*short add-ons[^\n]*\n/i);
  const kindsText = sec.get('kind of question') ?? '';
  const kinds: Record<string, string[]> = {};
  for (const [k, v] of sections(kindsText, 3)) kinds[k.split(/\s/)[0]] = bullets(v).map((x) => x.toLowerCase());
  return {
    rules: {
      names,
      prefixes,
      settings,
      noise: bullets(sec.get('noise') ?? '').map((x) => x.toLowerCase()),
      oneWord: bullets(sec.get('one word that counts') ?? '').map((x) => x.toLowerCase()),
      additions: { starts: bullets(first ?? '').map((x) => x.toLowerCase()), shortStarts: bullets(rest ?? '').map((x) => x.toLowerCase()) },
      kinds,
    },
    problems,
  };
}

/** The files from the owner's memory (written from the shipped first version when they aren't there yet). */
function files(ownerId: string): { names: string; listening: string } {
  const out = { names: '', listening: '' };
  for (const [key, path, file] of [['names', NAMES_PATH, 'names.md'], ['listening', LISTENING_PATH, 'listening.md']] as const) {
    let text = mem.read(ownerId, [path])[0]?.content;
    if (text === undefined) {
      text = seed(file) ?? '';
      if (text) {
        try {
          mem.write(ownerId, path, text, { by: 'hivemind (first version)' });
        } catch {}
      }
    }
    out[key] = text;
  }
  return out;
}

/**
 * The owner's rules as JSON. When a file has problems, the last version that read fine is used (and Problems gets
 * one line per new problem); without such a version, whatever could be read.
 */
export function rulesFor(ownerId: string): HiveBotRules & { problems: string[] } {
  const f = files(ownerId);
  const hash = createHash('sha256').update(f.names).update('\0').update(f.listening).digest('hex').slice(0, 12);
  const { rules, problems } = parseRules(f.names, f.listening);
  const key = `hivebot.rules.${ownerId}`;
  if (problems.length) {
    const seen = getSetting(`${key}.problems`);
    const now = problems.join('\n');
    if (seen !== now) {
      setSetting(`${key}.problems`, now);
      for (const p of problems.slice(0, 10)) logError({ source: 'server', message: `HiveBot rules: ${p}`, detail: 'The last version that read fine is used until this is fixed (Memory → hivebot/rules).' });
    }
    const good = getSetting(`${key}.good`);
    if (good) return { ...(JSON.parse(good) as HiveBotRules), problems };
    return { version: hash, ...rules, problems };
  }
  const full: HiveBotRules = { version: hash, ...rules };
  if (getSetting(`${key}.hash`) !== hash) {
    setSetting(`${key}.hash`, hash);
    setSetting(`${key}.good`, JSON.stringify(full));
    setSetting(`${key}.problems`, '');
  }
  return { ...full, problems: [] };
}
