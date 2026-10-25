import type { Problem } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';

const SOURCE: Record<Problem['source'], { label: string; cls: string }> = {
  crash: { label: 'server crash', cls: 'bg-red-600 text-white' },
  server: { label: 'server', cls: 'bg-red-900/60 text-red-200' },
  run: { label: 'run', cls: 'bg-amber-900/60 text-amber-200' },
  provider: { label: 'provider', cls: 'bg-violet-900/60 text-violet-200' },
  web: { label: 'web page', cls: 'bg-slate-700 text-slate-200' },
};

export function Problems({ onSeen }: { onSeen: () => void }) {
  const [list, setList] = useState<Problem[]>([]);

  const load = async () => {
    setList(await api<Problem[]>('/api/problems'));
    await api('/api/problems/seen', { method: 'POST' });
    onSeen();
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">Problems</h2>
        <span className="text-sm text-slate-400">Crashes, failed models and errors, newest first. Kept after restarts.</span>
        <button className="btn-ghost ml-auto" onClick={load}>
          Refresh
        </button>
        <button
          className="btn-ghost text-red-400"
          disabled={list.length === 0}
          onClick={async () => {
            if (!confirm('Clear the problem log?')) return;
            await api('/api/problems', { method: 'DELETE' });
            load();
          }}
        >
          Clear
        </button>
      </div>
      {list.length === 0 && <p className="text-sm text-emerald-400">No problems. Everything ran fine.</p>}
      {list.map((p) => (
        <details key={p.id} className={`rounded-md border p-2 text-sm ${p.seen ? 'border-[#30363d]' : 'border-red-800 bg-red-950/20'}`}>
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 text-xs ${SOURCE[p.source]?.cls ?? ''}`}>{SOURCE[p.source]?.label ?? p.source}</span>
            <span className="text-xs text-slate-500">#{p.id} · {new Date(p.at.replace(' ', 'T') + 'Z').toLocaleString()}</span>
            <span className="w-full break-words text-slate-200">{p.message}</span>
          </summary>
          {p.runId && <p className="mt-1 text-xs text-slate-500">Run {p.runId}</p>}
          {p.detail && <pre className="mt-2 max-h-72 overflow-auto text-xs whitespace-pre-wrap text-slate-400">{p.detail}</pre>}
        </details>
      ))}
    </div>
  );
}
