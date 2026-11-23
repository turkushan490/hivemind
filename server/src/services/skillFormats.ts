import { extname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readZip } from './zip.js';

/**
 * Reads skills in any format and turns each into a folder with a proper SKILL.md (name + description, then the
 * instructions). Understands:
 * - Claude, Codex (ChatGPT), OpenCode / T3 Code skills: SKILL.md with frontmatter, also when fields are missing,
 *   the name has odd characters or the description wraps over lines; Codex's agents/openai.yaml fills gaps;
 * - Claude agents and commands, Cursor rules (.mdc, .cursorrules), Windsurf/Cline rules, Copilot
 *   (*.instructions.md, *.prompt.md, *.agent.md, *.chatmode.md), AGENTS.md / CLAUDE.md / GEMINI.md, Fabric
 *   patterns (system.md), plain markdown or text;
 * - JSON (a ChatGPT GPT or OpenAI assistant export, any {name, description, instructions|prompt}), YAML and TOML
 *   (Gemini CLI commands: description + prompt);
 * - packed as .zip, .skill, .tar, .tar.gz / .tgz or .gz, with one skill or many (each SKILL.md folder, or a folder
 *   of single-file rules/agents/commands, becomes its own skill).
 * Nothing is ever run: everything stays text.
 */

export interface SkillFile {
  path: string;
  data: Buffer;
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const MAX_UNPACKED = 60 * 1024 * 1024;
/** At most this many skills from one upload or repo. */
export const MAX_SKILLS_PER_IMPORT = 100;

// ---------------------------------------------------------------- archives

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const isTar = (b: Buffer) => b.length >= 512 && b.subarray(257, 262).toString('latin1') === 'ustar';

/** A plain (ustar / GNU / pax) tar archive. */
export function readTar(buf: Buffer): SkillFile[] {
  const out: SkillFile[] = [];
  let p = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  let total = 0;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const str = (at: number, len: number) => h.subarray(at, at + len).toString('utf8').replace(/\0[\s\S]*$/, '');
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix && str(257, 5) === 'ustar') name = `${prefix}/${name}`;
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156]);
    const start = p + 512;
    if (start + size > buf.length) throw err(400, 'Damaged tar file');
    const data = buf.subarray(start, start + size);
    p = start + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      for (const line of data.toString('utf8').split('\n')) {
        const m = line.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === 'g') continue;
    if (type === '0' || type === '\0' || type === '7') {
      total += size;
      if (total > MAX_UNPACKED) throw err(413, 'The archive unpacks to more than allowed');
      out.push({ path: paxPath ?? longName ?? name, data: Buffer.from(data) });
    }
    longName = paxPath = undefined;
  }
  return out;
}

/** Whatever was uploaded (an archive, or one file named `filename`) as a list of files. */
export function unpack(buf: Buffer, filename = ''): SkillFile[] {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  if (isZip(buf)) return readZip(buf, { file: 8 * 1024 * 1024, total: MAX_UNPACKED }).map((e) => ({ path: e.name, data: e.data as Buffer }));
  if (isTar(buf)) return readTar(buf);
  if (isGzip(buf)) {
    let raw: Buffer;
    try {
      raw = gunzipSync(buf, { maxOutputLength: MAX_UNPACKED });
    } catch {
      throw err(400, 'Damaged or too big .gz file');
    }
    if (isTar(raw)) return readTar(raw);
    return unpack(raw, base.replace(/\.t?gz$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : '')));
  }
  return [{ path: base || 'SKILL.md', data: buf }];
}

// ---------------------------------------------------------------- text checks

/** Never kept in a skill (binary). Everything else is kept when it is valid UTF-8 text without NUL bytes. */
const BINARY_EXT = new Set(
  '.png .jpg .jpeg .gif .webp .bmp .ico .icns .tif .tiff .psd .mp3 .mp4 .m4a .wav .ogg .flac .mov .avi .mkv .webm .pdf .zip .gz .tgz .tar .7z .rar .exe .dll .so .dylib .bin .class .jar .pyc .wasm .woff .woff2 .ttf .otf .eot .sqlite .db .skill .docx .xlsx .pptx .onnx .safetensors .gguf .pt .ckpt'.split(
    ' ',
  ),
);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export const binaryPath = (p: string) => BINARY_EXT.has(extname(p).toLowerCase());

export function isTextFile(f: SkillFile): boolean {
  if (binaryPath(f.path) || f.data.includes(0)) return false;
  try {
    utf8.decode(f.data);
    return true;
  } catch {
    return false;
  }
}

/** Junk from zip tools, git and package managers. */
const JUNK = /(^|\/)(__MACOSX|\.git|node_modules|\.venv|__pycache__)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

// ---------------------------------------------------------------- frontmatter, YAML, TOML

/** A small YAML subset: top-level keys, quoted/plain/folded/block scalars, nested maps and lists. */
export function parseYaml(text: string): Record<string, unknown> {
  const lines = text.replace(/\t/g, '  ').split('\n');
  const indent = (l: string) => l.match(/^ */)![0].length;
  const scalar = (v: string): unknown => {
    const s = v.trim();
    if (!s) return '';
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s.replace(/\s+#[^"]*$/, ''));
      } catch {
        return s.replace(/^"|"$/g, '');
      }
    }
    if (s.startsWith("'")) return s.replace(/^'|'$/g, '').replace(/''/g, "'");
    if (s.startsWith('[') && s.endsWith(']'))
      return s
        .slice(1, -1)
        .split(',')
        .map((x) => scalar(x))
        .filter((x) => x !== '');
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
    return s.replace(/\s+#.*$/, '');
  };
  const block = (start: number, min: number): [Record<string, unknown> | unknown[], number] => {
    let i = start;
    const obj: Record<string, unknown> = {};
    const list: unknown[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) {
        i++;
        continue;
      }
      const ind = indent(line);
      if (ind < min) break;
      const item = line.match(/^\s*-\s+(.*)$/) ?? line.match(/^\s*-$/);
      if (item) {
        list.push(scalar(item[1] ?? ''));
        i++;
        continue;
      }
      const kv = line.match(/^\s*([^\s:#][^:#]*?)\s*:(?:\s+(.*)|\s*)$/);
      if (!kv) {
        i++;
        continue;
      }
      const key = kv[1].trim().replace(/^['"]|['"]$/g, '');
      const raw = (kv[2] ?? '').trim();
      i++;
      if (/^[|>][+-]?\d*$/.test(raw)) {
        const out: string[] = [];
        let blockInd = -1;
        while (i < lines.length && (!lines[i].trim() || indent(lines[i]) > ind)) {
          if (lines[i].trim() && blockInd < 0) blockInd = indent(lines[i]);
          out.push(lines[i].slice(Math.max(0, blockInd)));
          i++;
        }
        const joined = raw.startsWith('|') ? out.join('\n') : out.map((l) => l.trim()).join(' ').replace(/ {2,}/g, ' ');
        obj[key] = raw.includes('-') ? joined.replace(/\s+$/, '') : joined.replace(/\n*$/, raw.startsWith('|') ? '\n' : '').trim();
      } else if (!raw) {
        const [child, next] = block(i, ind + 1);
        obj[key] = Array.isArray(child) ? child : Object.keys(child).length ? child : '';
        i = next;
      } else {
        // A plain or quoted scalar may go on over more indented lines (a long description).
        let value = raw;
        while (i < lines.length && lines[i].trim() && indent(lines[i]) > ind && !/^\s*-\s/.test(lines[i]) && !(value.startsWith('"') && /[^\\]"\s*$/.test(value) && value.length > 1)) {
          value += ` ${lines[i].trim()}`;
          i++;
        }
        obj[key] = scalar(value);
      }
    }
    return [list.length && !Object.keys(obj).length ? list : obj, i];
  };
  const [top] = block(0, 0);
  return Array.isArray(top) ? {} : top;
}

/** A small TOML subset: key = "string" | '''multi''' | """multi""" | number | bool, [tables] flattened. */
export function parseToml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split('\n');
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.match(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/);
    if (t) {
      table = `${t[1]}.`;
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = table + kv[1].replace(/^"|"$/g, '');
    let v = kv[2].trim();
    const multi = v.match(/^("""|''')([\s\S]*)$/);
    if (multi) {
      const q = multi[1];
      let body = multi[2];
      while (!body.includes(q) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      out[key] = body.slice(0, body.indexOf(q)).replace(/^\n/, '');
      continue;
    }
    if (v.startsWith('"')) {
      try {
        out[key] = JSON.parse(v.replace(/\s+#.*$/, ''));
      } catch {
        out[key] = v.replace(/^"|"$/g, '');
      }
    } else if (v.startsWith("'")) out[key] = v.replace(/^'|'\s*(#.*)?$/g, '');
    else {
      v = v.replace(/\s+#.*$/, '');
      out[key] = v === 'true' ? true : v === 'false' ? false : v;
    }
  }
  return out;
}

export interface Frontmatter {
  fields: Record<string, unknown>;
  /** The frontmatter as written (YAML), to keep the fields HiveMind doesn't use. */
  raw: string;
  body: string;
}

/** "---" YAML or "+++" TOML frontmatter at the top (after blank lines or a BOM); none: all of it is the body. */
export function splitFrontmatter(text: string): Frontmatter {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const yaml = t.match(/^\s*---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)([\s\S]*)$/);
  if (yaml) return { fields: lowerKeys(parseYaml(yaml[1])), raw: yaml[1], body: yaml[2] };
  const toml = t.match(/^\s*\+\+\+[ \t]*\n([\s\S]*?)\n\+\+\+[ \t]*(?:\n|$)([\s\S]*)$/);
  if (toml) return { fields: lowerKeys(parseToml(toml[1])), raw: '', body: toml[2] };
  return { fields: {}, raw: '', body: t };
}

const lowerKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/-/g, '_'), v]));

// ---------------------------------------------------------------- picking name, description, body

const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : '').trim();

/** The first of these keys with text, also one level down (metadata.description, interface.short_description, …). */
function pick(o: Record<string, unknown>, keys: string[], depth = 3): string {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  if (depth > 0)
    for (const v of Object.values(o))
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const found = pick(lowerKeys(v as Record<string, unknown>), keys, depth - 1);
        if (found) return found;
      }
  return '';
}

const NAME_KEYS = ['name', 'title', 'display_name', 'displayname', 'slug', 'id'];
const DESC_KEYS = ['description', 'short_description', 'summary', 'when_to_use', 'whentouse', 'about', 'purpose', 'tagline'];
const BODY_KEYS = ['instructions', 'prompt', 'system_prompt', 'systemprompt', 'system', 'system_message', 'content', 'template', 'body', 'text', 'default_prompt'];

/** Turns anything into a valid skill name (letters, numbers, spaces, . - _; at most 64). */
export function cleanName(s: string): string {
  const n = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+|[ ._-]+$/g, '')
    .slice(0, 64)
    .replace(/[ ._-]+$/, '');
  return NAME_RE.test(n) ? n : '';
}

/** A file's name without its skill-ish extensions: "review.prompt.md" → "review". */
const stem = (path: string) =>
  (path.split('/').pop() ?? '')
    .replace(/^\./, '')
    .replace(/(\.(prompt|instructions|agent|chatmode|rules?|command))?\.(md|mdc|markdown|txt|json|ya?ml|toml|prompt)$/i, '');

const GENERIC_STEMS = /^(skill|agents?|claude|gemini|readme|system|prompt|instructions|index|main|rules|cursorrules|windsurfrules|clinerules|copilot-instructions|manifest|config|gpt|assistant)$/i;

/** A short description from the instructions: the first real sentence or line. */
function describe(body: string): string {
  for (const para of body.split(/\n\s*\n/)) {
    const p = para
      .split('\n')
      .filter((l) => !/^\s*(#|```|<!--|---|\||!\[)/.test(l))
      .join(' ')
      .replace(/[*_`>]+/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (p.length >= 8) {
      const sentence = p.match(/^.{8,300}?[.!?](\s|$)/)?.[0] ?? p;
      return sentence.trim().slice(0, 300);
    }
  }
  const h = body.match(/^\s*#+\s+(.+)$/m)?.[1];
  return h ? h.trim().slice(0, 300) : '';
}

const firstHeading = (body: string) => body.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1] ?? '';

export interface SkillMeta {
  name: string;
  description: string;
  body: string;
  /** Frontmatter fields HiveMind doesn't use, kept as written. */
  rawExtra: string;
}

const unXml = (s: string) =>
  s
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Strips the common indent of a block of lines (XML bodies are usually indented). */
const dedent = (s: string) => {
  const lines = s.replace(/^\n+|\s+$/g, '').split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n');
};

/** Skill fields from XML-style tags; undefined when none of the known tags (or attributes) are there. */
export function xmlFields(text: string): Record<string, unknown> | undefined {
  const keys = [...NAME_KEYS, ...DESC_KEYS, ...BODY_KEYS];
  const out: Record<string, unknown> = {};
  let rest = text;
  for (const k of keys) {
    const m = text.match(new RegExp(`<${k}(?:\\s[^>]*)?>([\\s\\S]*?)</${k}\\s*>`, 'i'));
    if (m && !(k in out)) {
      out[k] = dedent(unXml(m[1])).trim();
      rest = rest.replace(m[0], '');
    }
  }
  // Attributes on the outer tag: <skill name="…" description="…">.
  const root = text.match(/^<([A-Za-z][\w-]*)(\s[^>]*)>/);
  if (root?.[2])
    for (const a of root[2].matchAll(/([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const k = a[1].toLowerCase();
      if (keys.includes(k) && !out[k]) out[k] = unXml(a[3] ?? a[4] ?? '');
    }
  if (!Object.keys(out).length) return undefined;
  // What is left between the tags (without the outer wrapper) can be the instructions.
  out._rest = dedent(rest.replace(/^<[A-Za-z][\w-]*(\s[^>]*)?>|<\/[A-Za-z][\w-]*>\s*$/g, '').replace(/<\/?[A-Za-z][\w-]*(\s[^>]*)?\/?>/g, '')).trim();
  return out;
}

/** Name, description and instructions from one file's text (md/txt with or without frontmatter, JSON, YAML, TOML, XML tags). */
export function readSkillText(text: string, path: string, hints: { folder?: string; extra?: Record<string, unknown> } = {}): SkillMeta {
  const ext = extname(path).toLowerCase();
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let fields: Record<string, unknown> = {};
  let body = '';
  let raw = '';
  const trimmed = t.trim();
  if (ext === '.json' || (/^[{[]/.test(trimmed) && /[}\]]$/.test(trimmed))) {
    try {
      let j = JSON.parse(trimmed) as unknown;
      if (Array.isArray(j)) {
        // [{role:"system", content}] chat messages, or a list with one object.
        const sys = j.find((m) => m && typeof m === 'object' && (m as { role?: string }).role === 'system') as Record<string, unknown> | undefined;
        j = sys ?? j[0] ?? {};
      }
      fields = lowerKeys((j ?? {}) as Record<string, unknown>);
      body = pick(fields, BODY_KEYS);
    } catch {
      body = t;
    }
  } else if (ext === '.xml' || (/^</.test(trimmed) && xmlFields(trimmed))) {
    // <skill><name>…</name><description>…</description><instructions>…</instructions></skill> (or name="…" attributes).
    fields = xmlFields(trimmed) ?? {};
    body = pick(fields, BODY_KEYS, 0) || str(fields._rest);
  } else if (ext === '.yaml' || ext === '.yml') {
    fields = lowerKeys(parseYaml(t));
    body = pick(fields, BODY_KEYS);
  } else if (ext === '.toml') {
    fields = lowerKeys(parseToml(t));
    body = pick(fields, BODY_KEYS);
  } else {
    const fm = splitFrontmatter(t);
    fields = fm.fields;
    raw = fm.raw;
    body = fm.body;
    // Continue / Gemini style: the prompt may sit in the frontmatter.
    if (!body.trim()) body = pick(fields, BODY_KEYS, 0);
  }
  if (!body.trim() && !Object.keys(fields).length) body = t;
  body = body.trim();
  const extra = hints.extra ? lowerKeys(hints.extra) : {};
  const fileStem = stem(path);
  const name =
    cleanName(pick(fields, NAME_KEYS, 3)) ||
    cleanName(pick(extra, NAME_KEYS)) ||
    (hints.folder && cleanName(hints.folder)) ||
    (!GENERIC_STEMS.test(fileStem) && cleanName(fileStem)) ||
    cleanName(firstHeading(body)) ||
    cleanName(fileStem) ||
    'imported-skill';
  const description = (pick(fields, DESC_KEYS, 3) || pick(extra, DESC_KEYS) || describe(body) || `Instructions from ${path.split('/').pop()}`).replace(/\s+/g, ' ').slice(0, 1024);
  if (!body && !pick(fields, DESC_KEYS, 1)) throw err(400, `${path} has no instructions in it`);
  return { name, description, body, rawExtra: keepExtra(raw) };
}

/** The frontmatter minus name/description (they are written fresh), so allowed-tools, license, metadata… stay. */
function keepExtra(raw: string): string {
  if (!raw) return '';
  const out: string[] = [];
  let skip = false;
  for (const line of raw.split('\n')) {
    const top = line.match(/^([^\s#:][^:]*?)\s*:/);
    if (top) skip = /^(name|description)$/i.test(top[1].trim());
    if (!skip) out.push(line);
  }
  return out.join('\n').trim();
}

/** A SKILL.md HiveMind (and Claude, Codex, OpenCode) reads. */
export function toSkillMd(m: SkillMeta): string {
  return `---\nname: ${m.name}\ndescription: ${JSON.stringify(m.description)}\n${m.rawExtra ? `${m.rawExtra}\n` : ''}---\n\n${m.body}\n`;
}

// ---------------------------------------------------------------- finding the skills in a set of files

const MAIN_NAMES = [
  'skill.md',
  'skill.mdc',
  'skill.markdown',
  'skill.txt',
  'agents.md',
  'claude.md',
  'gemini.md',
  'system.md',
  'prompt.md',
  'instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  'copilot-instructions.md',
  'skill.json',
  'gpt.json',
  'assistant.json',
  'manifest.json',
  'skill.yaml',
  'skill.yml',
  'prompt.txt',
  'instructions.txt',
  'system.txt',
  'readme.md',
];
const SINGLE_RE = /\.(md|mdc|markdown|txt|prompt|json|ya?ml|toml|xml)$|^\.(cursor|windsurf|cline)rules$/i;
const base = (p: string) => (p.split('/').pop() ?? '').toLowerCase();
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/** Does this file stand on its own as a skill (frontmatter with a name or description, or JSON/TOML with a prompt)? */
function standalone(f: SkillFile): boolean {
  if (!SINGLE_RE.test(base(f.path))) return false;
  try {
    const text = f.data.toString('utf8');
    const ext = extname(f.path).toLowerCase();
    if (ext === '.json' || ext === '.toml' || ext === '.yaml' || ext === '.yml') {
      const o = ext === '.json' ? lowerKeys(JSON.parse(text)) : ext === '.toml' ? lowerKeys(parseToml(text)) : lowerKeys(parseYaml(text));
      return !!pick(o, BODY_KEYS, 2);
    }
    const x = /^\s*</.test(text) ? xmlFields(text.trim()) : undefined;
    if (x) return !!(pick(x, NAME_KEYS, 0) || pick(x, DESC_KEYS, 0)) && !!(pick(x, BODY_KEYS, 0) || str(x._rest));
    const fm = splitFrontmatter(text);
    return !!(pick(fm.fields, NAME_KEYS, 0) || pick(fm.fields, DESC_KEYS, 0)) && !!fm.body.trim();
  } catch {
    return false;
  }
}

export interface FoundSkill {
  /** SKILL.md first, then the other files of the skill (paths inside the skill folder). */
  files: SkillFile[];
}

/** One skill from the main file `main`, with every other file under `root`. */
function buildSkill(files: SkillFile[], root: string, main: SkillFile, hintName?: string): FoundSkill {
  const inRoot = files.filter((f) => f.path.startsWith(root) && f !== main);
  const folder = root.replace(/\/$/, '').split('/').pop() || hintName;
  // Codex keeps the display name and short description in agents/openai.yaml.
  const openai = inRoot.find((f) => f.path.slice(root.length).toLowerCase() === 'agents/openai.yaml');
  const extra = openai ? parseYaml(openai.data.toString('utf8')) : undefined;
  const meta = readSkillText(main.data.toString('utf8'), main.path, { folder, extra });
  return {
    files: [{ path: 'SKILL.md', data: Buffer.from(toSkillMd(meta)) }, ...inRoot.map((f) => ({ path: f.path.slice(root.length), data: f.data }))],
  };
}

/**
 * Every skill in these files. SKILL.md folders first (each its own skill); without one, a main file (AGENTS.md,
 * README.md, a GPT JSON, …) makes one skill of the folder; a folder of single-file rules/agents/commands gives one
 * skill per file; otherwise the biggest text file is the instructions.
 */
export function findSkills(input: SkillFile[], opts: { under?: string; hintName?: string } = {}): FoundSkill[] {
  const prefix = opts.under ? `${opts.under.replace(/^\/+|\/+$/g, '')}/` : '';
  const files = input
    .map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\.?\/+/, ''), data: f.data }))
    .filter((f) => f.path && !f.path.endsWith('/') && !JUNK.test(f.path) && f.path.startsWith(prefix));
  if (!files.length) throw err(400, prefix ? `Nothing found in ${opts.under}` : 'The upload is empty');
  const text = files.filter(isTextFile);

  // 1. SKILL.md folders (any case), without the ones inside another skill.
  const skillMds = text.filter((f) => /^skill\.(md|mdc|markdown)$/i.test(base(f.path))).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const roots: { root: string; main: SkillFile }[] = [];
  for (const md of skillMds) {
    const root = dirOf(md.path);
    if (!roots.some((r) => root.startsWith(r.root))) roots.push({ root, main: md });
  }
  if (roots.length) {
    if (roots.length > MAX_SKILLS_PER_IMPORT) throw err(413, `That holds ${roots.length} skills; at most ${MAX_SKILLS_PER_IMPORT} at once (pick a folder)`);
    return roots.map((r) => buildSkill(files, r.root, r.main, opts.hintName));
  }

  // 2. A known main file, the shallowest one.
  const rank = (f: SkillFile) => {
    const i = MAIN_NAMES.indexOf(base(f.path));
    return i < 0 ? Infinity : f.path.split('/').length * 100 + i;
  };
  const known = text.filter((f) => rank(f) < Infinity).sort((a, b) => rank(a) - rank(b));
  // README.md next to several stand-alone rule files is the collection's readme, not the skill.
  const singles = text.filter((f) => standalone(f) && !/^(readme\.md|manifest\.json)$/i.test(base(f.path)));
  const mainKnown = known.find((f) => !/^readme\.md$/i.test(base(f.path))) ?? (singles.length > 1 ? undefined : known[0]);
  if (mainKnown) {
    const root = dirOf(mainKnown.path);
    return [buildSkill(files, files.every((f) => f.path.startsWith(root)) ? root : commonRoot(files), mainKnown, opts.hintName)];
  }

  // 3. Several stand-alone files (Claude agents/commands, Cursor rules, Copilot prompts, Gemini commands…).
  if (singles.length > 1) {
    if (singles.length > MAX_SKILLS_PER_IMPORT) throw err(413, `That holds ${singles.length} skills; at most ${MAX_SKILLS_PER_IMPORT} at once`);
    return singles.map((f) => {
      const meta = readSkillText(f.data.toString('utf8'), f.path);
      return { files: [{ path: 'SKILL.md', data: Buffer.from(toSkillMd(meta)) }] };
    });
  }

  // 4. One stand-alone file, or else the biggest text file that looks like instructions.
  const candidates = singles.length ? singles : text.filter((f) => SINGLE_RE.test(base(f.path))).sort((a, b) => b.data.length - a.data.length);
  const main = candidates[0] ?? text.sort((a, b) => b.data.length - a.data.length)[0];
  if (!main) throw err(400, 'No text file found to read a skill from (images and programs are never used)');
  return [buildSkill(files, commonRoot(files), main, opts.hintName)];
}

/** The folder every file is in ("" when they differ at the top). */
function commonRoot(files: SkillFile[]): string {
  let root = dirOf(files[0].path);
  while (root && !files.every((f) => f.path.startsWith(root))) root = dirOf(root.replace(/\/$/, ''));
  return root;
}
