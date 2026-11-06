import type { ActivityRunning, ActiveRun, ApiCall, RunEvent } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { PausePanel } from '../components/PausePanel';

/** sqlite's datetime('now') is UTC without a zone marker. */
const parseDb = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
const since = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * What is running now and what came in through the API. Polls every 3 seconds while open. An admin sees
 * everything, anyone else only their own.
 */
export function ActivityPage({ active, isAdmin, onOpenLab, onFollow }: { active: boolean; isAdmin: boolean; onOpenLab: () => void; onFollow: (runId: string, title: string) => void }) {
  const [now, setNow] = useState<ActivityRunning | null>(null);
  const [calls, setCalls] = useState<ApiCall[]>([]);
  const [token, setToken] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [watch, setWatch] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const load = async () => {
      const q = new URLSearchParams({ limit: '200', ...(token && { token }), ...(failedOnly && { failed: '1' }) });
      const [r, c] = await Promise.all([
        api<ActivityRunning>('/api/activity/running', { quiet: true }).catch(() => null),
        api<ApiCall[]>(`/api/activity/calls?${q}`, { quiet: true }).catch(() => null),
      ]);
      if (r) setNow(r);
      if (c) setCalls(c);
      tick((n) => n + 1);
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, token, failedOnly]);

  const [tokens, setTokens] = useState<string[]>([]);
  useEffect(() => setTokens((old) => [...new Set([...old, ...calls.map((c) => c.token)])].sort()), [calls]);

  const stop = async (r: ActiveRun) => {
    try {
      await api(`/api/runs/${r.runId}/cancel`, { method: 'POST' });
      toast(`Stopped ${r.canvasName ?? 'the run'}`, 'ok');
    } catch {}
  };

  const waiting = (now?.runs ?? []).flatMap((r) => (r.mine || isAdmin ? (r.paused ?? []).map((p) => ({ run: r, pause: p })) : []));

  return (
    <div className="space-y-6">
      {waiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold text-orange-300">Waiting for you ({waiting.length})</h2>
          {waiting.map(({ run, pause }) => (
            <div key={`${run.runId}-${pause.nodeId}`} className="space-y-1">
              <div className="text-xs text-slate-400">
                {run.canvasName ?? 'Ad-hoc workflow'} · {run.source}
                {!run.mine && ` · by ${run.owner}`}
              </div>
              <PausePanel runId={run.runId} pause={pause} />
            </div>
          ))}
        </section>
      )}
      <section className="space-y-2">
        <h2 className="font-semibold">Running now</h2>
        {!now && <p className="text-sm text-slate-400">Loading…</p>}
        {now && now.runs.length === 0 && now.training.length === 0 && <p className="text-sm text-slate-400">Nothing is running.</p>}
        {now?.runs.map((r) => (
          <div key={r.runId} className="card space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{r.canvasName ?? 'Ad-hoc workflow'}</span>
              <span className="rounded bg-[#21262d] px-1.5 text-xs text-slate-300">{r.source}</span>
              {!r.mine && <span className="text-xs text-slate-400">by {r.owner}</span>}
              <span className="text-xs text-slate-500">{since(r.startedAt)}</span>
              <span className="ml-auto" />
              <button className="text-xs text-sky-400 hover:underline" title="Open it on the Workflow page, live, with its animations" onClick={() => onFollow(r.runId, `${r.canvasName ?? 'Workflow'} · ${r.source}`)}>
                Follow on canvas
              </button>
              <button className="text-xs text-indigo-400 hover:underline" onClick={() => setWatch(watch === r.runId ? null : r.runId)}>
                {watch === r.runId ? 'Hide' : 'Open live run'}
              </button>
              {(r.mine || isAdmin) && (
                <button className="btn bg-red-600 px-2 py-0.5 text-xs hover:bg-red-500" onClick={() => stop(r)}>
                  Stop
                </button>
              )}
            </div>
            <p className="truncate text-xs text-slate-400" title={r.question}>
              {r.question}
            </p>
            {r.blocks.length === 0 && <p className="text-xs text-slate-500">Between blocks.</p>}
            {r.blocks.map((b) => (
              <div key={b.nodeId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${b.state === 'running' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                <span className="text-slate-200">{b.label}</span>
                {b.model && <span className="text-slate-400">{b.model}</span>}
                {b.state === 'running' ? (
                  <span className="text-slate-500">
                    {since(b.startedAt)} · {b.tokens.toLocaleString()} tokens
                  </span>
                ) : (
                  <span className="text-amber-300">{b.waitingBehind ? `Waiting for the GPU behind ${b.waitingBehind}` : 'Waiting for the GPU'}</span>
                )}
              </div>
            ))}
            {watch === r.runId && <LiveRun runId={r.runId} />}
          </div>
        ))}
        {now?.training.map((t) => (
          <div key={t.id} className="card flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Training {t.name}</span>
            <span className="text-xs text-slate-400">{t.base}</span>
            <span className="rounded bg-[#21262d] px-1.5 text-xs text-slate-300">{t.state}</span>
            {isAdmin && <span className="text-xs text-slate-400">by {t.owner}</span>}
            {Number.isFinite(parseDb(t.startedAt)) && <span className="text-xs text-slate-500">{since(parseDb(t.startedAt))}</span>}
            <button className="ml-auto text-xs text-indigo-400 hover:underline" onClick={onOpenLab}>
              Open Lab
            </button>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">Incoming API calls</h2>
          <span className="text-xs text-slate-500">requests with an API token, the last 1,000 (kept in memory only)</span>
          <span className="ml-auto" />
          <select className="input w-48 py-1 text-xs" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token">
            <option value="">All tokens</option>
            {tokens.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
            Failed only
          </label>
        </div>
        {calls.length === 0 ? (
          <p className="text-sm text-slate-400">No API calls yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[#30363d]">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#161b22] text-slate-400">
                <tr>
                  <th className="px-2 py-1.5">Time</th>
                  <th className="px-2 py-1.5">Token</th>
                  <th className="px-2 py-1.5">User</th>
                  <th className="px-2 py-1.5">Request</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5 text-right">ms</th>
                  <th className="px-2 py-1.5">Workflow</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c, i) => (
                  <tr key={`${c.at}-${i}`} className="border-t border-[#30363d]">
                    <td className="px-2 py-1 whitespace-nowrap text-slate-400">{new Date(c.at).toLocaleTimeString()}</td>
                    <td className="px-2 py-1">{c.token}</td>
                    <td className="px-2 py-1 text-slate-400">{c.user ?? '—'}</td>
                    <td className="px-2 py-1 font-mono">
                      {c.method} {c.route}
                    </td>
                    <td className={`px-2 py-1 ${c.status >= 400 ? 'text-red-400' : 'text-emerald-300'}`}>{c.status}</td>
                    <td className="px-2 py-1 text-right text-slate-400">{c.ms}</td>
                    <td className="px-2 py-1">
                      {c.runId && (
                        <>
                          <button className="text-indigo-400 hover:underline" onClick={() => setWatch(watch === c.runId ? null : c.runId!)}>
                            {c.canvasName ?? 'run'}
                          </button>
                          <button className="ml-2 text-sky-400 hover:underline" title="Open it on the Workflow page, with its animations" onClick={() => onFollow(c.runId!, `${c.canvasName ?? 'Workflow'} · API: ${c.token}`)}>
                            canvas
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {watch && !now?.runs.some((r) => r.runId === watch) && (
          <div className="card space-y-2">
            <div className="flex items-center text-sm">
              <span className="font-medium">Run {watch}</span>
              <button className="ml-auto text-xs text-indigo-400 hover:underline" onClick={() => setWatch(null)}>
                Close
              </button>
            </div>
            <LiveRun runId={watch} />
          </div>
        )}
      </section>
    </div>
  );
}

/** A run's events as they come (or its replay when it has finished): what each block writes, the newest at the bottom. */
function LiveRun({ runId }: { runId: string }) {
  const [lines, setLines] = useState<{ key: string; label: string; text: string; error?: boolean }[]>([]);
  const [state, setState] = useState('Connecting…');
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines([]);
    setState('Connecting…');
    const labels = new Map<string, string>();
    const es = new EventSource(`/api/runs/${runId}/events`);
    const add = (key: string, label: string, text: string, error?: boolean) =>
      setLines((l) => {
        const last = l.at(-1);
        if (last && last.key === key && !error) return [...l.slice(0, -1), { ...last, text: (last.text + text).slice(-4000) }];
        return [...l, { key, label, text, error }].slice(-30);
      });
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as RunEvent;
      if (ev.type === 'run_start') {
        setState('Running');
        for (const n of ev.graph?.nodes ?? []) labels.set(n.id, n.label || n.config.model?.model || n.type);
      }
      const label = (ev.nodeId && labels.get(ev.nodeId)) || ev.nodeId || '';
      if (ev.type === 'thinking' && ev.text) add(`${ev.nodeId}:think`, `${label} (thinking)`, ev.text);
      if (ev.type === 'token' && ev.text) add(`${ev.nodeId}:out`, label, ev.text);
      if (ev.type === 'node_progress' && ev.note) add(`${ev.nodeId}:note:${ev.seq}`, label, ev.note);
      if (ev.type === 'error' && ev.error) add(`${ev.nodeId}:err:${ev.seq}`, label || 'Run', ev.error, true);
      if (ev.type === 'run_done' && ev.seq >= 0) setState(`Finished: ${ev.status}`);
    };
    es.addEventListener('end', () => {
      setState((s) => (s.startsWith('Finished') ? s : 'Finished'));
      es.close();
    });
    es.addEventListener('error', () => {
      setState((s) => (s.startsWith('Finished') ? s : 'Not available (finished, or not yours)'));
      es.close();
    });
    return () => es.close();
  }, [runId]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  return (
    <div className="space-y-1">
      <div className="text-xs text-slate-400">{state}</div>
      <pre ref={box} className="max-h-64 overflow-y-auto rounded-md bg-[#0d1117] p-2 text-xs whitespace-pre-wrap text-slate-300">
        {lines.length === 0
          ? 'Nothing yet.'
          : lines.map((l, i) => (
              <div key={i} className={l.error ? 'text-red-400' : undefined}>
                <span className="text-slate-500">{l.label}: </span>
                {l.text}
              </div>
            ))}
      </pre>
    </div>
  );
}
