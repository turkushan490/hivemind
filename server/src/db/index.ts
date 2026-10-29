import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from '../config.js';

// Each entry runs once, in order; never edit an old one, add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    preset TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    local INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE canvases (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    graph TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    canvas_id TEXT,
    question TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    final TEXT,
    cost REAL,
    events TEXT
  );
  CREATE INDEX runs_owner ON runs(owner_id, started_at);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  CREATE TABLE error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    user_id TEXT,
    run_id TEXT,
    seen INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE model_stats (
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    load_ms REAL,
    tokens_per_sec REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, model)
  );
  `,
  `
  CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX memory_key ON memory(owner_id, key, id);
  `,
  `
  ALTER TABLE providers ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE canvases ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE run_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    gen_ms REAL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX run_usage_owner ON run_usage(owner_id, at);
  CREATE INDEX run_usage_run ON run_usage(run_id);
  CREATE TABLE run_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    winner_node TEXT NOT NULL,
    winner_label TEXT NOT NULL,
    winner_model TEXT,
    contenders TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX run_winners_owner ON run_winners(owner_id, at);
  `,
  `
  ALTER TABLE runs ADD COLUMN vars TEXT;
  `,
  `
  ALTER TABLE memory ADD COLUMN tags TEXT;
  CREATE TABLE memory_keys (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, key)
  );
  `,
  `
  ALTER TABLE api_tokens ADD COLUMN scope TEXT;
  `,
  `
  CREATE TABLE lab_runs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at TEXT
  );
  CREATE TABLE lab_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
    game INTEGER NOT NULL,
    turn INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL DEFAULT 'v1',
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    json_valid INTEGER NOT NULL,
    verdict TEXT,
    jev_verdict TEXT,
    error_types TEXT NOT NULL DEFAULT '[]',
    story_score REAL,
    jev_story REAL,
    tokens_per_s REAL,
    ms REAL,
    corrected TEXT,
    review TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX lab_turns_run ON lab_turns(run_id, id);
  CREATE INDEX lab_turns_review ON lab_turns(review);
  `,
  `
  CREATE TABLE lab_trains (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base TEXT NOT NULL,
    name TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    settings TEXT NOT NULL,
    rows INTEGER NOT NULL,
    state TEXT NOT NULL,
    progress TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  `,
  `
  CREATE TABLE datasets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    description TEXT,
    system TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (owner_id, name)
  );
  CREATE TABLE dataset_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    input TEXT NOT NULL DEFAULT '',
    output TEXT NOT NULL DEFAULT '',
    system TEXT,
    files TEXT,
    source TEXT NOT NULL,
    ref TEXT,
    review TEXT,
    meta TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX dataset_items_ds ON dataset_items(dataset_id, id);
  CREATE UNIQUE INDEX dataset_items_ref ON dataset_items(dataset_id, ref) WHERE ref IS NOT NULL;
  ALTER TABLE lab_trains ADD COLUMN dataset_id TEXT;
  ALTER TABLE lab_trains ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
  ALTER TABLE lab_trains ADD COLUMN backend TEXT NOT NULL DEFAULT 'local';
  `,
];

export const db = new DatabaseSync(join(config.dataDir, 'hivemind.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
for (let i = version; i < MIGRATIONS.length; i++) {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Full-text search over memory (Memory blocks in search mode): an FTS5 table kept in sync by triggers.
 * Created outside the migrations because a SQLite build without FTS5 must still start; then
 * hasFts is false and search falls back to BM25 in JavaScript.
 */
export const hasFts = (() => {
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_fts'").get()) return true;
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory', content_rowid='id', tokenize='porter unicode61');
        CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
          INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER memory_fts_au AFTER UPDATE OF text ON memory BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
        END;
        INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return true;
  } catch (err) {
    console.warn(`SQLite has no FTS5 (${(err as Error).message}); memory search uses the built-in BM25 instead`);
    return false;
  }
})();

export function getSetting(key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
