import { db } from '../db/index.js';
import type { NodeServices } from '../nodes/index.js';

const KEEP_PER_KEY = 500;

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
      db.prepare(
        'DELETE FROM memory WHERE owner_id = ? AND key = ? AND id NOT IN (SELECT id FROM memory WHERE owner_id = ? AND key = ? ORDER BY id DESC LIMIT ?)',
      ).run(ownerId, key, ownerId, key, KEEP_PER_KEY);
    },
  };
}
