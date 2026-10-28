import { councilGraph, type CanvasGraph, type ModelInfo, type RunEvent } from '@hivemind/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { AnswerView } from '../components/AnswerView';
import { toast } from '../notify';
import { useStored } from '../stored';
import { applyEvent, modelKey as key, parseModelKey as unkey, STATE_TEXT as STATE_STYLE, type NodeView } from '../run/state';

export function RunPage({ onProblem, active }: { onProblem: () => void; active: boolean }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelErrors, setModelErrors] = useState<{ providerId: string; error: string }[]>([]);
  const [freeOnly, setFreeOnly] = useStored('run.freeOnly', false);
  const [council, setCouncil] = useStored<string[]>('run.council', []);
  const [judge, setJudge] = useStored('run.judge', '');
  const [review, setReview] = useStored('run.review', false);
  const [question, setQuestion] = useStored('run.question', '');
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  const [views, setViews] = useState<Record<string, NodeView>>({});
  const [runId, setRunId] = useState('');
  const [final, setFinal] = useState<{ text?: string; status?: string; cost?: number } | null>(null);
  const [error, setError] = useState('');
  const [runErrors, setRunErrors] = useState<string[]>([]);
  const [connLost, setConnLost] = useState(false);
  const [, setNow] = useState(0);
  const source = useRef<EventSource | null>(null);

  useEffect(() => () => source.current?.close(), []);

  // Reload the model list each time the tab is opened (a provider may have been added); picks stay.
  useEffect(() => {
    if (!active) return;
    api<{ models: ModelInfo[]; errors: { providerId: string; error: string }[] }>('/api/models').then((r) => {
      setModels(r.models);
      setModelErrors(r.errors);
    });
  }, [active]);

  // Ticks the live elapsed timers while a run is going.
  useEffect(() => {
    if (!runId || final) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [runId, final]);

  const shown = useMemo(() => models.filter((m) => !m.kind && (!freeOnly || m.free)), [models, freeOnly]);

  const start = async () => {
    setError('');
    // Remembered picks may point at models that were removed since.
    const exists = (k: string) => models.some((m) => key(m) === k);
    const picked = council.filter(exists);
    if (picked.length === 0 || !exists(judge)) return setError('Pick at least one council model and a judge');
    const g = councilGraph(picked.map(unkey), unkey(judge), review);
    try {
      const { runId } = await api<{ runId: string }>('/api/runs', { body: { question, graph: g } });
      setGraph(g);
      setViews({});
      setFinal(null);
      setRunErrors([]);
      setRunId(runId);
      source.current?.close();
      const label = (id?: string) => g.nodes.find((n) => n.id === id)?.label ?? id ?? 'Run';
      let lost = false;
      const es = new EventSource(`/api/runs/${runId}/events`);
      source.current = es;
      es.onopen = () => {
        // After a reconnect the server replays the whole run, so start from a clean slate.
        if (lost) {
          setViews({});
          setRunErrors([]);
          toast('Reconnected to the server', 'ok');
        }
        lost = false;
        setConnLost(false);
      };
      es.onerror = () => {
        lost = true;
        setConnLost(true);
      };
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data) as RunEvent;
        setViews((v) => applyEvent(v, ev));
        if (ev.type === 'error' && ev.error !== 'Cancelled') {
          const msg = `${label(ev.nodeId)} failed: ${ev.error}`;
          setRunErrors((e) => (e.includes(msg) ? e : [...e, msg]));
          if (!lost) {
            toast(msg);
            onProblem();
          }
        }
        if (ev.type === 'run_done') setFinal({ text: ev.final, status: ev.status, cost: ev.cost });
      };
      es.addEventListener('end', () => {
        es.close();
        setConnLost(false);
      });
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

      {connLost && running && (
        <div role="alert" className="rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
          Lost the live connection to this run. Reconnecting… the run keeps going on the server.
        </div>
      )}
      {runErrors.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          <div className="mb-1 font-semibold">
            {runErrors.length} problem{runErrors.length > 1 ? 's' : ''} in this run
          </div>
          <ul className="list-disc space-y-0.5 pl-5">
            {runErrors.map((e) => (
              <li key={e} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {graph && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {modelNodes.map((n) => {
            const v = views[n.id] ?? { state: 'idle', text: '' };
            const elapsed = v.elapsedMs ?? (v.startedAt ? Date.now() - v.startedAt : undefined);
            return (
              <div key={n.id} className={`card flex max-h-96 flex-col ${v.state === 'error' ? 'border-red-700 bg-red-950/20' : ''}`}>
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
                {v.error && <p className="mb-2 rounded bg-red-950/60 px-2 py-1 text-sm break-words text-red-300">{v.error}</p>}
                <pre className="flex-1 overflow-y-auto whitespace-pre-wrap text-sm text-slate-300">{v.text}</pre>
              </div>
            );
          })}
        </div>
      )}

      {final && (
        <div className={`card ${final.status === 'error' ? 'border-red-800' : final.status === 'done' ? 'border-emerald-800' : ''}`}>
          <h2 className="mb-2 font-semibold">
            Final answer <span className="text-sm font-normal text-slate-400">({final.status}{final.cost ? `, $${final.cost.toFixed(5)}` : ''})</span>
          </h2>
          {final.text ? <AnswerView text={final.text} /> : <p className="text-sm text-slate-400">{final.status === 'cancelled' ? 'Cancelled.' : 'No final answer: the run failed. See the problems above.'}</p>}
        </div>
      )}
    </div>
  );
}
