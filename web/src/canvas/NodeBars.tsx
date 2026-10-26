import { useContext, useEffect, useState } from 'react';
import { Clock, type NodeView } from '../run/state';

/** Re-renders a few times per second while `on`, for timers that move without new events. */
export function useNow(on: boolean) {
  const clock = useContext(Clock);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, [on]);
  return clock();
}

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const gb = (b?: number) => (b ? `${(b / 1e9).toFixed(1)} GB` : '');

function Bar(props: { pct: number; color: string; flow?: boolean; label: string; right?: string; dim?: boolean; big?: boolean }) {
  return (
    <div className="space-y-0.5">
      <div className={`flex items-center gap-2 ${props.big ? 'text-xs' : 'text-[10px]'} ${props.dim ? 'text-slate-500' : 'text-slate-300'}`}>
        <span className="truncate">{props.label}</span>
        {props.right && <span className="ml-auto shrink-0 font-mono text-slate-400">{props.right}</span>}
      </div>
      <div className={`${props.big ? 'h-2' : 'h-1.5'} overflow-hidden rounded bg-[#21262d]`}>
        <div
          className={`h-full rounded transition-[width] duration-200 ease-linear ${props.flow ? 'hm-flow' : ''}`}
          style={{ width: `${Math.max(0, Math.min(100, props.pct))}%`, backgroundColor: props.color }}
        />
      </div>
    </div>
  );
}

/**
 * Local models get a GPU bar: waiting for the GPU, loading into it (timed against this model's last real load),
 * then loaded / already loaded. Ollama reports no live load progress, so the bar never claims more than it knows:
 * it stops at 97% until the model actually answers.
 */
export function GpuBar({ v, big }: { v: NodeView; big?: boolean }) {
  const loadingNow = v.state === 'queued' || (v.state === 'loading' && !v.readyAt);
  const now = useNow(loadingNow);
  if (!v.local) return null;

  if (v.state === 'queued')
    return <Bar big={big} pct={100} color="#30363d" flow label="Waiting for the GPU" right={v.queuedAt ? secs(now - v.queuedAt) : undefined} dim />;

  if (v.readyAt || v.state === 'done') {
    const took = v.loadMs ?? (v.loadStartedAt && v.readyAt ? v.readyAt - v.loadStartedAt : undefined);
    const label = v.warm ? 'Already in GPU' : took !== undefined ? `Loaded into GPU in ${secs(took)}` : 'In GPU';
    return <Bar big={big} pct={100} color="#10b981" label={label} right={gb(v.sizeBytes)} />;
  }

  if (v.state === 'error') return <Bar big={big} pct={100} color="#7f1d1d" label="GPU" dim />;

  if (v.loadStartedAt) {
    const elapsed = now - v.loadStartedAt;
    const expected = v.loadExpectedMs ?? 8000;
    const over = elapsed > expected;
    return (
      <Bar
        big={big}
        pct={over ? 97 : (elapsed / expected) * 97}
        color="#f59e0b"
        label={over ? 'Loaded, reading the input…' : `Loading into GPU${v.sizeBytes ? ` · ${gb(v.sizeBytes)}` : ''}`}
        right={`${secs(elapsed)} / ${v.loadEstimated ? '~' : ''}${secs(expected)}`}
      />
    );
  }
  // Started, but the provider hasn't said yet whether it must load.
  return <Bar big={big} pct={4} color="#f59e0b" label="Checking the GPU…" dim />;
}

/** What the model is doing: thinking, then writing the answer. Stripes flow forward only. */
export function WorkBar({ v, big }: { v: NodeView; big?: boolean }) {
  const active = v.state === 'thinking' || v.state === 'streaming' || (v.state === 'loading' && !v.local);
  const now = useNow(active);
  const since = v.readyAt ?? v.startedAt;
  const tps = v.tps !== undefined ? ` · ${v.tps.toFixed(0)} t/s` : '';

  switch (v.state) {
    case 'idle':
    case 'skipped':
      return null;
    case 'queued':
      return <Bar big={big} pct={0} color="#6e7681" label="Starts when the GPU is free" dim />;
    case 'loading':
      return v.local ? (
        <Bar big={big} pct={0} color="#6e7681" label="Starts after loading" dim />
      ) : (
        <Bar big={big} pct={100} color="#6e7681" flow label="Waiting for the first words" right={since ? secs(now - since) : undefined} dim />
      );
    case 'thinking':
      return <Bar big={big} pct={100} color="#8b5cf6" flow label="Thinking" right={since ? secs(now - since) : undefined} />;
    case 'streaming':
      return <Bar big={big} pct={100} color="#06b6d4" flow label={`Writing · ${v.tokens ?? 0} tok${tps}`} right={since ? secs(now - since) : undefined} />;
    case 'done':
      return <Bar big={big} pct={100} color="#10b981" label={`Done · ${v.tokens ?? 0} tok${tps}`} right={v.elapsedMs !== undefined ? secs(v.elapsedMs) : undefined} />;
    case 'error':
      return <Bar big={big} pct={100} color="#ef4444" label="Failed" />;
  }
}
