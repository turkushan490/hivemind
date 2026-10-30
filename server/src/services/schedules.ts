import { SCHEDULE_DAYS, type ScheduleDay, type WorkflowSchedule } from '@hivemind/shared';
import { minutesOf, now, validTime } from '../clock.js';
import { db } from '../db/index.js';
import { logError } from '../errors.js';

/**
 * Workflows that run by themselves at a time of day (local time, so TZ counts), on chosen days, as the user who
 * set the schedule. A minute ticker (main.ts) starts what is due; a run missed by up to an hour (a restart) still
 * starts, an older one waits for its next time.
 */

interface Row {
  canvas_id: string;
  owner_id: string;
  time: string;
  days: string;
  enabled: number;
  last_run_at: string | null;
}

const LATE_MS = 60 * 60_000;

const dayOf = (d: Date): ScheduleDay => SCHEDULE_DAYS[(d.getDay() + 6) % 7];

/** The schedule's time on the day of d (local). */
const at = (d: Date, time: string) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutesOf(time) / 60), minutesOf(time) % 60);

function nextRun(r: Row, from: Date): Date | undefined {
  const days = r.days.split(',');
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const t = at(d, r.time);
    if (days.includes(dayOf(d)) && t.getTime() >= from.getTime() - 59_999) return t;
  }
}

const toSchedule = (r: Row): WorkflowSchedule => {
  const next = r.enabled ? nextRun(r, now()) : undefined;
  return {
    canvasId: r.canvas_id,
    time: r.time,
    days: r.days.split(',').filter(Boolean) as ScheduleDay[],
    enabled: !!r.enabled,
    ...(r.last_run_at && { lastRunAt: r.last_run_at }),
    ...(next && { nextRunAt: next.toISOString() }),
  };
};

export function getSchedule(ownerId: string, canvasId: string): WorkflowSchedule | undefined {
  const r = db.prepare('SELECT * FROM workflow_schedules WHERE canvas_id = ? AND owner_id = ?').get(canvasId, ownerId) as Row | undefined;
  return r && toSchedule(r);
}

/** PUT body: {time: "HH:MM", days?: ["mon", …] (default every day), enabled?: true}. */
export function saveSchedule(ownerId: string, canvasId: string, body: { time?: unknown; days?: unknown; enabled?: unknown }): WorkflowSchedule {
  const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  const cur = db.prepare('SELECT * FROM workflow_schedules WHERE canvas_id = ? AND owner_id = ?').get(canvasId, ownerId) as Row | undefined;
  const time = body.time ?? cur?.time;
  if (!validTime(time)) throw bad('time looks like "03:15" (24-hour clock, local time)');
  let days = cur ? cur.days.split(',') : [...SCHEDULE_DAYS];
  if (body.days !== undefined) {
    if (!Array.isArray(body.days) || !body.days.length || body.days.some((d) => !SCHEDULE_DAYS.includes(String(d).toLowerCase() as ScheduleDay)))
      throw bad(`days is a list of ${SCHEDULE_DAYS.join(', ')} (at least one)`);
    const set = new Set(body.days.map((d) => String(d).toLowerCase()));
    days = SCHEDULE_DAYS.filter((d) => set.has(d));
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('enabled must be true or false');
  const enabled = body.enabled === undefined ? (cur?.enabled ?? 1) : body.enabled ? 1 : 0;
  db.prepare(
    `INSERT INTO workflow_schedules (canvas_id, owner_id, time, days, enabled) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(canvas_id, owner_id) DO UPDATE SET time = excluded.time, days = excluded.days, enabled = excluded.enabled`,
  ).run(canvasId, ownerId, time, days.join(','), enabled);
  return getSchedule(ownerId, canvasId)!;
}

export function deleteSchedule(ownerId: string, canvasId: string): boolean {
  return db.prepare('DELETE FROM workflow_schedules WHERE canvas_id = ? AND owner_id = ?').run(canvasId, ownerId).changes > 0;
}

/** Starts every schedule that is due at this moment; returns the canvases started. */
export function tickSchedules(start: (s: { canvasId: string; ownerId: string; time: string }) => void, t: Date = now()): string[] {
  const started: string[] = [];
  for (const r of db.prepare('SELECT * FROM workflow_schedules WHERE enabled = 1').all() as unknown as Row[]) {
    if (!r.days.split(',').includes(dayOf(t))) continue;
    const due = at(t, r.time);
    if (t.getTime() < due.getTime() || t.getTime() - due.getTime() >= LATE_MS) continue;
    if (r.last_run_at && new Date(r.last_run_at).getTime() >= due.getTime()) continue;
    // Marked first: a run that fails to start is reported once, not every minute.
    db.prepare('UPDATE workflow_schedules SET last_run_at = ? WHERE canvas_id = ? AND owner_id = ?').run(t.toISOString(), r.canvas_id, r.owner_id);
    try {
      start({ canvasId: r.canvas_id, ownerId: r.owner_id, time: r.time });
      started.push(r.canvas_id);
    } catch (err) {
      logError({ source: 'server', message: `Scheduled run of workflow "${r.canvas_id}" (${r.time}) did not start: ${(err as Error).message}`, userId: r.owner_id });
    }
  }
  return started;
}

/** The minute ticker: checks a few seconds after every full minute. */
export function startScheduler(start: Parameters<typeof tickSchedules>[0]): () => void {
  let timer: NodeJS.Timeout | undefined;
  const loop = () => {
    try {
      tickSchedules(start);
    } catch (err) {
      logError({ source: 'server', message: `Scheduler: ${(err as Error).message}` });
    }
    timer = setTimeout(loop, 60_000 - (Date.now() % 60_000) + 2000);
    timer.unref();
  };
  timer = setTimeout(loop, 60_000 - (Date.now() % 60_000) + 2000);
  timer.unref();
  return () => clearTimeout(timer);
}
