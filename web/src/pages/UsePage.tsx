import type { Canvas, RunSummary } from '@hivemind/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { GpuBar, WorkBar } from '../canvas/NodeBars';
import { AnswerView } from '../components/AnswerView';
import { ExportRun } from '../components/ExportRun';
import { NODE_META } from '../canvas/meta';
import { toast } from '../notify';
import { IDLE, STATE_LABEL, STATE_TEXT, useRun } from '../run/state';
import { useStored } from '../stored';
import { MicButton, speak, SpeakButton, useVoice } from '../voice';

/** The simple screen: pick a saved canvas, ask, get the answer. What a phone or Home Assistant user sees. */
export function UsePage({ active, viewer, onProblem, onBuild }: { active: boolean; viewer?: boolean; onProblem: () => void; onBuild: () => void }) {
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [canvasId, setCanvasId] = useStored('use.canvas', '');
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<RunSummary[]>([]);
  const run = useRun(onProblem);
  const voice = useVoice();
  const [readAloud, setReadAloud] = useStored('use.readAloud', true);
  /** The question came from the microphone: read the answer aloud (if wanted). */
  const byVoice = useRef(false);

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
    if (run.final?.text && byVoice.current && readAloud) speak(run.final.text, voice).catch((err) => toast(`Could not read aloud: ${(err as Error).message}`));
    if (run.final) byVoice.current = false;
  }, [run.final]);

  const ask = async (e?: FormEvent, q = question, target = canvas) => {
    e?.preventDefault();
    if (!target || !q.trim() || run.running) return;
    try {
      await run.start({ question: q.trim(), graph: { nodes: target.nodes, edges: target.edges }, canvasId: target.id });
    } catch {}
  };

  // Settings → Voice → Canvas router: spoken questions go to the canvas a decision model picks.
  const [routeVoice, setRouteVoice] = useState(false);
  const [routed, setRouted] = useState('');
  useEffect(() => {
    if (active) api<{ canvasRouter?: unknown }>('/api/me/prefs', { quiet: true }).then((p) => setRouteVoice(!!p.canvasRouter)).catch(() => {});
  }, [active]);
  const askByVoice = async (text: string) => {
    if (!routeVoice || !canvases || canvases.length < 2) return ask(undefined, text);
    try {
      const r = await api<{ canvasId: string; name: string; decision: { ms: number } }>('/api/route-canvas', { body: { text } });
      const target = canvases.find((c) => c.id === r.canvasId);
      if (target) {
        setCanvasId(target.id);
        setRouted(`⚡ ${r.name} · picked in ${r.decision.ms} ms`);
      }
      return ask(undefined, text, target ?? canvas);
    } catch {
      // The router's error was shown; ask the canvas that is open.
      return ask(undefined, text);
    }
  };

  // The blocks worth showing while it works: everything except Question and Final answer.
  const steps = useMemo(() => canvas?.nodes.filter((n) => n.type !== 'input' && n.type !== 'output') ?? [], [canvas]);

  if (canvases === null) return null;
  if (canvases.length === 0)
    return (
      <div className="card mx-auto mt-10 max-w-lg space-y-3 text-center">
        <h2 className="text-lg font-semibold">No canvases yet</h2>
        {viewer ? (
          <p className="text-sm text-slate-400">Nothing is shared with you yet. Ask someone to press “Share” on a canvas — it shows up here.</p>
        ) : (
          <>
            <p className="text-sm text-slate-400">Build one on the Canvas (or let the ✨ Builder do it) and save it — it shows up here as an app.</p>
            <button className="btn" onClick={onBuild}>
              Open the Canvas
            </button>
          </>
        )}
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
            {c.ownerName && <span className="ml-1.5 text-xs font-normal text-slate-500">· {c.ownerName}</span>}
          </button>
        ))}
      </div>

      {routed && <div className="hm-zap -mb-2 text-xs text-indigo-300">{routed}</div>}
      <form onSubmit={ask} className="flex gap-2">
        <input
          className="input h-12 text-base"
          placeholder={`Ask “${canvas?.name}”…`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          autoFocus
        />
        <MicButton
          disabled={run.running}
          onText={(text) => {
            setQuestion(text);
            byVoice.current = true;
            askByVoice(text);
          }}
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
            {run.final.text && <SpeakButton text={run.final.text} className="ml-auto" />}
            <ExportRun runId={run.runId} className={run.final.text ? '' : 'ml-auto'} />
            {run.final.text && (
              <button
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={() => navigator.clipboard.writeText(run.final!.text!).then(() => toast('Copied', 'ok'))}
              >
                Copy
              </button>
            )}
          </div>
          {run.final.text ? <AnswerView text={run.final.text} files={run.final.files} /> : <p className="text-slate-400">No answer: the run failed (see above).</p>}
        </div>
      )}

      {voice?.sttReady && (
        <label className="flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} /> Read the answer aloud when I ask by voice
        </label>
      )}

      {history.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Earlier</div>
          {history.map((h) => (
            <details key={h.id} className="rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2">
              <summary className="cursor-pointer text-sm text-slate-200">{h.question}</summary>
              <div className="mt-2">{h.final ? <AnswerView text={h.final} compact /> : <span className="text-sm text-slate-500">({h.status})</span>}</div>
              <div className="mt-2 flex justify-end gap-2">
                {h.final && <SpeakButton text={h.final} />}
                <ExportRun runId={h.id} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
