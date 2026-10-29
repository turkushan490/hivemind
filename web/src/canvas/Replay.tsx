import type { RunSummary } from '@hivemind/shared';
import { ExportRun } from '../components/ExportRun';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import type { useReplay } from '../run/replay';

/** sqlite's datetime('now') is UTC without a zone marker. */
const parseDb = (s?: string) => (s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN);
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const STATUS: Record<string, string> = {
  done: 'bg-emerald-900/50 text-emerald-300',
  error: 'bg-red-900/50 text-red-300',
  cancelled: 'bg-slate-700 text-slate-300',
  running: 'bg-cyan-900/50 text-cyan-300',
};

/** Past runs, newest first. Click one to replay it on the canvas. */
export function History({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = () => api<RunSummary[]>('/api/runs').then(setRuns).catch(() => setRuns([]));
  useEffect(() => {
    load();
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div ref={box} className="absolute z-40 mt-1 w-[440px] rounded-lg border border-[#30363d] bg-[#161b22] shadow-xl">
      <div className="flex items-center border-b border-[#30363d] px-3 py-2">
        <span className="text-sm font-semibold">Run history</span>
        <span className="ml-2 text-xs text-slate-500">click a run to replay it</span>
        <label className="ml-auto cursor-pointer text-xs text-indigo-400 hover:underline" title="Import tasks exported from HiveMind (ZIP)">
          Import
          <input
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const res = await fetch('/api/import/tasks', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) return toast(data.error ?? `Import failed (HTTP ${res.status})`);
              toast(`Imported ${data.imported} task${data.imported === 1 ? '' : 's'}`, 'ok');
              load();
            }}
          />
        </label>
        {!!runs?.length && (
          <a className="ml-3 text-xs text-indigo-400 hover:underline" href="/api/export/tasks.zip" title="Every finished task: answers, block outputs, files and replay data">
            Export all
          </a>
        )}
        {!!runs?.length && (
          <button
            className="ml-3 text-xs text-red-400 hover:underline"
            onClick={async () => {
              if (!confirm('Delete all finished runs from the history?')) return;
              await api('/api/runs', { method: 'DELETE' });
              load();
            }}
          >
            Clear all
          </button>
        )}
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-1">
        {runs === null && <p className="p-3 text-sm text-slate-400">Loading…</p>}
        {runs?.length === 0 && <p className="p-3 text-sm text-slate-400">No runs yet. Press Run on a workflow first.</p>}
        {runs?.map((r) => {
          const started = parseDb(r.startedAt);
          const took = parseDb(r.finishedAt) - started;
          return (
            <div key={r.id} className="group flex items-start gap-2 rounded-md px-2 py-2 hover:bg-[#21262d]">
              <button className="min-w-0 flex-1 space-y-0.5 text-left" disabled={r.status === 'running'} onClick={() => onPick(r.id)}>
                <div className="truncate text-sm text-slate-100">{r.question}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <span className={`rounded px-1.5 ${STATUS[r.status] ?? ''}`}>{r.status}</span>
                  {r.canvasName && <span className="truncate">{r.canvasName}</span>}
                  <span>{Number.isFinite(started) ? new Date(started).toLocaleString() : ''}</span>
                  {Number.isFinite(took) && <span>· {clock(took)}</span>}
                  {!!r.cost && <span>· ${r.cost.toFixed(4)}</span>}
                </div>
              </button>
              {r.status !== 'running' && <ExportRun runId={r.id} className="opacity-0 group-hover:opacity-100 focus-within:opacity-100" />}
              {r.status !== 'running' && (
                <a
                  aria-label="Export task as ZIP"
                  title="Export as ZIP"
                  href={`/api/runs/${r.id}/export.zip`}
                  className="px-1 text-slate-600 opacity-0 group-hover:opacity-100 hover:text-indigo-300"
                >
                  ⬇
                </a>
              )}
              {r.status !== 'running' && (
                <button
                  aria-label="Delete run"
                  className="px-1 text-slate-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
                  onClick={async () => {
                    await api(`/api/runs/${r.id}`, { method: 'DELETE' });
                    setRuns((l) => l?.filter((x) => x.id !== r.id) ?? null);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SPEEDS = [1, 2, 4, 10];

/** Play / pause, speed and a time slider for the replayed run. */
export function ReplayBar({ replay }: { replay: ReturnType<typeof useReplay> }) {
  const atEnd = replay.t >= replay.duration;
  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex w-[min(720px,92%)] -translate-x-1/2 items-center gap-3 rounded-xl border border-violet-700/70 bg-[#161b22]/95 px-4 py-2.5 shadow-2xl shadow-violet-950/50 backdrop-blur">
      <button
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white hover:bg-violet-500"
        aria-label={replay.playing ? 'Pause' : 'Play'}
        onClick={() => {
          if (atEnd) replay.seek(0);
          replay.setPlaying(!replay.playing || atEnd);
        }}
      >
        {replay.playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" />
            <rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            {atEnd ? <path d="M7 2a5 5 0 1 1-4.6 3H0.5L3.5 1.5 6.5 5H4.6A3 3 0 1 0 7 4z" fill="currentColor" /> : <path d="M3 1.5v11l9-5.5z" fill="currentColor" />}
          </svg>
        )}
      </button>
      <span className="w-24 shrink-0 font-mono text-xs text-slate-300">
        {clock(replay.t)} / {clock(replay.duration)}
      </span>
      <input
        type="range"
        className="hm-scrub min-w-0 flex-1"
        min={0}
        max={Math.max(1, replay.duration)}
        step={50}
        value={replay.t}
        aria-label="Replay position"
        onChange={(e) => replay.seek(Number(e.target.value))}
      />
      <div className="flex shrink-0 overflow-hidden rounded-md border border-[#30363d] text-xs">
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`px-2 py-1 ${replay.speed === s ? 'bg-violet-600 text-white' : 'text-slate-400 hover:bg-[#21262d]'}`}
            onClick={() => replay.setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
