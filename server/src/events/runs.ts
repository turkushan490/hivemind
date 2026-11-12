import type { ActiveBlock, ActiveRun, CanvasGraph, PauseAction, PauseInfo, ResumeRequest, RunEvent, RunStatus } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { cancelText, clampPriority, hostHolder, runGraph, type Checkpoint, type EngineDeps } from '../engine/run.js';
import { runLimits } from '../services/runLimits.js';
import type { ChatContext, NodeServices } from '../nodes/index.js';
import { logError } from '../errors.js';
import { memoryFor } from '../services/memory.js';
import type { User } from '../api/auth.js';
import { scopedMemory } from '../api/scope.js';
import { readPage, webSearch } from '../services/search.js';
import { kindOf, readOwnFile, writeUnique } from '../services/files.js';
import { allowedFor, checkGraph, type Access } from '../services/access.js';
import { homeAssistantConnection } from '../services/homeassistant.js';
import { projectServicesFor } from '../services/projectRun.js';
import { skillsForRun } from '../services/skills.js';
import { voiceServicesFor } from '../services/voiceRun.js';
import * as memFiles from '../services/memoryFiles.js';

type Listener = (ev: RunEvent) => void;

/** How a run that may go on after a restart was started. */
export interface ResumeMeta {
  userId: string;
  providerUserId: string;
  graph: CanvasGraph;
  canvasId?: string;
  question: string;
  vars: Record<string, string>;
  source: string;
  /** GPU priority (1 = first … 200), so a run picked up after a restart keeps its place in the queue. */
  priority?: number;
}

/** runs.checkpoint: how it was started, how far it got, and its events so far. */
export interface StoredCheckpoint {
  meta: ResumeMeta;
  state: Checkpoint;
  events: RunEvent[];
}

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
  /** GPU priority (1 = first … 200): which waiting run takes the GPU next. */
  priority: number;
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
  /** Pause blocks waiting for a person, by node id. */
  pauses: Map<string, { info: PauseInfo; answer: (r: { action: PauseAction; text?: string; comment?: string }) => void }>;
  /** Stops the run-time clock while a Pause waits (and starts it again after). */
  clock?: { pause(): void; resume(): void };
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
  /**
   * This run may go on after a restart (runs of a saved or sent workflow, not /v1 chats): who runs it and whose AI
   * providers it uses, so it can be started again the same way.
   */
  resumable?: { userId: string; providerUserId: string };
  /** Go on with a run that a restart stopped: its id, what its blocks had done, and its events so far. */
  resume?: { runId: string; checkpoint: Checkpoint; events: RunEvent[]; startedAt: number };
  /** Minutes the run may take (background jobs: 60); default RUN_TIMEOUT_MINUTES. */
  timeLimitMin?: number;
  /** A new run that keeps these block outputs and runs the rest (a background job started again from a block). */
  startFrom?: Checkpoint;
  /** GPU priority (1 = first … 200, default 100): a lower number takes a shared GPU before a higher one. */
  priority?: number;
}): string {
  const access = opts.access ?? (opts.user ? allowedFor(opts.user) : undefined);
  const priority = clampPriority(opts.priority);
  if (access) checkGraph(opts.graph, access);
  // Files: what the run saves belongs to whoever runs it; it reads only their files (an admin's: all).
  const fileUser = opts.user ?? { id: opts.ownerId, role: 'user' as const };
  const id = opts.resume?.runId ?? newId();
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
    startedAt: opts.resume?.startedAt ?? Date.now(),
    question: opts.question,
    priority,
    events: opts.resume?.events ?? [],
    listeners: new Set(),
    abort: new AbortController(),
    finished: false,
    blocks: new Map(),
    ended,
    end,
    pauses: new Map(),
    ...(opts.cancelWhenAlone && { alone: { followers: 0 } }),
  };
  live.set(id, run);
  // What it takes to start this run again after a restart; its progress is added as blocks finish.
  const meta: ResumeMeta | undefined = opts.resumable && !opts.cancelWhenAlone && !opts.chat
    ? { ...opts.resumable, graph: opts.graph, canvasId: opts.canvasId, question: opts.question, vars: opts.vars ?? {}, source, priority }
    : undefined;
  if (opts.resume) {
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(id);
  } else {
    db.prepare("INSERT INTO runs (id, owner_id, canvas_id, question, status, vars, source, priority) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)").run(
      id,
      opts.ownerId,
      opts.canvasId ?? null,
      opts.question,
      opts.vars && Object.keys(opts.vars).length ? JSON.stringify(opts.vars) : null,
      source,
      priority,
    );
  }
  const saveCheckpoint = (cp: Checkpoint) => {
    if (!meta || run.finished) return;
    // Live tokens and thinking are left out: the finished blocks' own events carry their text.
    const events = run.events.filter((e) => e.type !== 'token' && e.type !== 'thinking');
    db.prepare('UPDATE runs SET checkpoint = ? WHERE id = ?').run(JSON.stringify({ meta, state: cp, events } satisfies StoredCheckpoint), id);
  };
  if (meta && !opts.resume) saveCheckpoint({ outputs: {}, failed: [], skipped: [], blocked: [], loops: {} });
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

  // A run that hangs (a server that never answers) is stopped, so it can't hold the GPU forever. Time spent
  // waiting at a Pause block doesn't count.
  const limitMin = opts.timeLimitMin ?? (Number(process.env.RUN_TIMEOUT_MINUTES) || 30);
  let left = limitMin * 60_000;
  let since = Date.now();
  let limit: NodeJS.Timeout | undefined;
  const arm = () => {
    since = Date.now();
    limit = setTimeout(() => {
      if (run.finished) return;
      emit({ type: 'error', error: `Run stopped: it took longer than ${limitMin} minutes (RUN_TIMEOUT_MINUTES)` });
      run.abort.abort();
    }, Math.max(0, left));
    limit.unref();
  };
  arm();
  run.clock = {
    pause: () => {
      clearTimeout(limit);
      left -= Date.now() - since;
    },
    resume: () => {
      if (!run.finished && !run.abort.signal.aborted) arm();
    },
  };
  run.abort.signal.addEventListener('abort', () => clearTimeout(limit), { once: true });

  runGraph(opts.graph, opts.question, {
      resolve: opts.resolve,
      emit,
      limits: runLimits(),
      // Loaded on demand: api/providers imports this module.
      pictureReader: () => import('../api/providers.js').then((m) => m.pictureReaderFor(fileUser as Parameters<typeof m.pictureReaderFor>[0])),
      ...(opts.resume && { resume: opts.resume.checkpoint }),
      ...(opts.startFrom && !opts.resume && { resume: opts.startFrom, startFrom: true }),
      save: saveCheckpoint,
      lockLabel: source.includes(': ') ? source.slice(source.indexOf(': ') + 2) : (canvasName ?? source),
      priority,
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
        readPage,
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
        // Projects: the runner's own. Not for limited API tokens, except a robot's own token — the robot starts its
        // own project jobs (build/fix a HiveMind project by voice) when the PC app is off (H7).
        ...((!opts.user?.scope || opts.user.scope.robot) && { projects: projectServicesFor(fileUser, { id, source: canvasName ? `Run: ${canvasName}` : `Run: ${source}` }) }),
        // Memory as MD files (H11): the owner's memory, for readMemory / writeMemory. The robot's own token may use it too.
        ...((!opts.user?.scope || opts.user.scope.robot) && {
          memoryFiles: {
            tree: (guest?: boolean) => memFiles.tree(opts.ownerId, guest).map((f) => ({ path: f.path, title: f.title })),
            read: (paths: string[], guest?: boolean) => memFiles.read(opts.ownerId, paths, guest),
            write: (path: string, text: string, o?: { mode?: 'replace' | 'append'; by?: string; guest?: boolean }) => void memFiles.write(opts.ownerId, path, text, o),
            move: (from: string, to: string, by?: string, guest?: boolean) => memFiles.move(opts.ownerId, from, to, by, guest),
          },
          // runWorkflow (H12): start another canvas as a background job, for the owner / robot.
          runCanvas: async (o: { canvas: string; question: string; priority?: number; title?: string; character?: string }) => {
            const runsApi = await import('../api/runs.js');
            const providers = await import('../api/providers.js');
            const jobs = await import('../services/robotJobs.js');
            const u: User = opts.user ?? { id: opts.ownerId, username: 'owner', role: 'admin' };
            const row = runsApi.canvasFor(u, o.canvas) ?? runsApi.canvasesFor(u).find((r) => r.name === o.canvas);
            if (!row) throw new Error(`No canvas "${o.canvas}"`);
            const bgRunId = startRun({
              ownerId: u.id,
              user: u,
              canvasId: row.id,
              graph: JSON.parse(row.graph) as CanvasGraph,
              question: o.question || 'Go',
              vars: o.character ? { character: o.character } : undefined,
              resolve: providers.resolverFor(u),
              freeGpu: providers.gpuFreerFor(u),
              training: providers.trainingFor(u),
              source: '/v1',
              priority: o.priority ?? 100,
              timeLimitMin: 60,
              resumable: { userId: u.id, providerUserId: u.id },
            });
            const jobId = jobs.createJob({ runId: bgRunId, ownerId: u.id, robotId: u.scope?.robot, canvasId: row.id, character: o.character, title: o.title || o.question.slice(0, 80) || row.name });
            return { jobId, runId: bgRunId, title: o.title || row.name };
          },
        }),
        pause: { wait: (info, signal) => waitAtPause(run, info, emit, signal) },
        skills: skillsForRun(fileUser),
        // Voice blocks: the person who runs it (not viewers, not limited API tokens).
        ...(!opts.user?.scope && fileUser.role !== 'viewer' && { voice: voiceServicesFor(fileUser) }),
        logProblem: (message) => logError({ source: 'run', message, userId: opts.ownerId, runId: id }),
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
  run.pauses.clear();
  run.blocks.clear();
  if (run.alone?.timer) clearTimeout(run.alone.timer);
  db.prepare("UPDATE runs SET status = ?, final = ?, cost = ?, finished_at = datetime('now'), events = ?, checkpoint = NULL WHERE id = ?").run(
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
    // A run waiting at a Pause waits for a person, not a client: the clock starts again when it goes on.
    if (run.pauses.size) return;
    if (!run.finished && a.followers === 0) run.abort.abort(`Stopped: nobody followed the run for ${Math.round(runTiming.aloneMs / 1000)} seconds`);
  }, runTiming.aloneMs);
  a.timer.unref();
}

/**
 * A Pause block waits here until the run's owner (or an admin) answers, the block's time runs out, or the run is
 * stopped. While any Pause waits, the run is "paused": its time limit and cancelWhenAlone clock stand still.
 */
function waitAtPause(run: LiveRun, info: PauseInfo, emit: EngineDeps['emit'], signal?: AbortSignal): Promise<{ action: PauseAction; text?: string; comment?: string }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      run.pauses.delete(info.nodeId);
      if (!run.pauses.size) {
        run.clock?.resume();
        if (!run.finished) db.prepare("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'paused'").run(run.id);
        if (run.alone && run.alone.followers === 0 && !run.finished) watchAlone(run);
      }
    };
    const onAbort = () => {
      done();
      reject(new Error(signal ? cancelText(signal) : 'Cancelled'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (!run.pauses.size) {
      run.clock?.pause();
      db.prepare("UPDATE runs SET status = 'paused' WHERE id = ? AND status = 'running'").run(run.id);
    }
    run.pauses.set(info.nodeId, {
      info,
      answer: (r) => {
        done();
        emit({ type: 'resumed', nodeId: info.nodeId, nodeType: 'pause', action: r.action });
        resolve(r);
      },
    });
    emit({ type: 'paused', nodeId: info.nodeId, nodeType: 'pause', pause: info });
    if (info.timeoutAt) {
      timer = setTimeout(() => run.pauses.get(info.nodeId)?.answer({ action: info.onTimeout ?? 'continue', comment: 'Nobody answered in time' }), Math.max(0, info.timeoutAt - Date.now()));
      timer.unref();
    }
  });
}

/**
 * Answers a waiting Pause block: the run's owner, or a full admin, may (anyone else: false, a 404). Stop also
 * stops the run.
 */
export function resumeRun(runId: string, who: Pick<User, 'id' | 'role' | 'scope'>, body: ResumeRequest & { nodeId?: string }): boolean {
  const run = live.get(runId);
  if (!run || run.finished || (run.ownerId !== who.id && !isFullAdmin(who))) return false;
  const pause = body.nodeId ? run.pauses.get(body.nodeId) : run.pauses.values().next().value;
  if (!pause) return false;
  const action: PauseAction = body.action === 'reject' || body.action === 'stop' ? body.action : 'continue';
  pause.answer({
    action,
    ...(action === 'continue' && typeof body.text === 'string' && { text: body.text.slice(0, 1_000_000) }),
    ...(action === 'reject' && typeof body.comment === 'string' && { comment: body.comment.slice(0, 10_000) }),
  });
  if (action === 'stop') run.abort.abort('Stopped at a Pause');
  return true;
}

/** A full admin (not a limited token) may see and stop every run. */
export const isFullAdmin = (user: Pick<User, 'role' | 'scope'>) => user.role === 'admin' && !user.scope;

/** How many runs are going right now (night work waits until the GPU is quiet). */
export const liveRunCount = () => [...live.values()].filter((r) => !r.finished).length;

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
      priority: r.priority,
      question: r.question.slice(0, 200),
      ...(r.pauses.size && { paused: [...r.pauses.values()].map((p) => p.info) }),
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
  const rows = db.prepare("SELECT id, events FROM runs WHERE status IN ('running', 'paused') AND checkpoint IS NULL").all() as { id: string; events: string | null }[];
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

/** Runs a restart stopped that can go on (their checkpoint), oldest first. */
export function stoppedRuns(): { id: string; ownerId: string; startedAt: string; cp: StoredCheckpoint }[] {
  const rows = db.prepare("SELECT id, owner_id, started_at, checkpoint FROM runs WHERE status IN ('running', 'paused') AND checkpoint IS NOT NULL ORDER BY started_at").all() as {
    id: string;
    owner_id: string;
    started_at: string;
    checkpoint: string;
  }[];
  const out: { id: string; ownerId: string; startedAt: string; cp: StoredCheckpoint }[] = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, ownerId: r.owner_id, startedAt: r.started_at, cp: JSON.parse(r.checkpoint) as StoredCheckpoint });
    } catch {
      giveUp(r.id, 'Stopped by a restart');
    }
  }
  return out;
}

/** Closes a stopped run that can't go on, the way closeStaleRuns does. */
export function giveUp(runId: string, why: string) {
  const row = db.prepare('SELECT events, checkpoint FROM runs WHERE id = ?').get(runId) as { events: string | null; checkpoint: string | null } | undefined;
  if (!row) return;
  let events: RunEvent[] = [];
  try {
    events = (JSON.parse(row.checkpoint ?? 'null') as StoredCheckpoint | null)?.events ?? (JSON.parse(row.events ?? '[]') as RunEvent[]);
  } catch {}
  const now = Date.now();
  events.push({ type: 'error', runId, seq: events.length, ts: now, error: why } as RunEvent);
  events.push({ type: 'run_done', runId, seq: events.length, ts: now, status: 'error' } as RunEvent);
  db.prepare("UPDATE runs SET status = 'error', finished_at = datetime('now'), events = ?, checkpoint = NULL WHERE id = ?").run(JSON.stringify(events), runId);
}

/** A run as it is now: live (its events so far) or stored. Undefined when it isn't this owner's. */
export function runSnapshot(runId: string, ownerId: string): { status: string; events: RunEvent[]; final?: string; startedAt: number } | undefined {
  const r = live.get(runId);
  if (r && r.ownerId === ownerId) return { status: r.finished ? 'done' : 'running', events: r.events, startedAt: r.startedAt };
  const row = db.prepare('SELECT status, final, events, started_at FROM runs WHERE id = ? AND owner_id = ?').get(runId, ownerId) as
    | { status: string; final: string | null; events: string | null; started_at: string }
    | undefined;
  if (!row) return undefined;
  return { status: row.status, events: JSON.parse(row.events ?? '[]') as RunEvent[], ...(row.final !== null && { final: row.final }), startedAt: Date.parse(`${row.started_at.replace(' ', 'T')}Z`) };
}
