import type { Dataset, DatasetItem, DatasetKind, DatasetSource } from '@hivemind/shared';
import { DATASET_KINDS } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { SFT_SYSTEM } from './data.js';

/**
 * Datasets: training examples for any kind of model (text, image, decision, voice). Every source feeds them:
 * the Lab simulator, 👍 on answers, uploads, examples a teacher model wrote, and the Add-to-dataset block.
 * Items with review "pending" or "rejected" are never trained on.
 */

export const DM_DATASET = 'DungeonMind DM';
const MAX_TEXT = 200_000;

interface DatasetRow {
  id: string;
  owner_id: string;
  name: string;
  kind: DatasetKind;
  description: string | null;
  system: string | null;
  created_at: string;
  items?: number;
  pending?: number;
}

interface ItemRow {
  id: number;
  dataset_id: string;
  input: string;
  output: string;
  system: string | null;
  files: string | null;
  source: DatasetSource;
  ref: string | null;
  review: DatasetItem['review'] | null;
  at: string;
}

const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const toDataset = (r: DatasetRow): Dataset => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  ...(r.description && { description: r.description }),
  ...(r.system && { system: r.system }),
  createdAt: r.created_at,
  items: r.items ?? 0,
  pending: r.pending ?? 0,
});

export const toItem = (r: ItemRow): DatasetItem => ({
  id: r.id,
  input: r.input,
  output: r.output,
  ...(r.system && { system: r.system }),
  ...(r.files && { files: JSON.parse(r.files) as string[] }),
  source: r.source,
  ...(r.review && { review: r.review }),
  at: r.at,
});

const COUNTS = `(SELECT COUNT(*) FROM dataset_items i WHERE i.dataset_id = d.id AND (i.review IS NULL OR i.review = 'accepted')) AS items,
  (SELECT COUNT(*) FROM dataset_items i WHERE i.dataset_id = d.id AND i.review = 'pending') AS pending`;

export function listDatasets(ownerId: string): Dataset[] {
  return (db.prepare(`SELECT d.*, ${COUNTS} FROM datasets d WHERE d.owner_id = ? ORDER BY d.created_at DESC`).all(ownerId) as unknown as DatasetRow[]).map(toDataset);
}

export function getDataset(ownerId: string, id: string): Dataset | undefined {
  const r = db.prepare(`SELECT d.*, ${COUNTS} FROM datasets d WHERE d.owner_id = ? AND d.id = ?`).get(ownerId, id) as unknown as DatasetRow | undefined;
  return r && toDataset(r);
}

/** A dataset by id, or by name (blocks name their dataset); undefined when the user has none. */
export function findDataset(ownerId: string, idOrName: string): Dataset | undefined {
  const r = db.prepare(`SELECT d.*, ${COUNTS} FROM datasets d WHERE d.owner_id = ? AND (d.id = ? OR d.name = ? COLLATE NOCASE)`).get(ownerId, idOrName, idOrName) as unknown as
    | DatasetRow
    | undefined;
  return r && toDataset(r);
}

export function createDataset(ownerId: string, opts: { name: string; kind?: DatasetKind; description?: string; system?: string }): Dataset {
  const name = String(opts.name ?? '').trim().slice(0, 80);
  if (!name) throw bad('Give the dataset a name');
  const kind = opts.kind ?? 'text';
  if (!DATASET_KINDS.includes(kind)) throw bad(`Kind must be one of ${DATASET_KINDS.join(', ')}`);
  if (findDataset(ownerId, name)) throw bad(`You already have a dataset called "${name}"`, 409);
  const id = newId();
  db.prepare('INSERT INTO datasets (id, owner_id, name, kind, description, system) VALUES (?, ?, ?, ?, ?, ?)').run(id, ownerId, name, kind, opts.description ?? null, opts.system ?? null);
  return getDataset(ownerId, id)!;
}

/** The dataset with this name, made when it doesn't exist yet (blocks and 👍 write into a named dataset). */
export function ensureDataset(ownerId: string, name: string, kind: DatasetKind = 'text', system?: string): Dataset {
  return findDataset(ownerId, name) ?? createDataset(ownerId, { name, kind, system });
}

export function updateDataset(ownerId: string, id: string, opts: { name?: string; description?: string; system?: string }): Dataset {
  const d = getDataset(ownerId, id);
  if (!d) throw bad('Dataset not found', 404);
  const name = opts.name === undefined ? d.name : String(opts.name).trim().slice(0, 80);
  if (!name) throw bad('Give the dataset a name');
  db.prepare('UPDATE datasets SET name = ?, description = ?, system = ? WHERE id = ?').run(name, opts.description ?? d.description ?? null, opts.system ?? d.system ?? null, id);
  return getDataset(ownerId, id)!;
}

export function deleteDataset(ownerId: string, id: string): boolean {
  return db.prepare('DELETE FROM datasets WHERE id = ? AND owner_id = ?').run(id, ownerId).changes > 0;
}

export interface NewItem {
  input?: string;
  output?: string;
  system?: string;
  files?: string[];
  review?: DatasetItem['review'];
  /** Same ref twice in one dataset updates the item instead of adding it again. */
  ref?: string;
  meta?: Record<string, unknown>;
}

/** Adds examples (or updates the ones with the same ref); returns how many were stored. */
export function addItems(datasetId: string, source: DatasetSource, items: NewItem[]): number {
  const insert = db.prepare(
    `INSERT INTO dataset_items (dataset_id, input, output, system, files, source, ref, review, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dataset_id, ref) WHERE ref IS NOT NULL DO UPDATE SET input = excluded.input, output = excluded.output, system = excluded.system,
       files = excluded.files, review = excluded.review, meta = excluded.meta`,
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const input = String(it.input ?? '').slice(0, MAX_TEXT);
      const output = String(it.output ?? '').slice(0, MAX_TEXT);
      if (!input.trim() && !output.trim() && !it.files?.length) continue;
      insert.run(datasetId, input, output, it.system ?? null, it.files?.length ? JSON.stringify(it.files) : null, source, it.ref ?? null, it.review ?? null, it.meta ? JSON.stringify(it.meta) : null);
      n++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

export function listItems(datasetId: string, opts: { review?: string; limit?: number; offset?: number } = {}): DatasetItem[] {
  const where = ['dataset_id = ?'];
  const args: (string | number)[] = [datasetId];
  if (opts.review === 'pending') where.push("review = 'pending'");
  if (opts.review === 'ok') where.push("(review IS NULL OR review = 'accepted')");
  args.push(Math.max(1, Math.min(500, opts.limit ?? 100)), Math.max(0, opts.offset ?? 0));
  return (db.prepare(`SELECT * FROM dataset_items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args) as unknown as ItemRow[]).map(toItem);
}

/** The item, checked to belong to one of the owner's datasets. */
export function itemOf(ownerId: string, itemId: number): (ItemRow & { kind: DatasetKind }) | undefined {
  return db.prepare('SELECT i.*, d.kind FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id WHERE i.id = ? AND d.owner_id = ?').get(itemId, ownerId) as unknown as
    | (ItemRow & { kind: DatasetKind })
    | undefined;
}

export function updateItem(ownerId: string, itemId: number, patch: { input?: string; output?: string; review?: DatasetItem['review'] | null }) {
  const it = itemOf(ownerId, itemId);
  if (!it) throw bad('Example not found', 404);
  if (patch.review !== undefined && patch.review !== null && !['pending', 'accepted', 'rejected'].includes(patch.review)) throw bad('review must be pending, accepted or rejected');
  db.prepare('UPDATE dataset_items SET input = ?, output = ?, review = ? WHERE id = ?').run(
    patch.input === undefined ? it.input : String(patch.input).slice(0, MAX_TEXT),
    patch.output === undefined ? it.output : String(patch.output).slice(0, MAX_TEXT),
    (patch.review === undefined ? it.review : patch.review) ?? null,
    itemId,
  );
}

export function deleteItem(ownerId: string, itemId: number): boolean {
  const it = itemOf(ownerId, itemId);
  return !!it && db.prepare('DELETE FROM dataset_items WHERE id = ?').run(itemId).changes > 0;
}

/** Training examples ready to use: everything except pending and rejected ones. */
export function trainableCount(datasetId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM dataset_items WHERE dataset_id = ? AND (review IS NULL OR review = 'accepted')").get(datasetId) as { n: number }).n;
}

/** JSONL for training. Text: chat format {"messages": [system, user, assistant]}; other kinds keep their fields. */
export function exportDataset(datasetId: string): string {
  const ds = db.prepare('SELECT kind, system FROM datasets WHERE id = ?').get(datasetId) as { kind: DatasetKind; system: string | null } | undefined;
  if (!ds) return '';
  const rows = db.prepare("SELECT * FROM dataset_items WHERE dataset_id = ? AND (review IS NULL OR review = 'accepted') ORDER BY id").all(datasetId) as unknown as ItemRow[];
  return rows
    .map((r) => {
      const system = r.system ?? ds.system;
      if (ds.kind === 'text')
        return JSON.stringify({
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: r.input }, { role: 'assistant', content: r.output }],
        });
      return JSON.stringify({ input: r.input, output: r.output, ...(system && { system }), ...(r.files && { files: JSON.parse(r.files) }) });
    })
    .join('\n');
}

/** Parses uploaded examples: JSONL (chat "messages" or {input, output}/{prompt, completion}), CSV (2 columns) or plain text. */
export function parseUpload(text: string, format?: 'jsonl' | 'csv' | 'txt'): NewItem[] {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return [];
  const fmt = format ?? (t.startsWith('{') ? 'jsonl' : t.split('\n')[0].includes(',') || t.split('\n')[0].includes(';') ? 'csv' : 'txt');
  if (fmt === 'jsonl') {
    return t
      .split('\n')
      .filter((l) => l.trim())
      .map((line, i) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch (err) {
          throw bad(`Line ${i + 1} is not valid JSON: ${(err as Error).message}`);
        }
        if (Array.isArray(o.messages)) {
          const sys = o.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n\n');
          const user = [...o.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';
          const assistant = [...o.messages].reverse().find((m: any) => m.role === 'assistant')?.content ?? '';
          return { input: String(user), output: String(assistant), ...(sys && { system: sys }) };
        }
        return { input: String(o.input ?? o.prompt ?? o.question ?? o.instruction ?? ''), output: String(o.output ?? o.completion ?? o.answer ?? o.response ?? '') };
      });
  }
  if (fmt === 'csv') {
    const rows = parseCsv(t);
    const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const named = head.some((h) => ['input', 'prompt', 'question'].includes(h));
    const ii = named ? head.findIndex((h) => ['input', 'prompt', 'question'].includes(h)) : 0;
    const oi = named ? head.findIndex((h) => ['output', 'completion', 'answer', 'response'].includes(h)) : 1;
    return rows.slice(named ? 1 : 0).map((r) => ({ input: r[ii] ?? '', output: oi >= 0 ? (r[oi] ?? '') : '' }));
  }
  // Plain text: examples separated by blank lines; "input ||| output" splits a pair, else it's an output-only example.
  return t.split(/\n\s*\n/).map((block) => {
    const [a, b] = block.split('|||');
    return b === undefined ? { input: '', output: a.trim() } : { input: a.trim(), output: b.trim() };
  });
}

/** CSV with quotes, commas or semicolons. */
function parseCsv(text: string): string[][] {
  const sep = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')]);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/**
 * The Lab writes its turns here too: a clean turn (or an accepted correction) is an example in the owner's
 * "DungeonMind DM" dataset; a rejected or still-pending turn is not.
 */
export function syncLabTurn(ownerId: string, turnId: number) {
  const t = db.prepare('SELECT input, output, json_valid, error_types, corrected, review FROM lab_turns WHERE id = ?').get(turnId) as
    | { input: string; output: string; json_valid: number; error_types: string; corrected: string | null; review: string | null }
    | undefined;
  if (!t) return;
  const ds = ensureDataset(ownerId, DM_DATASET, 'text', SFT_SYSTEM);
  const ref = `lab_turn:${turnId}`;
  const good = (t.review === 'accepted' && t.corrected) || (t.review === null && t.json_valid === 1 && t.error_types === '[]');
  if (!good) {
    db.prepare('DELETE FROM dataset_items WHERE dataset_id = ? AND ref = ?').run(ds.id, ref);
    return;
  }
  addItems(ds.id, 'lab', [{ input: t.input, output: t.review === 'accepted' && t.corrected ? t.corrected : t.output, ref }]);
}

/** Once at start: Lab turns from before datasets existed go into the DM dataset. */
export function migrateLabTurns() {
  const rows = db
    .prepare(
      `SELECT t.id, r.owner_id FROM lab_turns t JOIN lab_runs r ON r.id = t.run_id
       WHERE NOT EXISTS (SELECT 1 FROM dataset_items i WHERE i.ref = 'lab_turn:' || t.id)`,
    )
    .all() as { id: number; owner_id: string }[];
  for (const r of rows) syncLabTurn(r.owner_id, r.id);
}
