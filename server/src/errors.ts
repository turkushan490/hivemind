import { db } from './db/index.js';

/** Where a problem came from, shown in the Problems tab. */
export type ErrorSource = 'server' | 'crash' | 'run' | 'provider' | 'web';

export interface LoggedError {
  source: ErrorSource;
  message: string;
  detail?: string;
  userId?: string;
  runId?: string;
}

const KEEP = 1000;

/** Stores a problem so it survives restarts and shows up in the UI. Never throws. */
export function logError(e: LoggedError): number | undefined {
  try {
    const r = db
      .prepare('INSERT INTO error_log (source, message, detail, user_id, run_id) VALUES (?, ?, ?, ?, ?)')
      .run(e.source, e.message.slice(0, 2000), e.detail?.slice(0, 20000) ?? null, e.userId ?? null, e.runId ?? null);
    db.prepare('DELETE FROM error_log WHERE id <= (SELECT MAX(id) FROM error_log) - ?').run(KEEP);
    return Number(r.lastInsertRowid);
  } catch (err) {
    console.error('could not log error', err, e);
  }
}

export function describe(err: unknown): { message: string; detail?: string } {
  if (err instanceof Error) return { message: err.message || err.name, detail: err.stack };
  return { message: String(err) };
}
