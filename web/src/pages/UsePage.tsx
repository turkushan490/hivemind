import type { Canvas, RunSummary } from '@hivemind/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { GpuBar, WorkBar } from '../canvas/NodeBars';
import { AnswerView } from '../components/AnswerView';
import { NODE_META } from '../canvas/meta';
import { toast } from '../notify';
import { IDLE, STATE_LABEL, STATE_TEXT, useRun } from '../run/state';
import { useStored } from '../stored';

/** The simple screen: pick a saved canvas, ask, get the answer. What a phone or Home Assistant user sees. */
export function UsePage({ active, onProblem, onBuild }: { active: boolean; onProblem: () => void; onBuild: () => void }) {
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [canvasId, setCanvasId] = useStored('use.canvas', '');
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<RunSummary[]>([]);
  const run = useRun(onProblem);

  useEffect(() => {
    if (!active) return;
    api<Canvas[]>('/api/canvases', { quiet: true }).then(setCanvases).catch(() => setCanvases([]));
  }, [active]);

  const canvas = canvases?.find((c) => c.id === canvasId) ?? canvases?.[0];

  const loadHistory = () =>
    api<RunSummary[]>('/api/runs', { quiet: true })
      .then((rs) => setHistory(rs.filter((r) => r.canvasId === canvas?.id && r.status !== 'running').slice(0, 15)))
      .catch(() => {});
  useEffect(() => {
    if (active && canvas) loadHistory();
  }, [active, canvas?.id]);
  useEffect(() => {
    if (run.final) loadHistory();
  }, [run.final]);

  const ask = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canvas || !question.trim() || run.running) return;
    try {
      await run.start({ question: question.trim(), graph: { nodes: canvas.nodes, edges: canvas.edges }, canvasId: canvas.id });
    } catch {}
  };

  // The blocks worth showing while it works: everything except Question and Final answer.
  const steps = useMemo(() => canvas?.nodes.filter((n) => n.type !== 'input' && n.type !== 'output') ?? [], [canvas]);

  if (canvases === null) return null;
  if (canvases.length === 0)
    return (
      <div className="card mx-auto mt-10 max-w-lg space-y-3 text-center">
        <h2 className="text-lg font-semibold">No canvases yet</h2>
        <p className="text-sm text-slate-400">Build one on the Canvas (or let the ✨ Builder do it) and save it — it shows up here as an app.</p>
        <button className="btn" onClick={onBuild}>
          Open the Canvas
        </button>
      </div>
    );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {canvases.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setCanvasId(c.id);
              run.reset();
            }}
            className={`shrink-0 rounded-full border px-4 py-2 text-sm ${c.id === canvas?.id ? 'border-indigo-500 bg-indigo-500/20 font-semibold text-indigo-100' : 'border-[#30363d] bg-[#161b22] text-slate-400 hover:text-slate-200'}`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <form onSubmit={ask} className="flex gap-2">
        <input
          className="input h-12 text-base"
          placeholder={`Ask “${canvas?.name}”…`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
        />
        {run.running ? (
          <button type="button" className="btn h-12 shrink-0 bg-red-600 hover:bg-red-500" onClick={run.cancel}>
            Stop
          </button>
        ) : (
          <button className="btn h-12 shrink-0 px-6" disabled={!question.trim()}>
            Ask
          </button>
        )}
      </form>

      {run.runId && (
        <div className="card space-y-3">
          <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            {run.final ? 'How the answer was made' : 'Working on it…'}
          </div>
          {steps.map((n) => {
            const v = run.views[n.id] ?? IDLE;
            const meta = NODE_META[n.type];
            return (
              <div key={n.id} className={`space-y-1 ${v.state === 'skipped' ? 'opacity-40' : ''}`}>
                <div className="flex items-center gap-2 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
                  <span className="truncate font-medium">{n.label || meta.title}</span>
                  {v.note && <span className="truncate text-xs text-amber-200/80">{v.note}</span>}
                  <span className={`ml-auto shrink-0 text-xs ${STATE_TEXT[v.state]}`}>{STATE_LABEL[v.state]}</span>
                </div>
                {(meta.usesModel || meta.multiModel) && v.state !== 'idle' && v.state !== 'skipped' && (
                  <div className="space-y-1 pl-4">
                    <GpuBar v={v} />
                    <WorkBar v={v} />
                  </div>
                )}
              </div>
            );
          })}
          {run.errors.length > 0 && (
            <div className="rounded-md border border-red-800 bg-red-950/40 p-2 text-xs text-red-200">
              {run.errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {run.final && (
        <div className={`card space-y-2 ${run.final.status === 'done' ? 'border-emerald-800' : 'border-red-800'}`}>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-emerald-300">Answer</span>
            {run.final.cost ? <span className="text-xs text-slate-500">${run.final.cost.toFixed(4)}</span> : null}
            {run.final.text && (
              <button
                className="btn-ghost ml-auto px-2 py-0.5 text-xs"
                onClick={() => navigator.clipboard.writeText(run.final!.text!).then(() => toast('Copied', 'ok'))}
              >
                Copy
              </button>
            )}
          </div>
          {run.final.text ? <AnswerView text={run.final.text} files={run.final.files} /> : <p className="text-slate-400">No answer: the run failed (see above).</p>}
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Earlier</div>
          {history.map((h) => (
            <details key={h.id} className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2">
              <summary className="cursor-pointer text-sm text-slate-200">{h.question}</summary>
              <div className="mt-2">{h.final ? <AnswerView text={h.final} compact /> : <span className="text-sm text-slate-500">({h.status})</span>}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
