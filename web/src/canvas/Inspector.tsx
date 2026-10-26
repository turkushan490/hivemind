import { JUDGE_SYSTEM, REVIEW_SYSTEM, type ModelInfo, type NodeConfig, type ProviderInfo } from '@hivemind/shared';
import { useContext } from 'react';
import { Clock, elapsedOf, IDLE, STATE_LABEL, STATE_TEXT, type NodeView, type RunFinal } from '../run/state';
import type { HiveFlowNode } from './HiveNode';
import { NODE_META } from './meta';
import { ModelPicker } from './ModelPicker';
import { AnswerView } from '../components/AnswerView';
import { BlockSettings } from './BlockSettings';
import { GpuBar, WorkBar } from './NodeBars';

const SYSTEM_DEFAULT: Partial<Record<string, string>> = { judge: JUDGE_SYSTEM, review: REVIEW_SYSTEM };

export function Inspector(props: {
  node?: HiveFlowNode;
  view?: NodeView;
  models: ModelInfo[];
  providers: ProviderInfo[];
  onChange: (patch: { label?: string; config?: Partial<NodeConfig> }) => void;
  onDelete: () => void;
  final: RunFinal | null;
  errors: string[];
  running: boolean;
}) {
  const { node } = props;
  const clock = useContext(Clock);

  if (!node)
    return (
      <div className="space-y-4 p-4 text-sm">
        {props.errors.length > 0 && (
          <div role="alert" className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-red-200">
            <div className="mb-1 font-semibold">
              {props.errors.length} problem{props.errors.length > 1 ? 's' : ''} in this run
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-xs">
              {props.errors.map((e) => (
                <li key={e} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        )}
        {props.final ? (
          <div className={`rounded-lg border p-3 ${props.final.status === 'done' ? 'border-emerald-800' : 'border-red-800'}`}>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-semibold">Final answer</span>
              <span className="text-xs text-slate-400">
                {props.final.status}
                {props.final.cost ? ` · $${props.final.cost.toFixed(5)}` : ''}
              </span>
            </div>
            {props.final.text ? (
              <div className="max-h-[70vh] overflow-y-auto">
                <AnswerView text={props.final.text} files={props.final.files} compact />
              </div>
            ) : (
              <p className="text-sm text-slate-400">{props.final.status === 'cancelled' ? 'Cancelled.' : 'No final answer: the run failed.'}</p>
            )}
          </div>
        ) : props.running ? (
          <p className="text-slate-400">Running… click a node to watch it live.</p>
        ) : (
          <div className="space-y-2 text-slate-400">
            <p className="font-semibold text-slate-200">How it works</p>
            <p>Drag blocks from the left onto the canvas, then pull a wire from the dot on the right of one block to the left of another.</p>
            <p>Click a block to pick its model and settings. Select a block or wire and press Delete to remove it.</p>
            <p>Type a question at the top and press Run: you see every model work live.</p>
          </div>
        )}
      </div>
    );

  const meta = NODE_META[node.data.kind];
  const cfg = node.data.config;
  const view = props.view ?? IDLE;
  const elapsed = elapsedOf(view, clock());

  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="space-y-1">
        <div className="text-[11px] font-semibold tracking-wider uppercase" style={{ color: meta.color }}>
          {meta.title}
        </div>
        <input className="input font-semibold" value={node.data.label ?? ''} placeholder={meta.title} onChange={(e) => props.onChange({ label: e.target.value })} />
        <p className="text-xs text-slate-400">{meta.description}</p>
      </div>

      {meta.usesModel && (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-slate-300">Model</div>
          {/* Keyed by block, so switching blocks never shows the previous block's open/closed list or search. */}
          <ModelPicker key={node.id} kind={node.data.kind === 'image' ? 'image' : 'text'} models={props.models} providers={props.providers} value={cfg.model} onChange={(model) => props.onChange({ config: { model } })} />
        </div>
      )}

      <BlockSettings
        nodeId={node.id}
        kind={node.data.kind}
        config={cfg}
        models={props.models}
        providers={props.providers}
        onChange={(config) => props.onChange({ config })}
      />

      {view.state !== 'idle' && (
        <div className="space-y-2 rounded-lg border border-[#30363d] p-3">
          <div className="flex items-center gap-3 text-xs">
            <span className={`font-semibold ${STATE_TEXT[view.state]}`}>{STATE_LABEL[view.state]}</span>
            {view.tokens !== undefined && <span className="text-slate-400">{view.tokens} tok</span>}
            {view.tps !== undefined && <span className="text-slate-400">{view.tps.toFixed(1)} t/s</span>}
            {elapsed !== undefined && <span className="text-slate-400">{(elapsed / 1000).toFixed(1)} s</span>}
            {view.cost !== undefined && view.cost > 0 && <span className="text-slate-400">${view.cost.toFixed(5)}</span>}
          </div>
          {view.note && <p className="text-xs font-medium text-amber-200">{view.note}</p>}
          {(meta.usesModel || !!meta.multiModel) && view.state !== 'skipped' && (
            <div className="space-y-2">
              <GpuBar v={view} big />
              <WorkBar v={view} big />
            </div>
          )}
          {view.error && <p className="rounded bg-red-950/60 px-2 py-1 text-xs break-words text-red-300">{view.error}</p>}
          {view.thinking && (
            <details className="text-xs text-violet-300/80" open={view.state === 'thinking'}>
              <summary className="cursor-pointer">Thinking ({view.thinking.length} chars)</summary>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap">{view.thinking}</pre>
            </details>
          )}
          {view.text &&
            (view.state === 'done' ? (
              <div className="max-h-[55vh] overflow-y-auto">
                <AnswerView text={view.text} files={view.files} compact />
              </div>
            ) : (
              <pre className="max-h-[45vh] overflow-y-auto text-sm whitespace-pre-wrap text-slate-200">{view.text}</pre>
            ))}
        </div>
      )}

      {meta.usesModel && (
        <details className="space-y-2" open={!!(cfg.system || cfg.prompt || cfg.temperature !== undefined)}>
          <summary className="cursor-pointer text-xs font-semibold text-slate-300">Advanced: prompts and temperature</summary>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">System prompt</span>
            <textarea
              className="input min-h-20 text-xs"
              placeholder={SYSTEM_DEFAULT[node.data.kind] ?? 'Optional: how this model should behave'}
              value={cfg.system ?? ''}
              onChange={(e) => props.onChange({ config: { system: e.target.value || undefined } })}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">
              Prompt template — <code>{'{{question}}'}</code> and <code>{'{{inputs}}'}</code> are filled in
            </span>
            <textarea
              className="input min-h-20 text-xs"
              placeholder="Empty = the question, plus the answers wired into this block"
              value={cfg.prompt ?? ''}
              onChange={(e) => props.onChange({ config: { prompt: e.target.value || undefined } })}
            />
          </label>
          <label className="block space-y-1">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={cfg.temperature !== undefined}
                onChange={(e) => props.onChange({ config: { temperature: e.target.checked ? 0.7 : undefined } })}
              />
              Temperature {cfg.temperature !== undefined ? cfg.temperature.toFixed(1) : '(model default)'}
            </span>
            {cfg.temperature !== undefined && (
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                className="w-full"
                value={cfg.temperature}
                onChange={(e) => props.onChange({ config: { temperature: Number(e.target.value) } })}
              />
            )}
          </label>
        </details>
      )}

      <button className="btn-ghost w-full text-red-400" onClick={props.onDelete}>
        Delete block
      </button>
    </div>
  );
}
