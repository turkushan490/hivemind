import type { NodeConfig, NodeType } from '@hivemind/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { createContext, memo, useContext } from 'react';
import { elapsedOf, IDLE, STATE_COLOR, STATE_LABEL, type NodeView } from '../run/state';
import { NODE_META } from './meta';

export type HiveNodeData = { kind: NodeType; label?: string; config: NodeConfig };
export type HiveFlowNode = Node<HiveNodeData, 'hive'>;

/** Live run state per node id; a context so streaming tokens don't rebuild the whole graph. */
export const RunViews = createContext<Record<string, NodeView>>({});

const ACTIVE = new Set(['loading', 'thinking', 'streaming']);

function HiveNodeImpl({ id, data, selected }: NodeProps<HiveFlowNode>) {
  const meta = NODE_META[data.kind];
  const view = useContext(RunViews)[id] ?? IDLE;
  const active = ACTIVE.has(view.state);
  const stateColor = STATE_COLOR[view.state];
  const border = view.state === 'idle' ? (selected ? meta.color : '#30363d') : stateColor;
  const missingModel = meta.usesModel && !data.config.model;
  const elapsed = elapsedOf(view);

  return (
    <div
      className={`w-60 rounded-xl border bg-[#161b22] text-left shadow-lg ${active ? 'hm-node-active' : ''}`}
      style={{ borderColor: border, ['--glow' as string]: stateColor, boxShadow: selected ? `0 0 0 1px ${meta.color}` : undefined }}
    >
      {meta.hasInput && <Handle type="target" position={Position.Left} className="hm-handle" />}
      <div className="h-1 rounded-t-xl" style={{ background: meta.color }} />
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
        {(meta.usesModel || view.state !== 'idle') && (
          <div className="h-1 overflow-hidden rounded bg-[#21262d]">
            <div
              className={`h-full rounded ${view.state === 'streaming' || view.state === 'loading' ? 'hm-bar-live' : ''}`}
              style={{
                background: stateColor,
                width: view.state === 'done' || view.state === 'error' ? '100%' : active ? undefined : view.state === 'thinking' ? '35%' : '0%',
              }}
            />
          </div>
        )}
        {view.state !== 'idle' && (
          <div className="flex gap-2.5 font-mono text-[11px] text-slate-400">
            {view.tokens !== undefined && <span>{view.tokens} tok</span>}
            {view.tps !== undefined && <span>{view.tps.toFixed(0)} t/s</span>}
            {elapsed !== undefined && <span>{(elapsed / 1000).toFixed(1)}s</span>}
            {view.state === 'thinking' && <span className="text-violet-300">thinking…</span>}
          </div>
        )}
        {view.error && <div className="line-clamp-2 text-xs text-red-300">{view.error}</div>}
      </div>
      {meta.hasOutput && <Handle type="source" position={Position.Right} className="hm-handle" />}
    </div>
  );
}

export const HiveNode = memo(HiveNodeImpl);
