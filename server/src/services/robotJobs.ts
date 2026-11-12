import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { runSnapshot } from '../events/runs.js';
import type { Checkpoint } from '../engine/run.js';

/**
 * Background jobs ("that needs more time"): a /v1 request with hivemind_vars.background starts its run and answers 202
 * at once; the robot (or app) asks later how it went. A job is a run plus who asked (robot, character, title) and
 * whether the owner has heard the result. Resuming from a block starts a new run that keeps what the blocks before
 * it already made; the job then follows the new run.
 */

export interface JobRow {
  id: string;
  run_id: string;
  owner_id: string;
  robot_id: string | null;
  canvas_id: string | null;
  character: string | null;
  title: string | null;
  seen: number;
  created_at: string;
}

export function createJob(o: { runId: string; ownerId: string; robotId?: string; canvasId?: string; character?: string; title?: string }): string {
  const id = `job_${newId().replace(/[^a-zA-Z0-9]/g, 'x')}`;
  db.prepare('INSERT INTO robot_jobs (id, run_id, owner_id, robot_id, canvas_id, character, title) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    o.runId,
    o.ownerId,
    o.robotId ?? null,
    o.canvasId ?? null,
    o.character?.slice(0, 40) ?? null,
    o.title?.slice(0, 200) ?? null,
  );
  return id;
}

export const getJob = (ownerId: string, id: string) => db.prepare('SELECT * FROM robot_jobs WHERE id = ? AND owner_id = ?').get(id, ownerId) as JobRow | undefined;

type Status = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

const statusOf = (s: string, events: RunEvent[]): Status => {
  if (s === 'running' || s === 'paused') return events.some((e) => e.type === 'node_start' && e.nodeType !== 'input') ? 'running' : 'queued';
  // A step that failed makes the job failed, even when the run itself went to its end.
  if (s === 'done') return events.some((e) => e.type === 'error' && e.nodeId && e.nodeType !== 'output') ? 'failed' : 'done';
  if (s === 'cancelled') return 'cancelled';
  return 'failed';
};

/** What a job's run has done so far: the block now, how many are done, the last output, files and speeds. */
export function jobView(j: JobRow, detail = false) {
  const snap = runSnapshot(j.run_id, j.owner_id);
  const events = snap?.events ?? [];
  const status = snap ? statusOf(snap.status, events) : 'failed';
  const graph = events.find((e) => e.type === 'run_start')?.graph as CanvasGraph | undefined;
  const label = (id?: string) => {
    const n = graph?.nodes.find((x) => x.id === id);
    return n?.label || n?.config.model?.model || n?.type || id || '';
  };
  const models = new Map((graph?.nodes ?? []).map((n) => [n.id, n.config.model]));
  const done = events.filter((e) => e.type === 'node_done');
  const started = new Map(events.filter((e) => e.type === 'node_start').map((e) => [e.nodeId!, e.ts]));
  const running = [...started.keys()].filter((id) => !done.some((d) => d.nodeId === id) && !events.some((e) => e.type === 'error' && e.nodeId === id));
  const total = (graph?.nodes ?? []).filter((n) => n.type !== 'input' && n.type !== 'output').length;
  // The first block that failed (the ones after it only say "All inputs failed").
  const error = events.find((e) => e.type === 'error' && e.nodeId && e.nodeType !== 'output');
  const final = snap?.final ?? events.find((e) => e.type === 'run_done')?.final;
  const last = done.filter((e) => e.nodeType !== 'output' && e.nodeType !== 'input').at(-1);
  const files = done.flatMap((e) => e.files ?? []).map((f) => ({ name: f.path.split('/').pop()!, path: f.path, url: `/api/files/raw?path=${encodeURIComponent(f.path)}` }));
  // The live speed of the block that writes now.
  const liveTps = running.length ? events.filter((e) => e.type === 'token' && e.nodeId === running[0]).at(-1)?.tokensPerSec : undefined;
  const finishedAt = events.find((e) => e.type === 'run_done')?.ts;
  return {
    jobId: j.id,
    character: j.character ?? undefined,
    title: j.title ?? undefined,
    status,
    seen: !!j.seen,
    createdAt: `${j.created_at.replace(' ', 'T')}Z`,
    ...(finishedAt && { finishedAt: new Date(finishedAt).toISOString() }),
    ...(status === 'done' && final !== undefined && { answer: final }),
    ...(status === 'failed' && error && { error: error.error, failedNode: error.nodeId, failedLabel: label(error.nodeId) }),
    progress: {
      done: done.filter((e) => e.nodeType !== 'input' && e.nodeType !== 'output').length,
      total,
      ...(running[0] && { now: label(running[0]), nowNode: running[0], ...(liveTps && { tokensPerSecond: Math.round(liveTps * 10) / 10 }) }),
      ...(last?.text && { lastOutput: last.text.slice(0, 300), lastLabel: label(last.nodeId) }),
    },
    files,
    ...(detail && {
      runId: j.run_id,
      blocks: done
        .filter((e) => e.nodeType !== 'input' && e.nodeType !== 'output')
        .map((e) => ({
          node: label(e.nodeId),
          nodeId: e.nodeId,
          ...(e.model && { model: e.model, provider: models.get(e.nodeId!)?.providerId }),
          ...(e.tokensPerSec && { tokensPerSecond: Math.round(e.tokensPerSec * 10) / 10 }),
          ...(e.tokens && { completionTokens: e.tokens }),
          ...(e.inputTokens && { promptTokens: e.inputTokens }),
          seconds: Math.round(((e.ts - (started.get(e.nodeId!) ?? e.ts)) / 1000) * 10) / 10,
        })),
    }),
  };
}

export function listJobs(ownerId: string, robotId?: string) {
  const rows = db
    .prepare(`SELECT * FROM robot_jobs WHERE owner_id = ? ${robotId ? 'AND (robot_id = ? OR robot_id IS NULL)' : ''} ORDER BY created_at DESC LIMIT 50`)
    .all(...(robotId ? [ownerId, robotId] : [ownerId])) as unknown as JobRow[];
  return rows.map((j) => jobView(j));
}

/** Finished jobs nobody has told the owner about yet (the heartbeat says how many). */
export function jobsDone(ownerId: string, robotId?: string): number {
  return listJobs(ownerId, robotId).filter((j) => !j.seen && (j.status === 'done' || j.status === 'failed')).length;
}

/** Jobs still going (the heartbeat says how many, so the robot shows its orbs without polling) — H8. */
export function jobsRunning(ownerId: string, robotId?: string): number {
  return listJobs(ownerId, robotId).filter((j) => j.status === 'running' || j.status === 'queued').length;
}

export const markSeen = (ownerId: string, id: string) => db.prepare('UPDATE robot_jobs SET seen = 1 WHERE id = ? AND owner_id = ?').run(id, ownerId).changes > 0;

/**
 * What a resumed run starts from: every block's output from the job's run, except the block to start again from and
 * everything after it (which run again).
 */
export function resumeCheckpoint(j: JobRow, fromNode: string): { graph: CanvasGraph; question: string; vars: Record<string, string>; checkpoint: Checkpoint } {
  const snap = runSnapshot(j.run_id, j.owner_id);
  if (!snap) throw Object.assign(new Error('The run of this job is gone'), { statusCode: 404 });
  if (snap.status === 'running' || snap.status === 'paused') throw Object.assign(new Error('The job is still running'), { statusCode: 409 });
  const start = snap.events.find((e) => e.type === 'run_start');
  const graph = start?.graph as CanvasGraph | undefined;
  if (!graph) throw Object.assign(new Error('The run of this job has no workflow to start again'), { statusCode: 409 });
  if (!graph.nodes.some((n) => n.id === fromNode)) throw Object.assign(new Error(`There is no block "${fromNode}" in this job`), { statusCode: 400 });
  // fromNode and every block downstream of it run again.
  const again = new Set([fromNode]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of graph.edges) if (again.has(e.source) && !again.has(e.target)) (again.add(e.target), (grew = true));
  }
  const outputs: Record<string, string> = {};
  for (const e of snap.events) if (e.type === 'node_done' && e.nodeId && !again.has(e.nodeId) && e.text !== undefined) outputs[e.nodeId] = e.text;
  const vars = (db.prepare('SELECT vars FROM runs WHERE id = ?').get(j.run_id) as { vars: string | null } | undefined)?.vars;
  return { graph, question: start?.question ?? '', vars: vars ? (JSON.parse(vars) as Record<string, string>) : {}, checkpoint: { outputs, failed: [], skipped: [], blocked: [], loops: {} } };
}

export const moveJob = (id: string, runId: string) => db.prepare('UPDATE robot_jobs SET run_id = ?, seen = 0 WHERE id = ?').run(runId, id);
