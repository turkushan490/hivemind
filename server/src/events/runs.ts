import type { CanvasGraph, RunEvent, RunStatus } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { runGraph, type EngineDeps } from '../engine/run.js';
import type { ChatContext } from '../nodes/index.js';
import { logError } from '../errors.js';
import { memoryFor } from '../services/memory.js';
import { webSearch } from '../services/search.js';
import { kindOf, writeUnique } from '../services/files.js';
import { homeAssistantConnection } from '../services/homeassistant.js';

type Listener = (ev: RunEvent) => void;

interface LiveRun {
  id: string;
  ownerId: string;
  events: RunEvent[];
  listeners: Set<Listener>;
  abort: AbortController;
  finished: boolean;
}

/** Active runs live in memory (event bus); finished runs are stored with all events for replay. */
const live = new Map<string, LiveRun>();

export function startRun(opts: {
  ownerId: string;
  canvasId?: string;
  graph: CanvasGraph;
  question: string;
  /** Named values for {{vars.name}} (already checked with checkVars). */
  vars?: Record<string, string>;
  /** /v1 conversations: system messages and earlier turns ({{system}}, {{history}}). */
  chat?: ChatContext;
  resolve: EngineDeps['resolve'];
  freeGpu?: (hostKey: string, exceptProviderId?: string) => Promise<void>;
}): string {
  const id = newId();
  const run: LiveRun = { id, ownerId: opts.ownerId, events: [], listeners: new Set(), abort: new AbortController(), finished: false };
  live.set(id, run);
  db.prepare("INSERT INTO runs (id, owner_id, canvas_id, question, status, vars) VALUES (?, ?, ?, ?, 'running', ?)").run(
    id,
    opts.ownerId,
    opts.canvasId ?? null,
    opts.question,
    opts.vars && Object.keys(opts.vars).length ? JSON.stringify(opts.vars) : null,
  );

  const emit: EngineDeps['emit'] = (partial) => {
    const ev = { ...partial, runId: id, seq: run.events.length, ts: Date.now() } as RunEvent;
    run.events.push(ev);
    // "All inputs failed" only follows an earlier error, so it isn't logged twice.
    if (ev.type === 'error' && ev.error !== 'Cancelled' && ev.error !== 'All inputs failed') {
      const node = ev.nodeId ? opts.graph.nodes.find((n) => n.id === ev.nodeId) : undefined;
      const name = node?.label || node?.type;
      const where = node ? `${name}${ev.model && ev.model !== name ? ` (${ev.model})` : ''}: ` : '';
      logError({ source: 'run', message: `${where}${ev.error}`, userId: opts.ownerId, runId: id });
    }
    for (const l of run.listeners) l(ev);
  };

  runGraph(opts.graph, opts.question, {
      resolve: opts.resolve,
      emit,
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
        memory: memoryFor(opts.ownerId),
        saveFile: (path, data) => {
          const saved = writeUnique(path, data);
          return { path: saved, kind: kindOf(saved) };
        },
        freeGpu: opts.freeGpu,
        homeAssistant: homeAssistantConnection,
      },
    }, run.abort.signal, opts.vars ?? {}, opts.chat)
    .then((r) => finish(run, r.status, r.final, r.cost))
    .catch((err) => {
      emit({ type: 'error', error: (err as Error).message });
      emit({ type: 'run_done', status: 'error' });
      finish(run, 'error');
    });
  return id;
}

function finish(run: LiveRun, status: RunStatus, final?: string, cost?: number) {
  run.finished = true;
  db.prepare("UPDATE runs SET status = ?, final = ?, cost = ?, finished_at = datetime('now'), events = ? WHERE id = ?").run(
    status,
    final ?? null,
    cost ?? null,
    JSON.stringify(run.events),
    run.id,
  );
  for (const l of run.listeners) l({ type: 'run_done', runId: run.id, seq: -1, ts: Date.now(), status } as RunEvent);
  run.listeners.clear();
  // Keep briefly so late subscribers still get the stream from memory.
  setTimeout(() => live.delete(run.id), 60_000).unref();
}

/**
 * Sends every past event, then live ones until the run ends. Returns an unsubscribe function.
 * Works for finished runs too (replay from the database).
 */
export function subscribe(runId: string, ownerId: string, onEvent: Listener, onEnd: () => void): (() => void) | undefined {
  const run = live.get(runId);
  if (run && run.ownerId === ownerId) {
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
    return () => run.listeners.delete(l);
  }
  const row = db.prepare('SELECT events FROM runs WHERE id = ? AND owner_id = ?').get(runId, ownerId) as { events: string | null } | undefined;
  if (!row) return;
  (JSON.parse(row.events ?? '[]') as RunEvent[]).forEach(onEvent);
  onEnd();
  return () => {};
}

export function cancelRun(runId: string, ownerId: string): boolean {
  const run = live.get(runId);
  if (!run || run.ownerId !== ownerId || run.finished) return false;
  run.abort.abort();
  return true;
}
