import { db, hasFts } from '../db/index.js';
import type { NodeServices } from '../nodes/index.js';

const KEEP_PER_KEY = 500;
export const MAX_IMPORT_ENTRIES = 20_000;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY = 50_000;

export interface MemoryHit {
  text: string;
  score: number;
  at: string;
}

/** Lower-case word stems, for matching "grappled" with "grapple". */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|e|s)$/, '') : w));
}

/** Okapi BM25 over a few rows, for SQLite builds without FTS5. Highest score first; rows without a match are left out. */
export function bm25<T extends { text: string }>(rows: T[], query: string, limit: number): (T & { score: number })[] {
  const q = [...new Set(tokens(queryWords(query).join(' ')))];
  if (!q.length || !rows.length) return [];
  const docs = rows.map((r) => tokens(r.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return rows
    .map((r, i) => {
      const d = docs[i];
      let score = 0;
      for (const t of q) {
        const tf = d.filter((w) => w === t).length;
        if (!tf) continue;
        const n = df.get(t)!;
        const idf = Math.log(1 + (rows.length - n + 0.5) / (n + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
      }
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Small words that match almost every entry ("I cast fireball AT THE goblins"), English and Dutch. */
const STOP = new Set(
  'a an and are as at be by can do does for from has have he her his how i if in into is it its me my no not of on or our she so that the their them then there they this to was we what when where which who why will with you your de het een en ik je jij op die dat van voor met is in'.split(' '),
);
const queryWords = (query: string) => {
  const all = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const words = all.filter((w) => !STOP.has(w));
  return words.length ? words : all;
};

/** The words of a query as an FTS5 OR-query; quotes keep punctuation from becoming syntax. */
const ftsQuery = (query: string) =>
  queryWords(query)
    .slice(0, 64)
    .map((w) => `"${w}"`)
    .join(' OR ');

const pinned = (ownerId: string, key: string) =>
  !!(db.prepare('SELECT pinned FROM memory_keys WHERE owner_id = ? AND key = ?').get(ownerId, key) as { pinned: number } | undefined)?.pinned;

/** The best matches for a query in one key (FTS5 bm25 when available). */
export function searchMemory(ownerId: string, key: string, query: string, limit: number): MemoryHit[] {
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 5));
  if (hasFts) {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = db
      .prepare(
        `SELECT m.text, m.created_at AS at, bm25(memory_fts) AS rank FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
         WHERE memory_fts MATCH ? AND m.owner_id = ? AND m.key = ? ORDER BY rank LIMIT ?`,
      )
      .all(match, ownerId, key, n) as { text: string; at: string; rank: number }[];
    // bm25() is lower-is-better and negative; turned around so a higher score is a better match.
    return rows.map((r) => ({ text: r.text, at: r.at, score: Math.round(-r.rank * 1000) / 1000 }));
  }
  const rows = db.prepare('SELECT text, created_at AS at FROM memory WHERE owner_id = ? AND key = ?').all(ownerId, key) as { text: string; at: string }[];
  return bm25(rows, query, n).map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }));
}

export const keyExists = (ownerId: string, key: string) =>
  !!db.prepare('SELECT 1 FROM memory WHERE owner_id = ? AND key = ? LIMIT 1').get(ownerId, key) ||
  !!db.prepare('SELECT 1 FROM memory_keys WHERE owner_id = ? AND key = ?').get(ownerId, key);

/** Bulk import (rules, a whole SRD): one entry per row, the key is pinned so it is never trimmed. */
export function importMemory(ownerId: string, key: string, entries: { text: string; tags?: string[] }[], replace: boolean): number {
  db.exec('BEGIN');
  try {
    if (replace) db.prepare('DELETE FROM memory WHERE owner_id = ? AND key = ?').run(ownerId, key);
    const ins = db.prepare('INSERT INTO memory (owner_id, key, text, tags) VALUES (?, ?, ?, ?)');
    let n = 0;
    for (const e of entries) {
      const text = e.text.trim().slice(0, MAX_ENTRY);
      if (!text) continue;
      ins.run(ownerId, key, text, e.tags?.length ? JSON.stringify(e.tags.slice(0, 20).map(String)) : null);
      n++;
    }
    db.prepare('INSERT INTO memory_keys (owner_id, key, pinned) VALUES (?, ?, 1) ON CONFLICT(owner_id, key) DO UPDATE SET pinned = 1').run(ownerId, key);
    db.exec('COMMIT');
    return n;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function forgetKey(ownerId: string, key: string) {
  db.prepare('DELETE FROM memory WHERE owner_id = ? AND key = ?').run(ownerId, key);
  db.prepare('DELETE FROM memory_keys WHERE owner_id = ? AND key = ?').run(ownerId, key);
}

/** Memory blocks: what a user's canvases remembered, per key, newest last. */
export function memoryFor(ownerId: string): NonNullable<NodeServices['memory']> {
  return {
    recall(key, limit) {
      const rows = db
        .prepare('SELECT text, created_at AS at FROM memory WHERE owner_id = ? AND key = ? ORDER BY id DESC LIMIT ?')
        .all(ownerId, key, limit) as { text: string; at: string }[];
      return rows.reverse();
    },
    save(key, text) {
      db.prepare('INSERT INTO memory (owner_id, key, text) VALUES (?, ?, ?)').run(ownerId, key, text.slice(0, 20000));
      // Imported (pinned) keys keep everything; normal saves keep the newest 500.
      if (pinned(ownerId, key)) return;
      db.prepare(
        'DELETE FROM memory WHERE owner_id = ? AND key = ? AND id NOT IN (SELECT id FROM memory WHERE owner_id = ? AND key = ? ORDER BY id DESC LIMIT ?)',
      ).run(ownerId, key, ownerId, key, KEEP_PER_KEY);
    },
    search: (key, query, limit) => searchMemory(ownerId, key, query, limit),
  };
}
