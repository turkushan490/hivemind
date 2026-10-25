import { councilGraph, type CanvasGraph, type ModelInfo, type ModelRef, type RunEvent } from '@hivemind/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

type NodeState = 'idle' | 'queued' | 'loading' | 'thinking' | 'streaming' | 'done' | 'error';

interface NodeView {
  state: NodeState;
  text: string;
  thinking?: string;
  tokens?: number;
  tps?: number;
  elapsedMs?: number;
  cost?: number;
  error?: string;
  startedAt?: number;
}

const key = (m: ModelRef) => `${m.providerId}|${m.model}`;
const unkey = (k: string): ModelRef => {
  const i = k.indexOf('|');
  return { providerId: k.slice(0, i), model: k.slice(i + 1) };
};

const STATE_STYLE: Record<NodeState, string> = {
  idle: 'text-slate-500',
  queued: 'text-slate-400',
  loading: 'text-amber-400',
  thinking: 'text-violet-400',
  streaming: 'text-cyan-400',
  done: 'text-emerald-400',
  error: 'text-red-400',
};

/** Folds run events into per-node state. The fancy canvas later uses the same reducer idea. */
function applyEvent(views: Record<string, NodeView>, ev: RunEvent): Record<string, NodeView> {
  if (!ev.nodeId) return views;
  const v: NodeView = views[ev.nodeId] ?? { state: 'idle', text: '' };
  let next: NodeView = v;
  switch (ev.type) {
    case 'node_queued':
      next = { ...v, state: 'queued' };
      break;
    case 'model_loading':
      next = { ...v, state: 'loading' };
      break;
    case 'node_start':
      next = { ...v, state: 'loading', startedAt: ev.ts };
      break;
    case 'thinking':
      next = { ...v, state: 'thinking', thinking: (v.thinking ?? '') + (ev.text ?? '') };
      break;
    case 'token':
      next = { ...v, state: 'streaming', text: v.text + (ev.text ?? ''), tokens: ev.tokens, tps: ev.tokensPerSec ?? v.tps };
      break;
    case 'node_done':
      next = { ...v, state: 'done', text: ev.text ?? v.text, tokens: ev.tokens, tps: ev.tokensPerSec, elapsedMs: ev.elapsedMs, cost: ev.cost };
      break;
    case 'error':
      next = { ...v, state: 'error', error: ev.error };
      break;
  }
  return { ...views, [ev.nodeId]: next };
}

export function RunPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelErrors, setModelErrors] = useState<{ providerId: string; error: string }[]>([]);
  const [freeOnly, setFreeOnly] = useState(false);
  const [council, setCouncil] = useState<string[]>([]);
  const [judge, setJudge] = useState('');
  const [review, setReview] = useState(false);
  const [question, setQuestion] = useState('');
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  const [views, setViews] = useState<Record<string, NodeView>>({});
  const [runId, setRunId] = useState('');
  const [final, setFinal] = useState<{ text?: string; status?: string; cost?: number } | null>(null);
  const [error, setError] = useState('');
  const [, setNow] = useState(0);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    api<{ models: ModelInfo[]; errors: { providerId: string; error: string }[] }>('/api/models').then((r) => {
      setModels(r.models);
      setModelErrors(r.errors);
    });
    return () => source.current?.close();
  }, []);

  // Ticks the live elapsed timers while a run is going.
  useEffect(() => {
    if (!runId || final) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [runId, final]);

  const shown = useMemo(() => (freeOnly ? models.filter((m) => m.free) : models), [models, freeOnly]);

  const start = async () => {
    setError('');
    if (council.length === 0 || !judge) return setError('Pick at least one council model and a judge');
    const g = councilGraph(council.map(unkey), unkey(judge), review);
    try {
      const { runId } = await api<{ runId: string }>('/api/runs', { body: { question, graph: g } });
      setGraph(g);
      setViews({});
      setFinal(null);
      setRunId(runId);
      source.current?.close();
      const es = new EventSource(`/api/runs/${runId}/events`);
      source.current = es;
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as RunEvent;
        setViews((v) => applyEvent(v, ev));
        if (ev.type === 'run_done') setFinal({ text: ev.final, status: ev.status, cost: ev.cost });
      };
      es.addEventListener('end', () => es.close());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const modelNodes = graph?.nodes.filter((n) => n.type !== 'input' && n.type !== 'output') ?? [];
  const running = !!runId && !final;

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <textarea className="input min-h-24" placeholder="Ask the council a question…" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> Free models only
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Review round
          </label>
          <span className="text-slate-400">Judge:</span>
          <select className="input w-auto" value={judge} onChange={(e) => setJudge(e.target.value)}>
            <option value="">— pick judge —</option>
            {shown.map((m) => (
              <option key={key(m)} value={key(m)}>
                {m.name}
              </option>
            ))}
          </select>
          <button className="btn ml-auto" disabled={running || !question.trim()} onClick={start}>
            {running ? 'Running…' : 'Ask the council'}
          </button>
          {running && (
            <button className="btn-ghost" onClick={() => api(`/api/runs/${runId}/cancel`, { method: 'POST' })}>
              Cancel
            </button>
          )}
        </div>
        <details open>
          <summary className="cursor-pointer text-sm text-slate-400">
            Council models ({council.length} picked, {shown.length} available)
          </summary>
          <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto text-sm sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((m) => {
              const k = key(m);
              return (
                <label key={k} className="flex items-center gap-1.5 truncate">
                  <input
                    type="checkbox"
                    checked={council.includes(k)}
                    onChange={(e) => setCouncil((c) => (e.target.checked ? [...c, k] : c.filter((x) => x !== k)))}
                  />
                  <span className="truncate">{m.name}</span>
                  {m.free && <span className="rounded bg-emerald-900/50 px-1 text-xs text-emerald-300">free</span>}
                </label>
              );
            })}
          </div>
          {modelErrors.map((e) => (
            <p key={e.providerId} className="text-xs text-red-400">
              {e.providerId}: {e.error}
            </p>
          ))}
        </details>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {graph && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {modelNodes.map((n) => {
            const v = views[n.id] ?? { state: 'idle', text: '' };
            const elapsed = v.elapsedMs ?? (v.startedAt ? Date.now() - v.startedAt : undefined);
            return (
              <div key={n.id} className="card flex max-h-96 flex-col">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-medium">{n.type === 'llm' ? n.label : `${n.label} · ${n.config.model?.model}`}</span>
                  <span className={`ml-auto ${STATE_STYLE[v.state]}`}>{v.state}</span>
                </div>
                <div className="mb-2 flex gap-3 text-xs text-slate-500">
                  {v.tokens !== undefined && <span>{v.tokens} tok</span>}
                  {v.tps !== undefined && <span>{v.tps.toFixed(1)} tok/s</span>}
                  {elapsed !== undefined && <span>{(elapsed / 1000).toFixed(1)} s</span>}
                  {v.cost !== undefined && <span>${v.cost.toFixed(5)}</span>}
                </div>
                {v.thinking && (
                  <details className="mb-2 text-xs text-violet-300/80" open={v.state === 'thinking'}>
                    <summary className="cursor-pointer">Thinking ({v.thinking.length} chars)</summary>
                    <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap">{v.thinking}</pre>
                  </details>
                )}
                <pre className="flex-1 overflow-y-auto whitespace-pre-wrap text-sm text-slate-300">{v.error ?? v.text}</pre>
              </div>
            );
          })}
        </div>
      )}

      {final && (
        <div className="card">
          <h2 className="mb-2 font-semibold">
            Final answer <span className="text-sm font-normal text-slate-400">({final.status}{final.cost ? `, $${final.cost.toFixed(5)}` : ''})</span>
          </h2>
          <pre className="whitespace-pre-wrap text-sm">{final.text ?? 'No answer — see the errors above.'}</pre>
        </div>
      )}
    </div>
  );
}
