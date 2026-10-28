import type { NodeConfig, NodeType } from '@hivemind/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { createContext, memo, useContext } from 'react';
import { IDLE, STATE_COLOR, STATE_LABEL, type NodeView } from '../run/state';
import { NODE_META, summary } from './meta';
import { GpuBar, useNow, WorkBar } from './NodeBars';
import { Aura, Burst, GpuChip, ThinkingCore, ThoughtWords, WritingTail } from './NodeFx';
import { MicButton } from '../voice';
import { DecisionBars } from './DecisionBars';

export type HiveNodeData = { kind: NodeType; label?: string; config: NodeConfig };
export type HiveFlowNode = Node<HiveNodeData, 'hive'>;

/** Live run state per node id; a context so streaming tokens don't rebuild the whole graph. */
export const RunViews = createContext<Record<string, NodeView>>({});

/** Question block mic: hands the transcribed text to the canvas, which fills it in and runs. */
export const InputMic = createContext<((text: string) => void) | null>(null);

function HiveNodeImpl({ id, data, selected }: NodeProps<HiveFlowNode>) {
  const meta = NODE_META[data.kind];
  const view = useContext(RunViews)[id] ?? IDLE;
  const stateColor = STATE_COLOR[view.state];
  const border = view.state === 'idle' ? (selected ? meta.color : '#30363d') : stateColor;
  const info = summary(data.kind, data.config);
  const usesModels = meta.usesModel || !!meta.multiModel;
  const onSpoken = useContext(InputMic);
  const loadingGpu = view.local && view.state === 'loading' && !!view.loadStartedAt && !view.readyAt;

  return (
    <div className={`relative w-64 ${view.state === 'queued' ? 'hm-breathe' : ''} ${view.state === 'skipped' ? 'opacity-40' : ''}`}>
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
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">{data.label || meta.title}</div>
            {data.kind === 'input' && onSpoken && <MicButton size="sm" onText={onSpoken} />}
          </div>
          {info && (
            <div className={`truncate text-xs ${info.missing ? 'text-red-400' : 'text-slate-400'}`} title={info.text}>
              {info.text}
            </div>
          )}
          {view.note && view.state !== 'idle' && <div className="truncate text-[11px] font-medium text-amber-200/90">{view.note}</div>}

          {view.state === 'thinking' && (
            <div className="flex items-center gap-1 rounded-lg bg-violet-950/40 px-1 py-0.5">
              <ThinkingCore />
              <ThoughtWords text={view.thinking ?? ''} />
            </div>
          )}
          {view.decision && view.state !== 'idle' && (
            <div className="rounded-lg border border-indigo-900/50 bg-indigo-950/25 py-1">
              <DecisionBars d={view.decision} />
            </div>
          )}
          {data.kind === 'decide' && !view.decision && <BranchChips config={data.config} />}
          {view.state === 'streaming' && <WritingTail text={view.text} />}
          {loadingGpu && <LoadingChip v={view} />}

          {usesModels && view.state !== 'idle' && view.state !== 'skipped' && (
            <div className="space-y-1.5 pt-0.5">
              <GpuBar v={view} />
              {data.kind !== 'decide' && <WorkBar v={view} />}
            </div>
          )}
          {view.files?.some((f) => f.kind === 'image') && (
            <div className="grid grid-cols-2 gap-1">
              {view.files
                .filter((f) => f.kind === 'image')
                .slice(0, 4)
                .map((f) => (
                  <img key={f.path} src={`/api/files/raw?inline=1&path=${encodeURIComponent(f.path)}`} alt="" className="hm-pop aspect-square w-full rounded-md object-cover" />
                ))}
            </div>
          )}
          {view.files?.some((f) => f.kind !== 'image') && (
            <div className="truncate text-[11px] text-yellow-200/90">📄 {view.files.filter((f) => f.kind !== 'image').map((f) => f.path.split('/').pop()).join(', ')}</div>
          )}
          {view.error && <div className="line-clamp-2 text-xs text-red-300">{view.error}</div>}
        </div>
      </div>
      {meta.hasOutput && <Handle type="source" position={Position.Right} className="hm-handle" />}
    </div>
  );
}

/** Idle Decide block: the answers its branches can be named after. */
function BranchChips({ config }: { config: NodeConfig }) {
  const q = (config.questions ?? []).find((x) => x.type === 'noul' || x.type === 'choice');
  if (!q) return null;
  const values = q.type === 'noul' ? ['yes', 'no'] : (q.options ?? []).map((o) => o.name).filter(Boolean);
  return (
    <div className="flex flex-wrap gap-1" title="Name the blocks after this one like this; only the winner runs">
      {[...values, 'fallback'].slice(0, 7).map((v) => (
        <span key={v} className="rounded-full border border-indigo-800/70 px-1.5 text-[10px] text-indigo-200/80">
          {v}
        </span>
      ))}
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
