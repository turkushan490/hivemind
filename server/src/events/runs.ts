import type { ActiveBlock, ActiveRun, CanvasGraph, RunEvent, RunStatus } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { cancelText, hostHolder, runGraph, type EngineDeps } from '../engine/run.js';
import { runLimits } from '../services/runLimits.js';
import type { ChatContext, NodeServices } from '../nodes/index.js';
import { logError } from '../errors.js';
import { memoryFor } from '../services/memory.js';
import type { User } from '../api/auth.js';
import { scopedMemory } from '../api/scope.js';
import { webSearch } from '../services/search.js';
import { kindOf, readOwnFile, writeUnique } from '../services/files.js';
import { allowedFor, checkGraph, type Access } from '../services/access.js';
import { homeAssistantConnection } from '../services/homeassistant.js';

type Listener = (ev: RunEvent) => void;

/** A block of a live run that waits for or uses a model (Activity page, Unload). */
interface LiveBlock {
  nodeId: string;
  label: string;
  providerId?: string;
  model?: string;
  state: 'waiting' | 'running';
  startedAt: number;
  tokens: number;
  /** Thinking pieces so far (a looping thinking model writes only these). */
  thinking: number;
  /** The GPU it waits for (to show who holds it). */
  hostKey?: string;
}

interface LiveRun {
  id: string;
  ownerId: string;
  canvasId?: string;
  canvasName?: string;
  source: string;
  startedAt: number;
  question: string;
  events: RunEvent[];
  listeners: Set<Listener>;
  abort: AbortController;
  finished: boolean;
  /** Blocks in progress, by node id. */
  blocks: Map<string, LiveBlock>;
  /** cancelWhenAlone: how many follow /api/runs/:id/events, and the timer that cancels the run when nobody does. */
  alone?: { followers: number; timer?: NodeJS.Timeout };
  /** Resolves when the run is stored. */
  ended: Promise<void>;
  end: () => void;
}

/** Active runs live in memory (event bus); finished runs are stored with all events for replay. */
const live = new Map<string, LiveRun>();

/** How long a cancelWhenAlone run may go on with nobody following it (tests make it short). */
export const runTiming = { aloneMs: 30_000 };

export function startRun(opts: {
  ownerId: string;
  /** Who started it; a limited API token only reaches its own memory keys. */
  user?: User;
  canvasId?: string;
  graph: CanvasGraph;
  question: string;
  /** Named values for {{vars.name}} (already checked with checkVars). */
  vars?: Record<string, string>;
  /** /v1 conversations: system messages and earlier turns ({{system}}, {{history}}). */
  chat?: ChatContext;
  resolve: EngineDeps['resolve'];
  freeGpu?: (hostKey: string, exceptProviderId?: string) => Promise<void>;
  /** Training blocks' services (datasets, training jobs, deploy); left out for viewers and limited tokens. */
  training?: NodeServices['training'];
  /** Who or what started it: "Screen", "API: <token>", "/v1: <token>", "Schedule", "Batch". */
  source?: string;
  /** Cancel the run when nobody has followed its events for 30 seconds. */
  cancelWhenAlone?: boolean;
  /**
   * Settings → Access: what may be used; default what `user` may use. Always the caller's, also when a shared
   * canvas runs with its owner's providers. Checked here before the run starts (403), and on every model call.
   */
  access?: Access;
}): string {
  const access = opts.access ?? (opts.user ? allowedFor(opts.user) : undefined);
  if (access) checkGraph(opts.graph, access);
  // Files: what the run saves belongs to whoever runs it; it reads only their files (an admin's: all).
  const fileUser = opts.user ?? { id: opts.ownerId, role: 'user' as const };
  const id = newId();
  const source = opts.source ?? 'Screen';
  const canvasName = opts.canvasId
    ? (db.prepare('SELECT name FROM canvases WHERE id = ?').get(opts.canvasId) as { name: string } | undefined)?.name
    : undefined;
  let end!: () => void;
  const ended = new Promise<void>((r) => (end = r));
  const run: LiveRun = {
    id,
    ownerId: opts.ownerId,
    canvasId: opts.canvasId,
    canvasName,
    source,
    startedAt: Date.now(),
    question: opts.question,
    events: [],
    listeners: new Set(),
    abort: new AbortController(),
    finished: false,
    blocks: new Map(),
    ended,
    end,
    ...(opts.cancelWhenAlone && { alone: { followers: 0 } }),
  };
  live.set(id, run);
  db.prepare("INSERT INTO runs (id, owner_id, canvas_id, question, status, vars, source) VALUES (?, ?, ?, ?, 'running', ?, ?)").run(
    id,
    opts.ownerId,
    opts.canvasId ?? null,
    opts.question,
    opts.vars && Object.keys(opts.vars).length ? JSON.stringify(opts.vars) : null,
    source,
  );
  // The client may never connect at all: the clock runs from the start.
  if (run.alone) watchAlone(run);

  const nodeOf = (nodeId?: string) => (nodeId ? opts.graph.nodes.find((n) => n.id === nodeId) : undefined);
  /** Blocks in progress, from the run's own events. */
  const track = (ev: RunEvent) => {
    if (!ev.nodeId) return;
    const b = run.blocks.get(ev.nodeId);
    if (ev.type === 'node_queued' || ev.type === 'node_start') {
      const node = nodeOf(ev.nodeId);
      const ref = node?.config.model ?? node?.config.models?.[0];
      if (!node || !ref) return;
      const block: LiveBlock = b ?? {
        nodeId: ev.nodeId,
        label: node.label || ref.model || node.type,
        providerId: ref.providerId,
        model: ref.model,
        state: 'waiting',
        startedAt: ev.ts,
        tokens: 0,
        thinking: 0,
      };
      if (ev.type === 'node_start') {
        block.state = 'running';
        block.startedAt = ev.ts;
      } else {
        opts.resolve(ref.providerId).then((p) => (block.hostKey = p.hostKey), () => {});
      }
      run.blocks.set(ev.nodeId, block);
    } else if (!b) {
      return;
    } else if (ev.type === 'token' || ev.type === 'thinking') {
      if (ev.model) b.model = ev.model;
      if (ev.type === 'thinking') b.thinking++;
      else b.tokens = ev.tokens ?? b.tokens + 1;
    } else if (ev.type === 'model_loading' && ev.model) {
      b.model = ev.model;
    } else if (ev.type === 'node_done' || ev.type === 'error' || ev.type === 'node_skipped') {
      run.blocks.delete(ev.nodeId);
    }
  };

  const emit: EngineDeps['emit'] = (partial) => {
    const ev = { ...partial, runId: id, seq: run.events.length, ts: Date.now() } as RunEvent;
    run.events.push(ev);
    track(ev);
    // "All inputs failed" only follows an earlier error, so it isn't logged twice; a cancel (or Unload) is no problem.
    const cancelled = run.abort.signal.aborted && (ev.error === 'Cancelled' || ev.error === cancelText(run.abort.signal));
    if (ev.type === 'error' && !cancelled && ev.error !== 'Cancelled' && ev.error !== 'All inputs failed') {
      const node = ev.nodeId ? opts.graph.nodes.find((n) => n.id === ev.nodeId) : undefined;
      const name = node?.label || node?.type;
      const where = node ? `${name}${ev.model && ev.model !== name ? ` (${ev.model})` : ''}: ` : '';
      logError({ source: 'run', message: `${where}${ev.error}`, userId: opts.ownerId, runId: id });
    }
    for (const l of run.listeners) l(ev);
  };

  // A run that hangs (a server that never answers) is stopped, so it can't hold the GPU forever.
  const limitMin = Number(process.env.RUN_TIMEOUT_MINUTES) || 30;
  const limit = setTimeout(() => {
    if (run.finished) return;
    emit({ type: 'error', error: `Run stopped: it took longer than ${limitMin} minutes (RUN_TIMEOUT_MINUTES)` });
    run.abort.abort();
  }, limitMin * 60_000);
  limit.unref();
  run.abort.signal.addEventListener('abort', () => clearTimeout(limit), { once: true });

  runGraph(opts.graph, opts.question, {
      resolve: opts.resolve,
      emit,
      limits: runLimits(),
      lockLabel: source.includes(': ') ? source.slice(source.indexOf(': ') + 2) : (canvasName ?? source),
      access,
      // Stats: every model call and every Judge/Vote pick, kept even when the run is deleted from History.
      record: {
        usage: (u) =>
          db
            .prepare('INSERT INTO run_usage (run_id, owner_id, node_id, node_type, provider_id, model, input_tokens, output_tokens, cost, gen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, opts.ownerId, u.nodeId, u.nodeType, u.providerId, u.model, u.inputTokens, u.outputTokens, u.cost ?? null, u.genMs ?? null),
        winner: (w) =>
          db
            .prepare('INSERT INTO run_winners (run_id, owner_id, node_id, node_type, winner_node, winner_label, winner_model, contenders) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, opts.ownerId, w.nodeId, w.nodeType, w.winnerNodeId, w.winnerLabel, w.winnerModel ?? null, JSON.stringify(w.contenders)),
      },
      services: {
        search: webSearch,
        memory: opts.user ? scopedMemory(memoryFor(opts.ownerId), opts.user) : memoryFor(opts.ownerId),
        saveFile: (path, data) => {
          const saved = writeUnique(path, data, opts.ownerId);
          return { path: saved, kind: kindOf(saved) };
        },
        freeGpu: opts.freeGpu,
        homeAssistant: homeAssistantConnection,
        readFile: (path) => readOwnFile(fileUser, path),
        lanAllowed: fileUser.role === 'admin',
        training: opts.training,
      },
    }, run.abort.signal, opts.vars ?? {}, opts.chat)
    .then((r) => {
      clearTimeout(limit);
      finish(run, r.status, r.final, r.cost);
    })
    .catch((err) => {
      clearTimeout(limit);
      emit({ type: 'error', error: (err as Error).message });
      emit({ type: 'run_done', status: 'error' });
      finish(run, 'error');
    });
  return id;
}

function finish(run: LiveRun, status: RunStatus, final?: string, cost?: number) {
  run.finished = true;
  run.blocks.clear();
  if (run.alone?.timer) clearTimeout(run.alone.timer);
  db.prepare("UPDATE runs SET status = ?, final = ?, cost = ?, finished_at = datetime('now'), events = ? WHERE id = ?").run(
    status,
    final ?? null,
    cost ?? null,
    JSON.stringify(run.events),
    run.id,
  );
  for (const l of run.listeners) l({ type: 'run_done', runId: run.id, seq: -1, ts: Date.now(), status } as RunEvent);
  run.listeners.clear();
  run.end();
  // Keep briefly so late subscribers still get the stream from memory.
  setTimeout(() => live.delete(run.id), 60_000).unref();
}

/** cancelWhenAlone: nobody follows the run now, so it is cancelled unless someone does within 30 seconds. */
function watchAlone(run: LiveRun) {
  const a = run.alone!;
  if (a.timer) clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    if (!run.finished && a.followers === 0) run.abort.abort(`Stopped: nobody followed the run for ${Math.round(runTiming.aloneMs / 1000)} seconds`);
  }, runTiming.aloneMs);
  a.timer.unref();
}

/** A full admin (not a limited token) may see and stop every run. */
export const isFullAdmin = (user: Pick<User, 'role' | 'scope'>) => user.role === 'admin' && !user.scope;

/**
 * Sends every past event, then live ones until the run ends. Returns an unsubscribe function.
 * Works for finished runs too (replay from the database). An admin may follow anyone's live run (Activity).
 */
export function subscribe(runId: string, ownerId: string, onEvent: Listener, onEnd: () => void, opts: { admin?: boolean } = {}): (() => void) | undefined {
  const run = live.get(runId);
  if (run && (run.ownerId === ownerId || opts.admin)) {
    run.events.forEach(onEvent);
    if (run.finished) {
      onEnd();
      return () => {};
    }
    const l: Listener = (ev) => {
      if (ev.seq === -1) return onEnd();
      onEvent(ev);
    };
    run.listeners.add(l);
    const a = run.alone;
    if (a) {
      a.followers++;
      if (a.timer) clearTimeout(a.timer);
      a.timer = undefined;
    }
    let gone = false;
    return () => {
      if (gone) return;
      gone = true;
      run.listeners.delete(l);
      if (a && --a.followers === 0 && !run.finished) watchAlone(run);
    };
  }
  const row = db.prepare('SELECT events FROM runs WHERE id = ? AND owner_id = ?').get(runId, ownerId) as { events: string | null } | undefined;
  if (!row) return;
  (JSON.parse(row.events ?? '[]') as RunEvent[]).forEach(onEvent);
  onEnd();
  return () => {};
}

/**
 * Stops a live run: its owner, or a full admin, may. The reason ("Stopped by Unload") is what the run's blocks
 * show instead of "Cancelled".
 */
export function cancelRun(runId: string, who: string | Pick<User, 'id' | 'role' | 'scope'>, reason?: string): boolean {
  const run = live.get(runId);
  const user = typeof who === 'string' ? { id: who, role: 'user' as const } : who;
  if (!run || run.finished || (run.ownerId !== user.id && !isFullAdmin(user))) return false;
  run.abort.abort(reason);
  return true;
}

/** Waits until a run is stored, at most ms; true when it ended. */
export async function runEnded(runId: string, ms: number): Promise<boolean> {
  const run = live.get(runId);
  if (!run || run.finished) return true;
  let t: NodeJS.Timeout | undefined;
  const ok = await Promise.race([run.ended.then(() => true), new Promise<boolean>((r) => (t = setTimeout(() => r(false), ms)))]);
  clearTimeout(t);
  return ok;
}

/** "llama3" and "llama3:latest" are the same model; "ollama.com/" prefixes are dropped. */
export const sameModel = (a: string, b: string) => {
  const norm = (m: string) => {
    const n = m.trim().replace(/^(?:https?:\/\/)?(?:www\.)?(?:ollama\.com|registry\.ollama\.ai)\//i, '').toLowerCase();
    return n.includes(':') ? n : `${n}:latest`;
  };
  return norm(a) === norm(b);
};

/** Live runs with a block using or waiting for a model on this provider (any model when none is given). */
export function liveRunsUsing(providerId: string, model?: string): { runId: string; ownerId: string; canvasName?: string; state: 'waiting' | 'running'; models: string[] }[] {
  const out: { runId: string; ownerId: string; canvasName?: string; state: 'waiting' | 'running'; models: string[] }[] = [];
  for (const run of live.values()) {
    if (run.finished) continue;
    const blocks = [...run.blocks.values()].filter((b) => b.providerId === providerId && (!model || (b.model && sameModel(b.model, model))));
    if (!blocks.length) continue;
    out.push({
      runId: run.id,
      ownerId: run.ownerId,
      canvasName: run.canvasName,
      state: blocks.some((b) => b.state === 'running') ? 'running' : 'waiting',
      models: [...new Set(blocks.map((b) => b.model!).filter(Boolean))],
    });
  }
  return out;
}

/** GET /api/activity/running: every live run (a full admin) or the user's own. */
export function activeRuns(user: Pick<User, 'id' | 'role' | 'scope'>): ActiveRun[] {
  const all = isFullAdmin(user);
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, (db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined)?.username ?? id);
    return names.get(id)!;
  };
  return [...live.values()]
    .filter((r) => !r.finished && (all || r.ownerId === user.id))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => ({
      runId: r.id,
      canvasId: r.canvasId,
      canvasName: r.canvasName,
      source: r.source,
      owner: nameOf(r.ownerId),
      mine: r.ownerId === user.id,
      startedAt: r.startedAt,
      question: r.question.slice(0, 200),
      blocks: [...r.blocks.values()].map((b): ActiveBlock => {
        const behind = b.state === 'waiting' && b.hostKey ? hostHolder(b.hostKey) : undefined;
        return {
          nodeId: b.nodeId,
          label: b.label,
          providerId: b.providerId,
          model: b.model,
          state: b.state,
          startedAt: b.startedAt,
          tokens: b.tokens + b.thinking,
          ...(behind && { waitingBehind: behind }),
        };
      }),
    }));
}

/**
 * At startup, before requests: runs still marked "running" belonged to the previous process and will never
 * finish. They become errors, with the reason stored in their events.
 */
export function closeStaleRuns(): number {
  const rows = db.prepare("SELECT id, events FROM runs WHERE status = 'running'").all() as { id: string; events: string | null }[];
  const now = Date.now();
  for (const r of rows) {
    let events: RunEvent[] = [];
    try {
      events = JSON.parse(r.events ?? '[]') as RunEvent[];
    } catch {}
    events.push({ type: 'error', runId: r.id, seq: events.length, ts: now, error: 'Stopped by a restart' } as RunEvent);
    events.push({ type: 'run_done', runId: r.id, seq: events.length, ts: now, status: 'error' } as RunEvent);
    db.prepare("UPDATE runs SET status = 'error', finished_at = datetime('now'), events = ? WHERE id = ?").run(JSON.stringify(events), r.id);
  }
  return rows.length;
}
