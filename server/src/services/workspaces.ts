// H20: workflows the HiveBot characters make, change, run and delete themselves — only in their own folder
// ("HiveBot · Ultron workspace") with ids "hivebot-ws-ultron-…". A workspace workflow that wasn't run for ttlDays
// (default 7) is deleted by itself (logged).
import type { CanvasGraph } from '@hivemind/shared';
import { db } from '../db/index.js';
import { validateGraph } from '../engine/graph.js';
import { logError } from '../errors.js';
import { appendLog } from '../logfile.js';

const err = (message: string) => new Error(message);

/** "ultron" → its folder and the id prefix its workflows must use. */
export function workspaceOf(character: string): { name: string; folder: string; prefix: string } {
  const name = character.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!name) throw err('workflow: no character (send vars.character, or set the workspace on the block)');
  return { name, folder: `HiveBot · ${name[0].toUpperCase()}${name.slice(1)} workspace`, prefix: `hivebot-ws-${name}-` };
}

/** A graph from text a model wrote: plain JSON or a ```json block; {nodes, edges} or {graph: {nodes, edges}}. */
export function graphFrom(text: string): CanvasGraph {
  const m = /```(?:json)?[^\n]*\n([\s\S]*?)```/.exec(text);
  let j: unknown;
  try {
    j = JSON.parse((m ? m[1] : text).trim());
  } catch (e) {
    throw err(`The graph is not valid JSON: ${(e as Error).message}`);
  }
  const g = (j as { graph?: unknown }).graph ?? j;
  const graph = g as CanvasGraph;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw err('The graph needs "nodes" and "edges" arrays');
  // Positions are optional for a model: lay them out left to right.
  graph.nodes = graph.nodes.map((n, i) => ({ ...n, config: n.config ?? {}, position: n.position ?? { x: i * 300, y: 0 } }));
  graph.edges = graph.edges.map((e, i) => ({ ...e, id: e.id ?? `e${i + 1}` }));
  return graph;
}

/**
 * Everything wrong with a graph, as lines a model can fix: the engine's own checks, an Output, no loops, and
 * models that this owner has (provider enabled).
 */
export function graphProblems(graph: CanvasGraph, ownerId: string): string[] {
  const problems: string[] = [];
  try {
    validateGraph(graph);
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (graph.nodes.filter((n) => n.type === 'input').length > 1) problems.push('Use exactly one input block');
  if (!graph.nodes.some((n) => n.type === 'output')) problems.push('Add an output block (type "output") at the end');
  const providers = new Set(
    (db.prepare('SELECT id FROM providers WHERE enabled = 1 AND (owner_id IS NULL OR owner_id = ?)').all(ownerId) as { id: string }[]).map((r) => r.id),
  );
  for (const n of graph.nodes) {
    for (const m of [n.config?.model, ...(n.config?.models ?? [])]) {
      if (m?.providerId && !providers.has(m.providerId)) problems.push(`"${n.label ?? n.id}": there is no AI provider "${m.providerId}" here`);
    }
  }
  return [...new Set(problems)];
}

export interface WorkspaceCanvas {
  id: string;
  name: string;
  updatedAt: string;
  ttlDays: number;
  lastRun?: { at: string; status: string };
  sizeBytes: number;
}

/** The workflows in a character's workspace, with their last run (for the characters' nightly check). */
export function listWorkspace(ownerId: string, character: string): WorkspaceCanvas[] {
  const ws = workspaceOf(character);
  const rows = db
    .prepare('SELECT id, name, updated_at, ttl_days, length(graph) AS size FROM canvases WHERE owner_id = ? AND id LIKE ? ORDER BY updated_at DESC')
    .all(ownerId, `${ws.prefix}%`) as { id: string; name: string; updated_at: string; ttl_days: number | null; size: number }[];
  return rows.map((r) => {
    const last = db.prepare('SELECT started_at, status FROM runs WHERE canvas_id = ? ORDER BY started_at DESC LIMIT 1').get(r.id) as { started_at: string; status: string } | undefined;
    return { id: r.id, name: r.name, updatedAt: r.updated_at, ttlDays: r.ttl_days ?? 7, sizeBytes: r.size, ...(last && { lastRun: { at: last.started_at, status: last.status } }) };
  });
}

/** Checks that this id belongs to the character's workspace. */
export function checkId(character: string, id: string): string {
  const ws = workspaceOf(character);
  const clean = id.trim().toLowerCase();
  if (!clean.startsWith(ws.prefix)) throw err(`workflow: ${ws.name} may only use ids starting with "${ws.prefix}" (got "${id}")`);
  if (!/^[a-z0-9-]{1,80}$/.test(clean)) throw err('workflow: the id may only have letters, digits and -');
  return clean;
}

/** Creates or updates a workspace workflow; returns the problems instead when the graph is not right. */
export function saveWorkspace(
  ownerId: string,
  character: string,
  o: { id: string; name?: string; graph: CanvasGraph; ttlDays?: number; create: boolean },
): { ok: true; id: string } | { ok: false; problems: string[] } {
  const ws = workspaceOf(character);
  const id = checkId(character, o.id);
  const existing = db.prepare('SELECT owner_id FROM canvases WHERE id = ?').get(id) as { owner_id: string } | undefined;
  if (existing && existing.owner_id !== ownerId) throw err(`workflow: ${id} belongs to someone else`);
  if (o.create && existing) throw err(`workflow: ${id} already exists (use update)`);
  if (!o.create && !existing) throw err(`workflow: there is no ${id} to update (use create)`);
  const problems = graphProblems(o.graph, ownerId);
  if (problems.length) return { ok: false, problems };
  const ttl = Math.min(365, Math.max(1, Math.round(o.ttlDays ?? 7)));
  db.prepare(
    `INSERT INTO canvases (id, owner_id, name, graph, folder, managed_by, ttl_days, updated_at) VALUES (?, ?, ?, ?, ?, 'hivebot', ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, graph = excluded.graph, folder = excluded.folder, ttl_days = excluded.ttl_days, updated_at = excluded.updated_at`,
  ).run(id, ownerId, (o.name?.trim() || id).slice(0, 120), JSON.stringify(o.graph), ws.folder, ttl);
  appendLog('server', `Workspace: ${ws.name} ${o.create ? 'made' : 'changed'} ${id}`);
  return { ok: true, id };
}

export function deleteWorkspace(ownerId: string, character: string, id: string): boolean {
  const clean = checkId(character, id);
  const r = db.prepare('DELETE FROM canvases WHERE id = ? AND owner_id = ?').run(clean, ownerId);
  if (r.changes) appendLog('server', `Workspace: ${workspaceOf(character).name} deleted ${clean}`);
  return r.changes > 0;
}

/** Deletes workspace workflows nobody ran (or changed) for their ttlDays. Returns how many. */
export function sweepWorkspaces(now = Date.now()): number {
  const rows = db.prepare("SELECT id, owner_id, name, updated_at, ttl_days FROM canvases WHERE id LIKE 'hivebot-ws-%'").all() as {
    id: string;
    owner_id: string;
    name: string;
    updated_at: string;
    ttl_days: number | null;
  }[];
  let n = 0;
  for (const r of rows) {
    const last = db.prepare('SELECT MAX(started_at) AS at FROM runs WHERE canvas_id = ?').get(r.id) as { at: string | null };
    const used = Math.max(Date.parse(`${r.updated_at}Z`), last.at ? Date.parse(`${last.at}Z`) : 0);
    if (now - used > (r.ttl_days ?? 7) * 86_400_000) {
      db.prepare('DELETE FROM canvases WHERE id = ?').run(r.id);
      appendLog('server', `Workspace: deleted ${r.id} ("${r.name}"), not used for ${r.ttl_days ?? 7} days`);
      n++;
    }
  }
  return n;
}

let timer: NodeJS.Timeout | undefined;
/** Once an hour. */
export function startWorkspaceSweeper() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweepWorkspaces();
    } catch (e) {
      logError({ source: 'server', message: `Workspace clean-up failed: ${(e as Error).message}` });
    }
  }, 3600_000);
  timer.unref();
}
