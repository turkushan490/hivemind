import type { CanvasGraph, ModelRef, RunEvent } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

export type NodeState = 'idle' | 'queued' | 'loading' | 'thinking' | 'streaming' | 'done' | 'error';

export interface NodeView {
  state: NodeState;
  text: string;
  thinking?: string;
  tokens?: number;
  tps?: number;
  elapsedMs?: number;
  cost?: number;
  error?: string;
  startedAt?: number;
  /** Local model (Ollama): gets a separate GPU bar. */
  local?: boolean;
  queuedAt?: number;
  /** GPU loading: when it began, how long it should take, and when the model was ready. */
  loadStartedAt?: number;
  loadExpectedMs?: number;
  loadEstimated?: boolean;
  readyAt?: number;
  /** Was already in memory, no loading. */
  warm?: boolean;
  /** Real load time reported when the block finished. */
  loadMs?: number;
  sizeBytes?: number;
}

export const IDLE: NodeView = { state: 'idle', text: '' };

export const modelKey = (m: ModelRef) => `${m.providerId}|${m.model}`;
export const parseModelKey = (k: string): ModelRef => {
  const i = k.indexOf('|');
  return { providerId: k.slice(0, i), model: k.slice(i + 1) };
};

export const STATE_TEXT: Record<NodeState, string> = {
  idle: 'text-slate-500',
  queued: 'text-slate-400',
  loading: 'text-amber-400',
  thinking: 'text-violet-400',
  streaming: 'text-cyan-400',
  done: 'text-emerald-400',
  error: 'text-red-400',
};

/** Hex colours per state, for borders, glows and wires. */
export const STATE_COLOR: Record<NodeState, string> = {
  idle: '#30363d',
  queued: '#6e7681',
  loading: '#f59e0b',
  thinking: '#a78bfa',
  streaming: '#22d3ee',
  done: '#34d399',
  error: '#f87171',
};

export const STATE_LABEL: Record<NodeState, string> = {
  idle: 'idle',
  queued: 'queued',
  loading: 'loading',
  thinking: 'thinking',
  streaming: 'writing',
  done: 'done',
  error: 'error',
};

/** Folds run events into per-node state. Every animation is driven only by these events. */
export function applyEvent(views: Record<string, NodeView>, ev: RunEvent): Record<string, NodeView> {
  if (!ev.nodeId) return views;
  const v: NodeView = views[ev.nodeId] ?? IDLE;
  let next: NodeView = v;
  switch (ev.type) {
    case 'node_queued':
      next = { ...v, state: 'queued', queuedAt: ev.ts };
      break;
    case 'node_start':
      next = { ...v, state: 'loading', startedAt: ev.ts, local: ev.local };
      break;
    case 'model_loading':
      next = { ...v, state: 'loading', loadStartedAt: ev.ts, loadExpectedMs: ev.expectedMs, loadEstimated: ev.estimated, sizeBytes: ev.sizeBytes };
      break;
    case 'model_ready':
      next = { ...v, readyAt: ev.ts, warm: ev.warm };
      break;
    case 'thinking':
      next = { ...v, state: 'thinking', thinking: (v.thinking ?? '') + (ev.text ?? '') };
      break;
    case 'token':
      next = { ...v, state: 'streaming', text: v.text + (ev.text ?? ''), tokens: ev.tokens, tps: ev.tokensPerSec ?? v.tps };
      break;
    case 'node_done':
      next = {
        ...v,
        state: 'done',
        text: ev.text ?? v.text,
        tokens: ev.tokens,
        tps: ev.tokensPerSec,
        elapsedMs: ev.elapsedMs,
        cost: ev.cost,
        loadMs: ev.loadMs ?? v.loadMs,
        sizeBytes: ev.sizeBytes ?? v.sizeBytes,
      };
      break;
    case 'error':
      next = { ...v, state: 'error', error: ev.error };
      break;
  }
  return { ...views, [ev.nodeId]: next };
}

export interface RunFinal {
  text?: string;
  status?: string;
  cost?: number;
}

/**
 * Starts runs and follows their live event stream: per-node views, errors, the final answer,
 * and reconnecting after a dropped connection (the server replays the run, so state is rebuilt).
 */
export function useRun(onProblem?: () => void) {
  const [runId, setRunId] = useState('');
  const [views, setViews] = useState<Record<string, NodeView>>({});
  const [final, setFinal] = useState<RunFinal | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [connLost, setConnLost] = useState(false);
  const source = useRef<EventSource | null>(null);
  const [, tick] = useState(0);

  useEffect(() => () => source.current?.close(), []);

  // Live elapsed timers while a run is going.
  const running = !!runId && !final;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [running]);

  const start = async (body: { question: string; graph: CanvasGraph; canvasId?: string }) => {
    const label = (id?: string) => {
      const n = body.graph.nodes.find((x) => x.id === id);
      return n?.label || n?.config.model?.model || n?.type || 'Run';
    };
    const { runId } = await api<{ runId: string }>('/api/runs', { body });
    setViews({});
    setFinal(null);
    setErrors([]);
    setRunId(runId);
    source.current?.close();
    let lost = false;
    const es = new EventSource(`/api/runs/${runId}/events`);
    source.current = es;
    es.onopen = () => {
      if (lost) {
        setViews({});
        setErrors([]);
        toast('Reconnected to the server', 'ok');
      }
      lost = false;
      setConnLost(false);
    };
    es.onerror = () => {
      lost = true;
      setConnLost(true);
    };
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as RunEvent;
      setViews((v) => applyEvent(v, ev));
      if (ev.type === 'error' && ev.error !== 'Cancelled' && ev.error !== 'All inputs failed') {
        const msg = `${label(ev.nodeId)} failed: ${ev.error}`;
        setErrors((e) => (e.includes(msg) ? e : [...e, msg]));
        if (!lost) {
          toast(msg);
          onProblem?.();
        }
      }
      if (ev.type === 'run_done') setFinal({ text: ev.final, status: ev.status, cost: ev.cost });
    };
    es.addEventListener('end', () => {
      es.close();
      setConnLost(false);
    });
  };

  const cancel = () => runId && api(`/api/runs/${runId}/cancel`, { method: 'POST', quiet: true }).catch(() => {});
  const reset = () => {
    source.current?.close();
    setRunId('');
    setViews({});
    setFinal(null);
    setErrors([]);
  };

  return { runId, views, final, errors, connLost, running, start, cancel, reset };
}

/** Elapsed seconds of a node: final time when done, live time while running. */
export const elapsedOf = (v: NodeView) => (v.elapsedMs ?? (v.startedAt ? Date.now() - v.startedAt : undefined));
