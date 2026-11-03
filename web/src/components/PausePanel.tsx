import type { FileChange, PauseInfo, ResumeRequest } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

/** The diff of one changed file, folded open on click. */
export function ChangeRow({ c }: { c: FileChange }) {
  const [open, setOpen] = useState(false);
  const color = c.status === 'added' ? 'text-emerald-300' : c.status === 'deleted' ? 'text-red-300' : c.status === 'skipped' ? 'text-slate-500' : 'text-amber-300';
  return (
    <div className="text-xs">
      <button className="flex w-full items-center gap-2 text-left hover:text-white" onClick={() => c.diff && setOpen(!open)}>
        <span className={`w-14 shrink-0 ${color}`}>{c.status}</span>
        <span className="truncate font-mono text-slate-200">{c.path}</span>
        {(c.added > 0 || c.removed > 0) && (
          <span className="ml-auto shrink-0 font-mono">
            <span className="text-emerald-400">+{c.added}</span> <span className="text-red-400">−{c.removed}</span>
          </span>
        )}
      </button>
      {open && c.diff && (
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-[#0d1117] p-2 font-mono text-[11px] leading-4">
          {c.diff.split('\n').map((l, i) => (
            <div key={i} className={l.startsWith('+ ') ? 'bg-emerald-950/60 text-emerald-200' : l.startsWith('- ') ? 'bg-red-950/60 text-red-200' : 'text-slate-400'}>
              {l}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/**
 * A run waiting at a Pause block: what came in (editable), the files changed so far with their diffs, the
 * preview, and Continue / Reject / Stop.
 */
export function PausePanel({ runId, pause, onDone }: { runId: string; pause: PauseInfo; onDone?: () => void }) {
  const [text, setText] = useState(pause.input);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number>();
  useEffect(() => setText(pause.input), [pause.nodeId, pause.input]);
  useEffect(() => {
    if (!pause.timeoutAt) return;
    const t = setInterval(() => setLeft(Math.max(0, pause.timeoutAt! - Date.now())), 1000);
    return () => clearInterval(t);
  }, [pause.timeoutAt]);
  const answer = async (body: ResumeRequest) => {
    setBusy(true);
    try {
      await api(`/api/runs/${runId}/resume`, { body: { ...body, nodeId: pause.nodeId } });
      toast(body.action === 'continue' ? 'Continued' : body.action === 'reject' ? 'Rejected' : 'Stopped', 'ok');
      onDone?.();
    } catch {
      // The toast says why.
    } finally {
      setBusy(false);
    }
  };
  const changes = (pause.changes ?? []).filter((c) => c.status !== 'skipped');
  return (
    <div className="space-y-2 rounded-lg border border-orange-500/60 bg-orange-950/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-xs font-semibold text-orange-300">Waiting for you</span>
        <span className="font-semibold text-slate-100">{pause.title}</span>
        {left !== undefined && (
          <span className="text-xs text-slate-400">
            {pause.onTimeout ?? 'continue'}s by itself in {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}
          </span>
        )}
        {pause.previewUrl && (
          <a className="ml-auto text-xs text-sky-400 hover:underline" href={pause.previewUrl} target="_blank" rel="noreferrer noopener">
            Open the preview ↗
          </a>
        )}
      </div>
      {pause.message && <p className="whitespace-pre-wrap text-sm text-slate-300">{pause.message}</p>}
      {changes.length > 0 && (
        <div className="space-y-1 rounded border border-[#30363d] bg-[#0d1117]/60 p-2">
          <div className="text-xs font-semibold text-slate-300">Changed so far ({changes.length})</div>
          {changes.map((c) => (
            <ChangeRow key={c.path} c={c} />
          ))}
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-xs text-slate-400">What goes on (edit it if you like)</span>
        <textarea className="input min-h-28 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn bg-emerald-700 hover:bg-emerald-600" disabled={busy} onClick={() => answer({ action: 'continue', ...(text !== pause.input && { text }) })}>
          Continue
        </button>
        <input className="input max-w-sm flex-1 py-1 text-xs" placeholder="Why reject? (goes to the 'rejected' branch)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button className="btn-ghost" disabled={busy} onClick={() => answer({ action: 'reject', comment })}>
          Reject
        </button>
        <button className="btn-ghost text-red-300" disabled={busy} onClick={() => answer({ action: 'stop' })}>
          Stop the run
        </button>
      </div>
    </div>
  );
}
