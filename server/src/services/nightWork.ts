// H13 — Night work on Tower: when the GPU is quiet (00:00–06:00), sort the memory, write Jarvis's fix list, and train,
// each as a background priority-100 job, then leave a morning report. "Run the night work now" starts it at once.
import { db, getSetting, setSetting } from '../db/index.js';
import { liveRunCount, runEnded, startRun } from '../events/runs.js';
import { logError } from '../errors.js';
import { appendLog } from '../logfile.js';
import * as memFiles from './memoryFiles.js';
import { memoryFor } from './memory.js';
import type { User } from '../api/auth.js';

export interface NightWorkSettings {
  enabled: boolean;
  /** The canvas (id or name) that sorts/merges the memory, and the one that does training reflection. Optional. */
  memorySortCanvas?: string;
  trainingCanvas?: string;
  /** The window it may run in (local hours); default 00:00–06:00. */
  fromHour: number;
  toHour: number;
  /** Set when enabled: whose memory/providers the jobs run as (an admin). */
  ownerId?: string;
}

const KEY = 'night-work';
export const DEFAULT_NIGHT: NightWorkSettings = { enabled: false, fromHour: 0, toHour: 6 };

export function nightSettings(): NightWorkSettings {
  try {
    return { ...DEFAULT_NIGHT, ...(JSON.parse(getSetting(KEY) ?? '{}') as Partial<NightWorkSettings>) };
  } catch {
    return { ...DEFAULT_NIGHT };
  }
}
export function saveNightSettings(patch: Partial<NightWorkSettings>, ownerId?: string): NightWorkSettings {
  const next = { ...nightSettings(), ...patch };
  next.fromHour = Math.max(0, Math.min(23, Math.round(next.fromHour)));
  next.toHour = Math.max(1, Math.min(24, Math.round(next.toHour)));
  if (next.enabled && ownerId) next.ownerId = ownerId;
  setSetting(KEY, JSON.stringify(next));
  return next;
}

/** The admin the night work runs as: the configured owner, else the first admin. */
function owner(s: NightWorkSettings): User | undefined {
  const id = s.ownerId;
  const row = (id ? db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) : db.prepare("SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get()) as User | undefined;
  return row;
}

/** True while the GPU is likely busy (a run is going). Night work then waits for the next hour. */
const gpuBusy = () => liveRunCount() > 0;

/** Jarvis's fix list from the last 24 h: Problems, failed runs, and the robot's log digest → characters/jarvis/fix-next-update.md. */
function writeFixList(ownerId: string): string {
  const problems = db.prepare("SELECT at, source, message FROM error_log WHERE at > datetime('now','-1 day') ORDER BY id DESC LIMIT 100").all() as { at: string; source: string; message: string }[];
  const failed = db.prepare("SELECT started_at, question, final FROM runs WHERE status = 'error' AND started_at > datetime('now','-1 day') ORDER BY started_at DESC LIMIT 50").all() as { started_at: string; question: string }[];
  // The robot's daily log digest (it writes it to the memory key "hivebot-log-digest").
  let digest = '';
  try {
    digest = memoryFor(ownerId).recall('hivebot-log-digest', 3).map((m) => `- ${m.text}`).join('\n');
  } catch {}
  const lines = [
    `# Fix next update`,
    `Written by the night work on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. The last 24 hours.`,
    '',
    `## Problems (${problems.length})`,
    ...problems.slice(0, 50).map((p) => `- [${p.source}] ${p.message} (${p.at})`),
    '',
    `## Failed runs (${failed.length})`,
    ...failed.map((r) => `- ${r.question?.slice(0, 120) ?? '(no question)'} (${r.started_at})`),
    ...(digest ? ['', '## From the robot log digest', digest.trim()] : []),
  ];
  const text = lines.join('\n');
  memFiles.write(ownerId, 'characters/jarvis/fix-next-update.md', text, { by: 'night' });
  return `Fix list: ${problems.length} problems, ${failed.length} failed runs`;
}

/** Starts a configured canvas (id or name) as a priority-100 background job and waits for it (up to 55 min). */
async function runCanvasJob(user: User, canvas: string, question: string): Promise<string> {
  const runs = await import('../api/runs.js');
  const providers = await import('../api/providers.js');
  const row = runs.canvasFor(user, canvas) ?? runs.canvasesFor(user).find((r) => r.name === canvas);
  if (!row) return `skipped: no canvas "${canvas}"`;
  const runId = startRun({
    ownerId: user.id,
    user,
    canvasId: row.id,
    graph: JSON.parse(row.graph),
    question,
    resolve: providers.resolverFor(user),
    freeGpu: providers.gpuFreerFor(user),
    training: providers.trainingFor(user),
    source: 'Night',
    priority: 100,
    timeLimitMin: 55,
  });
  const done = await runEnded(runId, 55 * 60_000);
  return done ? `ran "${row.name}" (run ${runId})` : `"${row.name}" still running (run ${runId})`;
}

let running = false;

/** Runs the night work now: fix list, memory sort, training — then a morning report. Returns a summary. */
export async function runNightWork(reason: string): Promise<{ ran: string[]; skipped: string[] }> {
  const s = nightSettings();
  const user = owner(s);
  if (!user) return { ran: [], skipped: ['no admin user to run as'] };
  if (running) return { ran: [], skipped: ['already running'] };
  running = true;
  const ran: string[] = [];
  const skipped: string[] = [];
  appendLog('server', `Night work started (${reason})`);
  try {
    try {
      ran.push(writeFixList(user.id));
    } catch (err) {
      skipped.push(`fix list: ${(err as Error).message}`);
    }
    if (s.memorySortCanvas) ran.push(`memory sort — ${await runCanvasJob(user, s.memorySortCanvas, 'Sort and merge the memory: merge duplicate topics, move files into logical folders, rewrite index.md. Never delete facts.').catch((e) => `failed: ${(e as Error).message}`)}`);
    else skipped.push('memory sort: no canvas set');
    if (s.trainingCanvas) ran.push(`training — ${await runCanvasJob(user, s.trainingCanvas, 'Nightly training: each character reflects on the day and fine-tunes when there are new examples.').catch((e) => `failed: ${(e as Error).message}`)}`);
    else skipped.push('training: no canvas set');
  } finally {
    running = false;
  }
  // Morning report (proof of what ran / was skipped and why).
  const report = [`# Night work — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, `Started: ${reason}`, '', '## Ran', ...ran.map((r) => `- ${r}`), '', '## Skipped', ...skipped.map((r) => `- ${r}`)].join('\n');
  try {
    memFiles.write(user.id, 'characters/jarvis/night-report.md', report, { by: 'night' });
  } catch {}
  appendLog('server', `Night work done: ran ${ran.length}, skipped ${skipped.length}`);
  return { ran, skipped };
}

let lastRunDay = '';

/** Called every ~15 min: inside the window, GPU quiet, once per night. */
export async function nightTick(): Promise<void> {
  const s = nightSettings();
  if (!s.enabled) return;
  const now = new Date();
  const hour = now.getHours();
  const inWindow = s.fromHour <= s.toHour ? hour >= s.fromHour && hour < s.toHour : hour >= s.fromHour || hour < s.toHour;
  if (!inWindow) return;
  const day = now.toISOString().slice(0, 10);
  if (lastRunDay === day) return; // already done tonight
  if (gpuBusy()) return; // try again next tick
  lastRunDay = day;
  try {
    await runNightWork('scheduled');
  } catch (err) {
    logError({ source: 'server', message: `Night work failed: ${(err as Error).message}` });
  }
}
