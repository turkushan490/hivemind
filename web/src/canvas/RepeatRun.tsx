import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

interface BatchStatus {
  canvasId: string;
  canvasName: string;
  running: boolean;
  total?: number;
  done: number;
  failed: number;
  current?: { question: string };
  lastError?: string;
}

/**
 * "Run repeatedly": the saved canvas runs again and again — over a list of questions, a number of times, or until
 * stopped — e.g. to collect training examples. {{vars.run}} and {{vars.seed}} change every run.
 */
export function RepeatRun({ canvasId, question }: { canvasId?: string; question: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const [questions, setQuestions] = useState('');
  const [times, setTimes] = useState(10);
  const [forever, setForever] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const lastError = useRef<string | undefined>(undefined);

  const load = () => api<BatchStatus | null>('/api/batch', { quiet: true }).then(setStatus).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, status?.running ? 2000 : 15000);
    return () => clearInterval(t);
  }, [status?.running]);
  useEffect(() => {
    if (status?.lastError && status.lastError !== lastError.current) toast(`Run repeatedly: ${status.lastError}`);
    lastError.current = status?.lastError;
  }, [status?.lastError]);
  useEffect(() => {
    if (!open) return;
    if (!questions.trim()) setQuestions(question);
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const start = async () => {
    if (!canvasId) return toast('Save the workflow first, then run it repeatedly', 'info');
    const list = questions.split('\n').map((q) => q.trim()).filter(Boolean);
    if (!list.length) return toast('Write at least one question', 'info');
    try {
      setStatus(await api<BatchStatus>('/api/batch', { body: { canvasId, questions: list, times: forever ? 0 : times } }));
      toast(forever ? 'Running until you press Stop' : `Running ${times} times`, 'ok');
      setOpen(false);
    } catch {}
  };
  const stop = async () => {
    await api('/api/batch/stop', { method: 'POST' }).catch(() => {});
    load();
  };

  const mine = status?.running && status.canvasId === canvasId;
  return (
    <div ref={box} className="relative shrink-0">
      {status?.running ? (
        <button className="btn-ghost px-2 py-1 text-xs" title={`Running "${status.canvasName}" repeatedly — click to stop`} onClick={stop}>
          <span className="hm-breathe mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />
          {status.done}
          {status.total ? `/${status.total}` : ''} {status.failed ? <span className="text-red-300">· {status.failed} failed</span> : null} ■ {mine ? 'Stop' : `Stop "${status.canvasName}"`}
        </button>
      ) : (
        <button className="btn-ghost px-2 py-1 text-xs" title="Run this canvas many times (e.g. to collect training data)" onClick={() => setOpen(!open)}>
          ↻ Repeat
        </button>
      )}
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-80 space-y-2 rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-xs shadow-xl">
          <div className="font-semibold text-slate-200">Run repeatedly</div>
          <label className="block space-y-1">
            <span className="text-slate-400">Questions — one per line, asked in turn</span>
            <textarea className="input min-h-24 text-xs" value={questions} onChange={(e) => setQuestions(e.target.value)} />
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-slate-300">
              <input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} /> Until I stop it
            </label>
            {!forever && (
              <label className="ml-auto flex items-center gap-1 text-slate-400">
                Runs
                <input className="input w-20 py-1 text-xs" type="number" min={1} max={100000} value={times} onChange={(e) => setTimes(Math.max(1, Number(e.target.value) || 1))} />
              </label>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            Runs the saved canvas one run at a time; runs you start by hand go in between. <code>{'{{vars.run}}'}</code> and <code>{'{{vars.seed}}'}</code> change every run.
          </p>
          <button className="btn w-full" onClick={start}>
            Start
          </button>
        </div>
      )}
    </div>
  );
}
