import type { HfImportJob, HfImportMap, HfImportPreset, HfImportPreview } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { readCapped, timeoutSignal } from '../services/net.js';
import { addItems, DM_DATASET, getDataset, parseCsv, type NewItem } from './datasets.js';
import { token } from './hf.js';

/**
 * Import a public Hugging Face dataset into a text / chat dataset. Two routes:
 * A. Hugging Face's rows API (datasets-server), which reads most datasets, Parquet included, 100 rows a page;
 * B. the repo's own JSONL / JSON / CSV files, for datasets the rows API can't read (FIREBALL is script-based).
 * Columns go into input / output / system by a map, or by a preset (FIREBALL, chat conversations).
 * Where an import got to is kept per repo in datasets.sources, so importing again continues after it.
 * Jobs live in memory: after a restart nothing resumes by itself; pressing Import again continues.
 * Only huggingface.co and datasets-server.huggingface.co are called.
 */

const HUB = 'https://huggingface.co';
const ROWS_API = 'https://datasets-server.huggingface.co';
/** The rows API answers 422 for more. */
const PAGE = 100;

export const FIREBALL = 'lara-martin/FIREBALL';
export const FIREBALL_PAPER = 'https://arxiv.org/abs/2305.01528';
/** Tests lower these. cap: examples per dataset, whatever their source; batch: examples per write; fileBytes: per downloaded file. */
export const limits = { cap: 1_000_000, batch: 1000, fileBytes: 500 * 1024 * 1024 };
export const DEFAULT_LIMIT = 5000;

export const GATED = 'This dataset needs a Hugging Face token. Add one in Settings → Hugging Face.';
const GATED_WITH_TOKEN = "This dataset is gated and the Hugging Face token can't read it: accept its terms on huggingface.co with the token's account.";

/** Discord ids in FIREBALL: never stored, never shown. */
const PRIVATE_KEYS = new Set(['speaker_id', 'controller_id']);

const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export const isFireball = (repo: string) => repo.toLowerCase() === FIREBALL.toLowerCase();

/** owner/name from a link (https://huggingface.co/datasets/owner/name, also with /tree/main… behind it) or owner/name. */
export function parseRepo(input: unknown): string {
  const raw = String(input ?? '').trim();
  const link = raw.match(/^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/datasets\/([^/?#]+)\/([^/?#]+)/i);
  const repo = link ? `${link[1]}/${link[2]}` : raw.replace(/\/+$/, '');
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo) || repo.split('/').some((p) => p === '.' || p === '..'))
    throw bad(`"${raw.slice(0, 120)}" is not a Hugging Face dataset: paste its link or owner/name`);
  return repo;
}

// ---- Fetching ----

type HfError = Error & { status?: number };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
let wait = sleep;
/** Tests skip the waits between retries. */
export const setRetryWait = (f?: typeof sleep) => (wait = f ?? sleep);

/** Retry-After in milliseconds (seconds or a date), at most two minutes. */
function retryAfter(res: Response | undefined): number | undefined {
  const h = res?.headers.get('retry-after');
  if (!h) return;
  const ms = /^\d+(\.\d+)?$/.test(h.trim()) ? Number(h) * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) ? Math.min(120_000, Math.max(0, ms)) : undefined;
}

/** GET with the stored token (when there is one); 429 and 5xx are tried three more times, with a wait. */
async function hfGet(url: string, signal?: AbortSignal, ms = 60_000): Promise<Response> {
  const tok = token();
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let cause: unknown;
    try {
      res = await fetch(url, { headers: tok ? { authorization: `Bearer ${tok}` } : {}, signal: timeoutSignal(ms, signal) });
    } catch (err) {
      if (signal?.aborted) throw err;
      cause = err;
    }
    if (res?.ok) return res;
    if (res && (res.status === 401 || res.status === 403)) throw Object.assign(new Error(tok ? GATED_WITH_TOKEN : GATED), { status: res.status, statusCode: 400 });
    // 501 is the rows API saying it can't read this dataset: that doesn't get better by waiting.
    const again = !res || res.status === 429 || (res.status >= 500 && res.status !== 501);
    if (!again || attempt >= 3) {
      if (!res) throw new Error(`can't reach Hugging Face (${(cause as Error)?.message ?? 'no answer'})`);
      const body = await res.text().catch(() => '');
      let detail = body.slice(0, 200);
      try {
        detail = String(JSON.parse(body).error ?? detail).slice(0, 200);
      } catch {}
      throw Object.assign(new Error(`Hugging Face answered ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status }) as HfError;
    }
    await res?.body?.cancel().catch(() => {});
    await wait(retryAfter(res) ?? 1000 * 2 ** attempt, signal);
  }
}

interface RepoInfo {
  repo: string;
  license: string | null;
  gated: boolean;
  files: string[];
}

/** The Hub's page of the dataset: its exact name, license, gated, and its files. Used on both routes. */
async function repoInfo(repo: string, signal?: AbortSignal): Promise<RepoInfo> {
  let data: { id?: string; gated?: unknown; cardData?: { license?: unknown }; tags?: string[]; siblings?: { rfilename: string }[] };
  try {
    data = (await (await hfGet(`${HUB}/api/datasets/${repo}`, signal)).json()) as typeof data;
  } catch (err) {
    const status = (err as HfError).status;
    if (status === 404 || (status === 401 && !token()))
      throw bad(`Hugging Face has no dataset "${repo}" (or it is private: that needs a token in Settings → Hugging Face)`);
    throw bad(`Can't read "${repo}" on Hugging Face: ${(err as Error).message}`);
  }
  const lic = data.cardData?.license ?? data.tags?.find((t) => t.startsWith('license:'))?.slice(8);
  const license = (Array.isArray(lic) ? lic.join(', ') : typeof lic === 'string' ? lic : '').trim() || null;
  const id = typeof data.id === 'string' && data.id.toLowerCase() === repo.toLowerCase() ? data.id : repo;
  return { repo: id, license, gated: data.gated === 'auto' || data.gated === 'manual' || data.gated === true, files: (data.siblings ?? []).map((s) => s.rfilename) };
}

/** Route A's split: train of the first config, or its first split. Undefined (go to route B) on any error. */
async function rowsSplit(repo: string, signal?: AbortSignal): Promise<{ config: string; split: string } | undefined> {
  try {
    const data = (await (await hfGet(`${ROWS_API}/splits?dataset=${encodeURIComponent(repo)}`, signal)).json()) as { splits?: { config: string; split: string }[] };
    const splits = data.splits ?? [];
    if (!splits.length) return;
    const config = splits[0].config;
    const mine = splits.filter((s) => s.config === config);
    return { config, split: (mine.find((s) => s.split === 'train') ?? mine[0]).split };
  } catch (err) {
    if (signal?.aborted) throw err;
    return;
  }
}

interface RowsPage {
  features?: { name: string }[];
  rows?: { row_idx: number; row: Record<string, unknown>; truncated_cells?: string[] }[];
  num_rows_total?: number;
}

const rowsPage = async (repo: string, at: { config: string; split: string }, offset: number, length: number, signal?: AbortSignal): Promise<RowsPage> =>
  (
    await hfGet(
      `${ROWS_API}/rows?dataset=${encodeURIComponent(repo)}&config=${encodeURIComponent(at.config)}&split=${encodeURIComponent(at.split)}&offset=${offset}&length=${Math.max(1, Math.min(PAGE, length))}`,
      signal,
    )
  ).json() as Promise<RowsPage>;

/** Route B: the files the import can read, by name. */
export const dataFiles = (files: string[]) => files.filter((f) => /\.(jsonl|json|csv)$/i.test(f)).sort();
const fileUrl = (repo: string, file: string) => `${HUB}/datasets/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`;

/** The start of a file, for the preview: at most maxBytes, cut at the last full line. */
async function readHead(res: Response, maxBytes: number): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  let whole = true;
  for await (const chunk of (res.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    parts.push(Buffer.from(chunk));
    size += chunk.length;
    if (size >= maxBytes) {
      whole = false;
      break;
    }
  }
  const text = Buffer.concat(parts).toString('utf8');
  return whole ? text : text.slice(0, text.lastIndexOf('\n') + 1);
}

/** The rows of a JSONL, JSON or CSV file, with their line (or row) number; row is undefined for a line that can't be read. */
export function* fileRows(file: string, text: string): Generator<{ line: number; row?: Record<string, unknown> }> {
  const t = text.replace(/^﻿/, '');
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (/\.csv$/i.test(file)) {
    const rows = parseCsv(t);
    const head = (rows[0] ?? []).map((h) => h.trim());
    for (let i = 1; i < rows.length; i++) yield { line: i, row: Object.fromEntries(head.map((h, j) => [h, rows[i][j] ?? ''])) };
    return;
  }
  if (/\.json$/i.test(file)) {
    let whole: unknown;
    try {
      whole = JSON.parse(t);
    } catch {
      whole = undefined; // Often JSON Lines with a .json name.
    }
    if (whole !== undefined) {
      const list = Array.isArray(whole) ? whole : isObj(whole) ? (Object.values(whole).find((v) => Array.isArray(v) && v.some(isObj)) as unknown[] | undefined) ?? [whole] : [];
      for (let i = 0; i < list.length; i++) yield { line: i + 1, row: isObj(list[i]) ? list[i] : undefined };
      return;
    }
  }
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      row = undefined;
    }
    yield { line: i + 1, row: isObj(row) ? row : undefined };
  }
}

// ---- Rows into examples ----

/** Without the Discord ids, at any depth. */
export function stripIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripIds);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !PRIVATE_KEYS.has(k)).map(([k, x]) => [k, stripIds(x)]));
  return v;
}

const isPrim = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Text as it is, lists one item per line, objects as "key: value" lines. */
export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toText).filter((s) => s.trim()).join('\n');
  if (typeof v === 'object')
    return Object.entries(v)
      .filter(([, x]) => x !== null && x !== undefined && x !== '')
      .map(([k, x]) => `${k}: ${isPrim(x) ? String(x) : Array.isArray(x) && x.every(isPrim) ? x.join(', ') : JSON.stringify(x)}`)
      .join('\n');
  return String(v);
}

type Convert = (row: Record<string, unknown>) => NewItem | undefined;

const blocks = (parts: [string, string][]) =>
  parts
    .filter(([, body]) => body.trim())
    .map(([head, body]) => head + body.trim())
    .join('\n\n');

/** One actor of FIREBALL's combat: name, hp, class, race, effects (what is empty or null is left out). */
function actorLine(a: unknown): string {
  if (!a || typeof a !== 'object') return toText(a).trim();
  const o = a as Record<string, unknown>;
  const effects = Array.isArray(o.effects)
    ? o.effects
        .map((e) => (e && typeof e === 'object' ? toText((e as Record<string, unknown>).name ?? e) : toText(e)))
        .filter((s) => s.trim())
        .join(', ')
    : toText(o.effects);
  return [o.name, o.hp, o.class, o.race, effects]
    .map((x) => (typeof x === 'string' ? x : toText(x)).trim())
    .filter(Boolean)
    .join(', ');
}

/** FIREBALL: one Discord D&D turn. Only these fields are read; speaker_id and controller_id never are. */
export function fireballItem(r: Record<string, unknown>): NewItem {
  const combat = Array.isArray(r.combat_state_before) ? r.combat_state_before.map(actorLine).filter(Boolean).join('\n') : '';
  const current = r.current_actor && typeof r.current_actor === 'object' ? toText((r.current_actor as Record<string, unknown>).name) : '';
  return {
    input: blocks([
      ['Combat:\n', combat],
      ['Current turn: ', current],
      ['Chat so far:\n', toText(r.utterance_history)],
      ['', toText(r.before_utterances)],
    ]),
    output: blocks([
      ['Commands:\n', toText(r.commands_norm)],
      ['Results:\n', toText(r.automation_results)],
      ['', toText(r.after_utterances)],
    ]),
  };
}

const CHAT_COLUMNS = ['messages', 'conversations'];
const isChat = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((m) => m && typeof m === 'object' && (('role' in m && 'content' in m) || ('from' in m && 'value' in m)));
const isChatRow = (row: Record<string, unknown>) => CHAT_COLUMNS.some((c) => isChat(row[c]));

/** A message's text; content may be a list of parts ([{type: "text", text}]). */
const messageText = (c: unknown) =>
  Array.isArray(c) && c.every((p) => p && typeof p === 'object' && 'text' in p) ? c.map((p) => toText((p as { text: unknown }).text)).join('\n') : toText(c);

/** A conversation: system → System, the last assistant answer → Output, everything before it → Input. */
export function chatItem(row: Record<string, unknown>): NewItem | undefined {
  const col = CHAT_COLUMNS.find((c) => isChat(row[c]));
  if (!col) return;
  const msgs = (row[col] as Record<string, unknown>[]).map((m) => ({ role: String(m.role ?? m.from ?? '').trim(), text: messageText(m.content ?? m.value).trim() }));
  const system = msgs
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
    .filter(Boolean)
    .join('\n\n');
  const rest = msgs.filter((m) => m.role !== 'system');
  const last = rest.findLastIndex((m) => m.role === 'assistant' || m.role === 'gpt');
  if (last < 0) return;
  return {
    input: rest
      .slice(0, last)
      .map((m) => `${m.role}: ${m.text}`)
      .join('\n\n'),
    output: rest[last].text,
    ...(system && { system }),
  };
}

function converter(repo: string, preset: HfImportPreset | undefined, map: HfImportMap | undefined): Convert {
  if (preset === 'fireball') return fireballItem;
  if (preset === 'chat') return chatItem;
  const field = (row: Record<string, unknown>, cols: string[] = []) =>
    cols
      .map((c) => toText(row[c]).trim())
      .filter(Boolean)
      .join('\n\n');
  const fireball = isFireball(repo);
  return (raw) => {
    const row = fireball ? (stripIds(raw) as Record<string, unknown>) : raw;
    const system = field(row, map!.system);
    return { input: field(row, map!.input), output: field(row, map!.output), ...(system && { system }) };
  };
}

// ---- Where an import got to (datasets.sources) ----

type Position = { config: string; split: string; offset: number } | { file: string; line: number; done?: boolean };

export interface ImportSource {
  repo: string;
  license: string | null;
  url: string;
  position?: Position;
}

export function datasetSources(datasetId: string): ImportSource[] {
  const r = db.prepare('SELECT sources FROM datasets WHERE id = ?').get(datasetId) as { sources: string | null } | undefined;
  try {
    return JSON.parse(r?.sources ?? '[]') as ImportSource[];
  } catch {
    return [];
  }
}

function saveSource(datasetId: string, src: ImportSource) {
  const list = datasetSources(datasetId).filter((s) => s.repo.toLowerCase() !== src.repo.toLowerCase());
  db.prepare('UPDATE datasets SET sources = ? WHERE id = ?').run(JSON.stringify([...list, src]), datasetId);
}

/** Examples from this repo in the dataset (their ref starts with "hf:<repo>:"). */
export function importedCount(datasetId: string, repo: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM dataset_items WHERE dataset_id = ? AND ref >= ? AND ref < ?').get(datasetId, `hf:${repo}:`, `hf:${repo};`) as { n: number }).n;
}

const allItems = (datasetId: string) => (db.prepare('SELECT COUNT(*) AS n FROM dataset_items WHERE dataset_id = ?').get(datasetId) as { n: number }).n;

/** "Imported from Hugging Face: owner/name (license)", once, after what the description already says. */
function credit(datasetId: string, repo: string, license: string | null) {
  const r = db.prepare('SELECT description FROM datasets WHERE id = ?').get(datasetId) as { description: string | null };
  const line = `Imported from Hugging Face: ${repo} (${license ?? 'no license listed'})`;
  if (r.description?.includes(`Imported from Hugging Face: ${repo} (`)) return;
  db.prepare('UPDATE datasets SET description = ? WHERE id = ?').run(r.description?.trim() ? `${r.description.trim()}\n${line}` : line, datasetId);
}

// ---- Preview, start, stop ----

function textDataset(ownerId: string, id: string) {
  const ds = getDataset(ownerId, id);
  if (!ds) throw bad('Dataset not found', 404);
  if (ds.kind !== 'text') throw bad('Hugging Face imports go into a text / chat dataset');
  return ds;
}

/** Long values cut for the preview. */
const clip = (v: unknown): unknown =>
  typeof v === 'string' ? (v.length > 1500 ? `${v.slice(0, 1500)}…` : v) : Array.isArray(v) ? v.slice(0, 50).map(clip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)])) : v;

export async function previewImport(ownerId: string, datasetId: string, body: { repo?: unknown }): Promise<HfImportPreview> {
  const ds = textDataset(ownerId, datasetId);
  const info = await repoInfo(parseRepo(body.repo));
  const base = {
    repo: info.repo,
    license: info.license,
    gated: info.gated,
    imported: importedCount(ds.id, info.repo),
    running: [...jobs.values()].find((j) => j.datasetId === ds.id && j.state === 'running')?.id ?? null,
  };
  const presetFor = (rows: Record<string, unknown>[]): HfImportPreset | null => (isFireball(info.repo) ? 'fireball' : rows.some(isChatRow) ? 'chat' : null);
  if (info.gated && !token()) return { ...base, needsToken: true, route: null, files: null, rows: null, columns: [], sample: [], preset: presetFor([]) };

  const split = await rowsSplit(info.repo);
  if (split) {
    const page = await rowsPage(info.repo, split, 0, 5).catch((err) => {
      throw bad(`Hugging Face's rows API can't read "${info.repo}": ${(err as Error).message}`);
    });
    const rows = (page.rows ?? []).map((r) => r.row);
    const columns = page.features?.map((f) => f.name) ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { ...base, needsToken: false, route: 'rows', files: null, rows: page.num_rows_total ?? null, columns, sample: rows.map((r) => clip(stripIds(r)) as Record<string, unknown>), preset: presetFor(rows) };
  }

  const files = dataFiles(info.files);
  if (!files.length) throw bad(`"${info.repo}" has no JSONL, JSON or CSV files, and Hugging Face's rows API can't read it either`);
  let text: string;
  try {
    text = await readHead(await hfGet(fileUrl(info.repo, files[0]), undefined, 120_000), 4 * 1024 * 1024);
  } catch (err) {
    throw bad(`Can't read ${files[0]}: ${(err as Error).message}`);
  }
  const rows: Record<string, unknown>[] = [];
  for (const { row } of fileRows(files[0], text)) {
    if (row) rows.push(row);
    if (rows.length >= 50) break;
  }
  return {
    ...base,
    needsToken: false,
    route: 'files',
    files: files.length,
    rows: null,
    columns: [...new Set(rows.flatMap((r) => Object.keys(r)))],
    sample: rows.slice(0, 5).map((r) => clip(stripIds(r)) as Record<string, unknown>),
    preset: presetFor(rows),
  };
}

interface Job extends HfImportJob {
  ownerId: string;
  abort: AbortController;
}

const jobs = new Map<string, Job>();

const publicJob = ({ ownerId: _o, abort: _a, ...j }: Job): HfImportJob => j;

/** The job, only for the user who started it. */
export function importJob(ownerId: string, id: string): HfImportJob | undefined {
  const j = jobs.get(id);
  return j && j.ownerId === ownerId ? publicJob(j) : undefined;
}

/** Stops a running import; the batches already written stay. */
export function stopImport(ownerId: string, id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.ownerId !== ownerId) return false;
  if (j.state === 'running') {
    j.state = 'stopped';
    j.abort.abort();
  }
  return true;
}

const strings = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((c) => typeof c === 'string' && c)) throw bad(`map.${what} is a list of column names`);
  return v as string[];
};

/** Starts an import in the background; returns the job's id. */
export async function startImport(ownerId: string, datasetId: string, body: { repo?: unknown; preset?: unknown; map?: unknown; limit?: unknown }): Promise<string> {
  const ds = textDataset(ownerId, datasetId);
  const asked = parseRepo(body.repo);
  if (isFireball(asked) && ds.name.toLowerCase() === DM_DATASET.toLowerCase())
    throw bad(`FIREBALL never goes into "${DM_DATASET}": its answers are Avrae commands and Discord text, not the DM's JSON. Import it into a dataset of its own.`);
  if (body.preset && body.map) throw bad('Send a preset or a map, not both');
  if (body.preset !== undefined && body.preset !== null && body.preset !== 'fireball' && body.preset !== 'chat') throw bad('preset is "fireball" or "chat"');
  const preset = (body.preset || undefined) as HfImportPreset | undefined;
  if (preset === 'fireball' && !isFireball(asked)) throw bad(`The FIREBALL preset is only for ${FIREBALL}`);
  let map: HfImportMap | undefined;
  if (!preset) {
    const m = (body.map ?? {}) as Record<string, unknown>;
    map = { input: strings(m.input, 'input'), output: strings(m.output, 'output'), system: strings(m.system, 'system') };
    if (!map.input.length || !map.output.length) throw bad('Pick the columns for Input and Output (or a preset)');
  }
  const limit = body.limit === null ? null : body.limit === undefined ? DEFAULT_LIMIT : Number(body.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw bad('limit is a number of examples (or null for all)');
  if ([...jobs.values()].some((j) => j.datasetId === ds.id && j.state === 'running')) throw bad('An import into this dataset is already running', 409);
  if (allItems(ds.id) >= limits.cap) throw bad(`This dataset is full: ${limits.cap.toLocaleString('en')} examples is the most one dataset holds`);

  // The job counts as running from here, so a second start while the Hub answers gets 409 too.
  const job: Job = { id: newId(), ownerId, datasetId: ds.id, repo: asked, state: 'running', done: 0, total: null, skipped: 0, file: null, files: null, capped: false, error: null, abort: new AbortController() };
  jobs.set(job.id, job);
  let info: RepoInfo;
  try {
    info = await repoInfo(asked);
    if (info.gated && !token()) throw bad(GATED);
  } catch (err) {
    jobs.delete(job.id);
    throw err;
  }
  job.repo = info.repo;
  void runImport(job, info, converter(info.repo, preset, map), limit).finally(() => setTimeout(() => jobs.delete(job.id), 3_600_000).unref());
  return job.id;
}

async function runImport(job: Job, info: RepoInfo, convert: Convert, limit: number | null) {
  const signal = job.abort.signal;
  const repo = info.repo;
  const dsId = job.datasetId;
  try {
    credit(dsId, repo, info.license);
    const src: ImportSource = { ...datasetSources(dsId).find((s) => s.repo.toLowerCase() === repo.toLowerCase()), repo, license: info.license, url: `${HUB}/datasets/${repo}` };
    // Examples of this repo deleted: start from the beginning.
    const pos = importedCount(dsId, repo) > 0 ? src.position : undefined;
    const room = limits.cap - allItems(dsId);
    const want = Math.min(limit ?? Infinity, room);
    const full = () => job.done >= want;

    let batch: NewItem[] = [];
    let cur: Position | undefined = pos;
    const flush = async () => {
      if (signal.aborted) throw signal.reason;
      if (batch.length) {
        const n = addItems(dsId, 'huggingface', batch);
        job.done += n;
        job.skipped += batch.length - n;
        batch = [];
      }
      if (cur) saveSource(dsId, { ...src, position: cur });
      // Let other requests in (and a Stop) between batches.
      await new Promise((r) => setImmediate(r));
      if (signal.aborted) throw signal.reason;
    };
    /** One row read; cur must already be past it. */
    const take = async (item: NewItem | undefined, ref: string) => {
      if (!item) return void job.skipped++;
      batch.push({ ...item, ref });
      if (batch.length >= Math.min(limits.batch, want - job.done)) await flush();
    };

    const split = await rowsSplit(repo, signal);
    if (split) {
      let offset = pos && 'offset' in pos && pos.config === split.config && pos.split === split.split ? pos.offset : 0;
      const start = offset;
      while (!full()) {
        let page: RowsPage;
        try {
          page = await rowsPage(repo, split, offset, want === Infinity ? PAGE : want - job.done - batch.length, signal);
        } catch (err) {
          if (signal.aborted) throw err;
          throw new Error(`Stopped at row ${offset}: ${(err as Error).message}`);
        }
        if (job.total === null && typeof page.num_rows_total === 'number') job.total = Math.min(want, Math.max(0, page.num_rows_total - start));
        const rows = page.rows ?? [];
        if (!rows.length) break;
        for (const r of rows) {
          offset = r.row_idx + 1;
          cur = { ...split, offset };
          // Half a text must never become a training example.
          await take(r.truncated_cells?.length ? undefined : convert(r.row), `hf:${repo}:${split.config}/${split.split}:${r.row_idx}`);
          if (full()) break;
        }
        if (typeof page.num_rows_total === 'number' && offset >= page.num_rows_total) break;
      }
    } else {
      const files = dataFiles(info.files);
      if (!files.length) throw new Error(`"${repo}" has no JSONL, JSON or CSV files, and Hugging Face's rows API can't read it either`);
      job.files = files.length;
      let first = 0;
      let skipTo = 0;
      if (pos && 'file' in pos) {
        const at = files.indexOf(pos.file);
        first = at >= 0 ? (pos.done ? at + 1 : at) : files.findIndex((f) => f > pos.file);
        if (first < 0) first = files.length;
        skipTo = at >= 0 && !pos.done ? pos.line : 0;
      }
      for (let i = first; i < files.length && !full(); i++) {
        const file = files[i];
        job.file = i + 1;
        let text: string;
        try {
          text = (await readCapped(await hfGet(fileUrl(repo, file), signal, 30 * 60_000), limits.fileBytes, file)).toString('utf8');
        } catch (err) {
          if (signal.aborted) throw err;
          throw new Error(`Stopped at file ${file}: ${(err as Error).message}`);
        }
        let last = 0;
        let stopped = false;
        for (const { line, row } of fileRows(file, text)) {
          last = line;
          if (i === first && line <= skipTo) continue;
          cur = { file, line };
          await take(row ? convert(row) : undefined, `hf:${repo}:${file}:${line}`);
          if ((stopped = full())) break;
        }
        // A file read to the end isn't downloaded again by the next import.
        if (!stopped) cur = { file, line: last, done: true };
      }
    }
    await flush();
    job.capped = full() && want === room;
    job.state = 'done';
  } catch (err) {
    if (signal.aborted) job.state = 'stopped';
    else {
      job.state = 'failed';
      job.error = (err as Error).message;
    }
  }
}
