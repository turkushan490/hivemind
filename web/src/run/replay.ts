import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { applyEvent, type NodeView, type RunFinal } from './state';

export interface StoredRun {
  id: string;
  question: string;
  status: string;
  final?: string;
  cost?: number;
  events: RunEvent[];
}

interface Folded {
  idx: number;
  views: Record<string, NodeView>;
  final: RunFinal | null;
  errors: string[];
}

const EMPTY: Folded = { idx: 0, views: {}, final: null, errors: [] };

/**
 * Plays a stored run again: the same events, fed with their original timing (times the speed).
 * The canvas animates exactly as it did live, because everything is driven by these events.
 */
export function useReplay() {
  const [run, setRun] = useState<StoredRun | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const cache = useRef<Folded>(EMPTY);

  const start = run?.events[0]?.ts ?? 0;
  const duration = run && run.events.length ? run.events[run.events.length - 1].ts - start : 0;
  const graph: CanvasGraph | undefined = run?.events.find((e) => e.type === 'run_start')?.graph;

  const open = useCallback(async (id: string) => {
    const data = await api<StoredRun>(`/api/runs/${id}`);
    cache.current = EMPTY;
    setRun(data);
    setT(0);
    setPlaying(false);
    return data;
  }, []);

  const close = useCallback(() => {
    setPlaying(false);
    setRun(null);
    cache.current = EMPTY;
  }, []);

  // The playhead: advances with the real clock, multiplied by the speed.
  useEffect(() => {
    if (!playing || !run) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((prev) => {
        const next = Math.min(duration, prev + dt);
        if (next >= duration) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, run, duration]);

  // Fold events up to the playhead; moving forward only applies the new ones, jumping back starts over.
  const folded = useMemo(() => {
    if (!run) return EMPTY;
    const until = start + t;
    let c = cache.current;
    if (c.idx > 0 && run.events[c.idx - 1]?.ts > until) c = EMPTY;
    let { idx, views, final, errors } = c;
    const label = (id?: string) => {
      const n = graph?.nodes.find((x) => x.id === id);
      return n?.label || n?.config.model?.model || n?.type || 'Run';
    };
    while (idx < run.events.length && run.events[idx].ts <= until) {
      const ev = run.events[idx++];
      views = applyEvent(views, ev);
      if (ev.type === 'error' && ev.error !== 'Cancelled' && ev.error !== 'All inputs failed') errors = [...errors, `${label(ev.nodeId)} failed: ${ev.error}`];
      if (ev.type === 'run_done' && ev.seq >= 0) final = { text: ev.final, status: ev.status, cost: ev.cost };
    }
    cache.current = { idx, views, final, errors };
    return cache.current;
  }, [run, t, start, graph]);

  const seek = (ms: number) => setT(Math.max(0, Math.min(duration, ms)));
  const now = useCallback(() => start + t, [start, t]);

  return { run, graph, t, duration, playing, speed, setPlaying, setSpeed, seek, open, close, now, ...folded };
}
