import type { ActiveRun, ActivityRunning } from '@hivemind/shared';
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { toFlow } from '../canvas/CanvasPage';
import { HiveEdge } from '../canvas/HiveEdge';
import { HiveNode, RunViews, type HiveFlowNode } from '../canvas/HiveNode';
import { Clock, STATE_TEXT, useRun } from '../run/state';

const nodeTypes = { hive: HiveNode };
const edgeTypes = { hive: HiveEdge };
const LIVE = new Set(['loading', 'thinking', 'streaming']);
/** How many cards stay on the page (running ones always; the oldest finished ones drop off first). */
const MAX_CARDS = 12;

interface Card {
  runId: string;
  canvasName?: string;
  source: string;
  owner: string;
  mine: boolean;
  startedAt: number;
  question: string;
  /** When it was no longer in the running list. */
  finishedAt?: number;
  /** Arrived while the page was open: shown with a short highlight. */
  fresh?: boolean;
}

const since = (ms: number, until = Date.now()) => {
  const s = Math.max(0, Math.round((until - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * Active workflows: every workflow running right now, each live on its own small canvas, newest on top. A new run
 * appears at the top by itself and pushes the others down; finished ones stay a while (marked) below. Look only:
 * nothing can be moved or changed here. Click a block to read what it writes.
 */
export function ActiveWorkflowsPage({ active }: { active: boolean }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loaded, setLoaded] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const load = async () => {
      const r = await api<ActivityRunning>('/api/activity/running', { quiet: true }).catch(() => null);
      if (!r || stop) return;
      setLoaded(true);
      // Read now: the state update below may run later, after first.current has changed.
      const firstLoad = first.current;
      first.current = false;
      setCards((old) => merge(old, r.runs, firstLoad));
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [active]);

  // The highlight on a new card fades after a few seconds.
  useEffect(() => {
    if (!cards.some((c) => c.fresh)) return;
    const t = setTimeout(() => setCards((cs) => cs.map((c) => (c.fresh ? { ...c, fresh: false } : c))), 4000);
    return () => clearTimeout(t);
  }, [cards]);

  const running = cards.filter((c) => !c.finishedAt).length;
  const finished = cards.length - running;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Active workflows</h2>
        <span className="flex items-center gap-1.5 text-sm text-slate-400">
          <span className={`h-2 w-2 rounded-full ${running ? 'animate-pulse bg-emerald-400' : 'bg-slate-600'}`} />
          {running} running{finished ? ` · ${finished} finished` : ''}
        </span>
        <span className="text-xs text-slate-500">Live: a new run shows up at the top by itself. Look only — click a block to read what it writes.</span>
        {finished > 0 && (
          <button className="btn-ghost ml-auto text-xs" onClick={() => setCards((cs) => cs.filter((c) => !c.finishedAt))}>
            Clear finished
          </button>
        )}
      </div>
      {loaded && cards.length === 0 && (
        <div className="card text-sm text-slate-400">Nothing is running right now. Leave this page open: a workflow appears here the moment it starts — from you, the API, Home Assistant, the robot or a schedule.</div>
      )}
      {cards.map((c) => (
        <ReactFlowProvider key={c.runId}>
          <RunCard card={c} />
        </ReactFlowProvider>
      ))}
    </div>
  );
}

/** New runs go on top (marked fresh, except on the first load); runs no longer listed are marked finished. */
export function merge(old: Card[], runs: ActiveRun[], firstLoad: boolean): Card[] {
  const now = Date.now();
  const live = new Set(runs.map((r) => r.runId));
  const known = new Set(old.map((c) => c.runId));
  const added: Card[] = runs
    .filter((r) => !known.has(r.runId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({ runId: r.runId, canvasName: r.canvasName, source: r.source, owner: r.owner, mine: r.mine, startedAt: r.startedAt, question: r.question, fresh: !firstLoad }));
  const kept = old.map((c) => (!live.has(c.runId) && !c.finishedAt ? { ...c, finishedAt: now } : c));
  const all = [...added, ...kept];
  // Too many: drop the oldest finished ones; running runs always stay.
  let extra = all.length - MAX_CARDS;
  if (extra <= 0) return all;
  const out = [...all];
  for (let i = out.length - 1; i >= 0 && extra > 0; i--) {
    if (out[i].finishedAt) {
      out.splice(i, 1);
      extra--;
    }
  }
  return out;
}

/** One run: its workflow on a small canvas that can't be edited, and what the chosen block writes, live. */
function RunCard({ card }: { card: Card }) {
  const run = useRun(undefined, true);
  const [flow, setFlow] = useState<{ nodes: HiveFlowNode[]; edges: Edge[] } | null>(null);
  const [picked, setPicked] = useState<string | undefined>();
  const textBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    run.follow(card.runId, (g) => setFlow(toFlow(g)));
    return () => run.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.runId]);

  // Without a click, the panel follows the block that is working now (else the last one that wrote something).
  const workingId = useMemo(() => {
    const ids = Object.keys(run.views);
    return ids.find((id) => LIVE.has(run.views[id].state)) ?? [...ids].reverse().find((id) => run.views[id].text);
  }, [run.views]);
  const shownId = picked ?? workingId;
  const shown = shownId ? run.views[shownId] : undefined;
  const shownNode = flow?.nodes.find((n) => n.id === shownId);
  const done = !!run.final || !!card.finishedAt;
  const status = run.final?.status ?? (card.finishedAt ? 'finished' : run.paused.length ? 'waiting for you' : 'running');

  useEffect(() => {
    const el = textBox.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown?.text, shown?.thinking, run.final?.text]);

  const nodes = useMemo(() => flow?.nodes.map((n) => ({ ...n, selected: n.id === shownId })) ?? [], [flow, shownId]);

  return (
    <div
      className={`card space-y-2 transition-shadow duration-700 ${card.fresh ? 'ring-2 ring-sky-400 shadow-[0_0_24px_rgba(56,189,248,0.35)]' : ''} ${done ? 'opacity-75' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            done ? (status === 'done' || status === 'finished' ? 'bg-slate-500' : 'bg-red-400') : run.paused.length ? 'bg-orange-400' : 'animate-pulse bg-emerald-400'
          }`}
        />
        <span className="font-semibold">{card.canvasName ?? 'Workflow'}</span>
        <span className="rounded bg-[#21262d] px-1.5 text-xs text-slate-300">{card.source}</span>
        {!card.mine && <span className="text-xs text-slate-500">by {card.owner}</span>}
        <span className={`text-xs ${done ? 'text-slate-400' : 'text-emerald-300'}`}>{status}</span>
        <span className="ml-auto text-xs text-slate-500">
          {done ? `took ${since(card.startedAt, card.finishedAt)}` : `running ${since(card.startedAt)}`} · started {new Date(card.startedAt).toLocaleTimeString()}
        </span>
      </div>
      {card.question && <p className="truncate text-xs text-slate-400" title={card.question}>Question: {card.question}</p>}
      <div className="grid gap-2 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="h-72 overflow-hidden rounded-lg border border-[#30363d] bg-[#0d1117]">
          {flow ? (
            <Clock.Provider value={Date.now}>
              <RunViews.Provider value={run.views}>
                <ReactFlow
                  nodes={nodes}
                  edges={flow.edges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  colorMode="dark"
                  fitView
                  fitViewOptions={{ padding: 0.15 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  nodesFocusable={false}
                  edgesFocusable={false}
                  elementsSelectable={false}
                  deleteKeyCode={null}
                  zoomOnScroll={false}
                  preventScrolling={false}
                  zoomOnDoubleClick={false}
                  onNodeClick={(_, n) => setPicked((p) => (p === n.id ? undefined : n.id))}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#30363d" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </RunViews.Provider>
            </Clock.Provider>
          ) : (
            <div className="p-3 text-xs text-slate-500">Connecting…</div>
          )}
        </div>
        <div className="flex h-72 flex-col rounded-lg border border-[#30363d] bg-[#0d1117]">
          <div className="flex items-center gap-2 border-b border-[#30363d] px-3 py-1.5 text-xs">
            <span className="font-semibold text-slate-300">{run.final?.text && !picked ? 'Final answer' : shownNode ? shownNode.data.label || shownNode.data.config.model?.model || shownNode.data.kind : 'Waiting for the first block'}</span>
            {shown && !(run.final?.text && !picked) && <span className={STATE_TEXT[shown.state]}>{shown.state}</span>}
            {shown?.tps && !(run.final?.text && !picked) && <span className="text-slate-500">{shown.tps.toFixed(1)} tok/s</span>}
            {picked && (
              <button className="ml-auto text-slate-400 hover:text-slate-200" onClick={() => setPicked(undefined)}>
                follow the run
              </button>
            )}
          </div>
          <div ref={textBox} className="min-h-0 flex-1 overflow-y-auto p-3 text-xs whitespace-pre-wrap text-slate-300 select-text">
            {run.final?.text && !picked ? (
              run.final.text
            ) : shown ? (
              <>
                {shown.note && <div className="mb-1 text-slate-500">{shown.note}</div>}
                {shown.thinking && <div className="mb-2 text-violet-300/70">{shown.thinking.slice(-3000)}</div>}
                {shown.error ? <div className="text-red-400">{shown.error}</div> : shown.text || <span className="text-slate-500">Nothing written yet.</span>}
              </>
            ) : (
              <span className="text-slate-500">{done ? 'This run has finished.' : 'Nothing written yet.'}</span>
            )}
            {run.errors.length > 0 && !picked && <div className="mt-2 text-red-400">{run.errors.join('\n')}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
