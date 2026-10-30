import { hhmm, minutesOf, now, validTime } from '../clock.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * The training window (Settings → Training): nightly jobs, and jobs started by a scheduled run, wait as "queued"
 * until it opens and pause (with a checkpoint) when it closes. Local time; a window like 22:00–06:00 crosses
 * midnight.
 */

const KEY = 'lab.window';
export const DEFAULT_WINDOW = { start: '03:00', end: '08:00' };

export function windowSettings(): { start: string; end: string } {
  try {
    const s = JSON.parse(getSetting(KEY) ?? '{}') as { start?: unknown; end?: unknown };
    return { start: validTime(s.start) ? s.start : DEFAULT_WINDOW.start, end: validTime(s.end) ? s.end : DEFAULT_WINDOW.end };
  } catch {
    return { ...DEFAULT_WINDOW };
  }
}

export function saveWindow(body: { start?: unknown; end?: unknown }) {
  const cur = windowSettings();
  const start = body.start === undefined ? cur.start : body.start;
  const end = body.end === undefined ? cur.end : body.end;
  if (!validTime(start) || !validTime(end)) throw Object.assign(new Error('Times look like 03:00 (24-hour clock)'), { statusCode: 400 });
  if (start === end) throw Object.assign(new Error('The window must not start and end at the same time'), { statusCode: 400 });
  setSetting(KEY, JSON.stringify({ start, end }));
  return trainingWindow();
}

/** GET /api/lab/window: the window and whether it is open right now. */
export function trainingWindow(at: Date = now()): { start: string; end: string; open: boolean } {
  const w = windowSettings();
  const m = minutesOf(hhmm(at));
  const s = minutesOf(w.start);
  const e = minutesOf(w.end);
  return { ...w, open: s < e ? m >= s && m < e : m >= s || m < e };
}
