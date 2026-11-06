import type { ActivityRunning, ActiveRun } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';

const since = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * Workflow page → Live: the workflows running right now (also the ones the API, DungeonMind or a schedule started),
 * to open one on the canvas and watch it work. Refreshes every 3 seconds while open; the button shows how many run.
 */
export function LiveRunsMenu({ onFollow, followingId }: { onFollow: (runId: string, title: string) => void; followingId?: string }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  useEffect(() => {
    const load = () =>
      api<ActivityRunning>('/api/activity/running', { quiet: true })
        .then((r) => setRuns(r.runs))
        .catch(() => {});
    load();
    const t = setInterval(load, open ? 3000 : 15_000);
    return () => clearInterval(t);
  }, [open]);

  return (
    <div className="relative">
      <button className={`btn-ghost ${runs.length ? 'border-sky-700 text-sky-300' : ''}`} onClick={() => setOpen((o) => !o)} title="Workflows running now: open one here and watch it work">
        Live{runs.length ? ` (${runs.length})` : ''} ▾
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-[440px] rounded-lg border border-[#30363d] bg-[#161b22] p-2 shadow-xl">
          {runs.length === 0 && <p className="p-2 text-sm text-slate-400">Nothing is running right now.</p>}
          {runs.map((r) => {
            const title = `${r.canvasName ?? 'Workflow'} · ${r.source}`;
            const block = r.blocks[0];
            return (
              <button
                key={r.runId}
                className={`block w-full rounded-md px-2 py-1.5 text-left hover:bg-[#21262d] ${r.runId === followingId ? 'bg-sky-950/40' : ''}`}
                onClick={() => {
                  onFollow(r.runId, title);
                  setOpen(false);
                }}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${r.paused?.length ? 'bg-orange-400' : 'animate-pulse bg-emerald-400'}`} />
                  <span className="truncate font-medium">{r.canvasName ?? 'Workflow'}</span>
                  <span className="shrink-0 rounded bg-[#21262d] px-1.5 text-xs text-slate-300">{r.source}</span>
                  <span className="ml-auto shrink-0 text-xs text-slate-500">{since(r.startedAt)}</span>
                </div>
                <div className="truncate pl-4 text-xs text-slate-400">
                  {r.paused?.length ? 'Waiting for you' : block ? `${block.label}${block.model ? ` · ${block.model.split('/').pop()}` : ''}${block.state === 'waiting' ? ' (waiting for the GPU)' : ''}` : r.question}
                </div>
              </button>
            );
          })}
          <p className="px-2 pt-1 text-[11px] text-slate-500">Opening one shows it on the canvas, live; your own workflow comes back with “Back to my workflow”.</p>
        </div>
      )}
    </div>
  );
}
