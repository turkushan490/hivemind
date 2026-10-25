import type { NodeConfig, NodeType } from '@hivemind/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { createContext, memo, useContext } from 'react';
import { IDLE, STATE_COLOR, STATE_LABEL, type NodeView } from '../run/state';
import { NODE_META } from './meta';
import { GpuBar, useNow, WorkBar } from './NodeBars';
import { Aura, Burst, GpuChip, ThinkingCore, ThoughtWords, WritingTail } from './NodeFx';

export type HiveNodeData = { kind: NodeType; label?: string; config: NodeConfig };
export type HiveFlowNode = Node<HiveNodeData, 'hive'>;

/** Live run state per node id; a context so streaming tokens don't rebuild the whole graph. */
export const RunViews = createContext<Record<string, NodeView>>({});

function HiveNodeImpl({ id, data, selected }: NodeProps<HiveFlowNode>) {
  const meta = NODE_META[data.kind];
  const view = useContext(RunViews)[id] ?? IDLE;
  const stateColor = STATE_COLOR[view.state];
  const border = view.state === 'idle' ? (selected ? meta.color : '#30363d') : stateColor;
  const missingModel = meta.usesModel && !data.config.model;
  const loadingGpu = view.local && view.state === 'loading' && !!view.loadStartedAt && !view.readyAt;

  return (
    <div className={`relative w-64 ${view.state === 'queued' ? 'hm-breathe' : ''}`}>
      <Aura state={view.state} />
      <Burst state={view.state} />
      {meta.hasInput && <Handle type="target" position={Position.Left} className="hm-handle" />}
      <div
        className="relative overflow-hidden rounded-xl border bg-[#161b22] text-left shadow-lg"
        style={{ borderColor: border, boxShadow: selected ? `0 0 0 1px ${meta.color}` : undefined }}
      >
        <div className="h-1" style={{ background: meta.color }} />
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold tracking-wider uppercase" style={{ color: meta.color }}>
              {meta.title}
            </span>
            {view.state !== 'idle' && (
              <span className="ml-auto rounded-full px-2 py-px text-[10px] font-semibold" style={{ color: stateColor, background: `${stateColor}22` }}>
                {STATE_LABEL[view.state]}
              </span>
            )}
          </div>
          <div className="truncate text-sm font-semibold text-slate-100">{data.label || meta.title}</div>
          {meta.usesModel && (
            <div className={`truncate text-xs ${missingModel ? 'text-red-400' : 'text-slate-400'}`} title={data.config.model?.model}>
              {data.config.model?.model ?? 'Pick a model →'}
            </div>
          )}

          {view.state === 'thinking' && (
            <div className="flex items-center gap-1 rounded-lg bg-violet-950/40 px-1 py-0.5">
              <ThinkingCore />
              <ThoughtWords text={view.thinking ?? ''} />
            </div>
          )}
          {view.state === 'streaming' && <WritingTail text={view.text} />}
          {loadingGpu && <LoadingChip v={view} />}

          {meta.usesModel && view.state !== 'idle' && (
            <div className="space-y-1.5 pt-0.5">
              <GpuBar v={view} />
              <WorkBar v={view} />
            </div>
          )}
          {view.error && <div className="line-clamp-2 text-xs text-red-300">{view.error}</div>}
        </div>
      </div>
      {meta.hasOutput && <Handle type="source" position={Position.Right} className="hm-handle" />}
    </div>
  );
}

/** GPU chip lighting up core by core while the model loads (timed like the GPU bar). */
function LoadingChip({ v }: { v: NodeView }) {
  const now = useNow(true);
  const pct = v.loadStartedAt ? ((now - v.loadStartedAt) / (v.loadExpectedMs ?? 8000)) * 100 : 0;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-amber-950/30 px-1.5 py-1">
      <GpuChip pct={pct} />
      <span className="text-[11px] text-amber-200">Moving the model into the GPU…</span>
    </div>
  );
}

export const HiveNode = memo(HiveNodeImpl);
