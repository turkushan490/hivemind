import type { CanvasGraph, ModelInfo, ModelRef, ProviderInfo } from '@hivemind/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';
import { BuilderModelChooser } from './BuilderModelChooser';
import { useNow } from './NodeBars';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  fixes?: string[];
  ms?: number;
  error?: boolean;
  applied?: boolean;
}

const EXAMPLES = [
  'Three local models answer, a judge merges the best parts',
  'Search Wikipedia first, then answer with the sources',
  'Coding questions go to one model, everything else to another',
  'Two models debate for 2 rounds, then the strongest decides',
  'Remember every answer, and use what was saved before',
];

/** Chat with the Builder: describe what you need, it builds or changes the canvas. */
export function BuilderPanel(props: {
  graph: CanvasGraph;
  models: ModelInfo[];
  providers: ProviderInfo[];
  onApply: (g: CanvasGraph) => void;
  onUndo?: () => void;
  disabled?: boolean;
}) {
  const [msgs, setMsgs] = useStored<Msg[]>('builder.chat', []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [model, setModel] = useState<ModelRef | null | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const now = useNow(busy !== null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ builderModel?: ModelRef }>('/api/me/prefs', { quiet: true })
      .then((p) => setModel(p.builderModel ?? null))
      .catch(() => setModel(null));
  }, []);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [msgs.length, busy]);

  const send = async (message: string, e?: FormEvent) => {
    e?.preventDefault();
    if (!message.trim() || busy !== null) return;
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: message.trim() }]);
    setText('');
    setBusy(Date.now());
    try {
      const r = await api<{ reply: string; graph?: CanvasGraph; fixes: string[]; ms: number }>('/api/builder', {
        body: { message: message.trim(), history, graph: props.graph },
        quiet: true,
      });
      if (r.graph) props.onApply(r.graph);
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply, fixes: r.fixes, ms: r.ms, applied: !!r.graph }]);
    } catch (err) {
      setMsgs((m) => [...m, { role: 'assistant', content: (err as Error).message, error: true }]);
    } finally {
      setBusy(null);
    }
  };

  if (model === undefined) return <p className="p-4 text-sm text-slate-400">Loading…</p>;

  if (model === null || choosing)
    return (
      <div className="space-y-3 p-4">
        <h3 className="font-semibold">Pick the Builder’s model</h3>
        <p className="text-sm text-slate-400">The Builder turns what you ask into a canvas. A 4–9B local model works; a bigger or cloud model builds better canvases.</p>
        <BuilderModelChooser
          models={props.models}
          providers={props.providers}
          value={model ?? undefined}
          onPick={async (m) => {
            await api('/api/me/prefs', { method: 'PUT', body: { builderModel: m } });
            setModel(m);
            setChoosing(false);
            toast(`The Builder now uses ${m.model}`, 'ok');
          }}
        />
        {model && (
          <button className="btn-ghost w-full" onClick={() => setChoosing(false)}>
            Cancel
          </button>
        )}
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#30363d] px-4 py-2 text-xs text-slate-400">
        <span className="truncate">
          Builder: <span className="text-slate-200">{model.model}</span>
        </span>
        <button className="ml-auto shrink-0 text-indigo-400 hover:underline" onClick={() => setChoosing(true)}>
          change
        </button>
        {msgs.length > 0 && (
          <button className="shrink-0 text-slate-500 hover:text-slate-300" onClick={() => setMsgs([])}>
            clear
          </button>
        )}
      </div>

      <div ref={list} className="flex-1 space-y-3 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-slate-300">Tell me what you need and I’ll build the canvas. I can also change the one you have.</p>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                className="block w-full rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2 text-left text-sm text-slate-300 hover:border-indigo-500"
                onClick={() => send(ex)}
                disabled={props.disabled}
              >
                {ex}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-8 rounded-2xl rounded-br-sm bg-indigo-900/70 px-3 py-2 text-sm text-indigo-50">
              {m.content}
            </div>
          ) : (
            <div
              key={i}
              className={`mr-6 space-y-1.5 rounded-2xl rounded-bl-sm border px-3 py-2 text-sm ${m.error ? 'border-red-800 bg-red-950/40 text-red-200' : 'border-[#30363d] bg-[#161b22] text-slate-200'}`}
            >
              <div>{m.content}</div>
              {m.fixes && m.fixes.length > 0 && (
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer">{m.fixes.length} thing{m.fixes.length > 1 ? 's' : ''} fixed automatically</summary>
                  <ul className="list-disc pl-4">
                    {m.fixes.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </details>
              )}
              {m.applied && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="text-emerald-400">Applied to the canvas</span>
                  {m.ms !== undefined && <span>· {(m.ms / 1000).toFixed(1)}s</span>}
                  {i === msgs.length - 1 && props.onUndo && (
                    <button className="ml-auto text-indigo-400 hover:underline" onClick={props.onUndo}>
                      Undo
                    </button>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        {busy !== null && (
          <div className="mr-6 flex items-center gap-2 rounded-2xl rounded-bl-sm border border-violet-800/60 bg-violet-950/30 px-3 py-2 text-sm text-violet-200">
            <span className="hm-core-dot" />
            Designing your canvas… {((now - busy) / 1000).toFixed(0)}s
          </div>
        )}
      </div>

      <form className="flex gap-2 border-t border-[#30363d] p-3" onSubmit={(e) => send(text, e)}>
        <input
          className="input"
          placeholder={props.disabled ? 'Exit the replay to build' : 'Describe what you need…'}
          value={text}
          disabled={props.disabled}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn shrink-0" disabled={busy !== null || !text.trim() || props.disabled}>
          Build
        </button>
      </form>
    </div>
  );
}
