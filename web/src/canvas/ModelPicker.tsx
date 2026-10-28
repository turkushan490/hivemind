import type { ModelInfo, ModelRef, ProviderInfo } from '@hivemind/shared';
import { useMemo, useState } from 'react';
import { useStored } from '../stored';

/** Searchable model list, grouped by provider, with a free-only switch. */
export function ModelPicker(props: {
  models: ModelInfo[];
  providers: ProviderInfo[];
  value?: ModelRef;
  onChange: (m: ModelRef) => void;
  /** Image blocks list only image models; every other block only text models. */
  kind?: 'image' | 'text' | 'decision';
}) {
  const [q, setQ] = useState('');
  const [freeOnly, setFreeOnly] = useStored('canvas.freeOnly', false);
  const [open, setOpen] = useState(!props.value);

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const want = props.kind ?? 'text';
    const list = props.models.filter((m) => (m.kind ?? 'text') === want).filter(
      (m) => (!freeOnly || m.free) && words.every((w) => `${m.name} ${m.model}`.toLowerCase().includes(w)),
    );
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of list) byProvider.set(m.providerId, [...(byProvider.get(m.providerId) ?? []), m]);
    return [...byProvider.entries()].map(([id, ms]) => ({ name: props.providers.find((p) => p.id === id)?.name ?? id, models: ms }));
  }, [props.models, props.providers, q, freeOnly, props.kind]);

  const current = props.value && props.models.find((m) => m.providerId === props.value!.providerId && m.model === props.value!.model);
  const providerName = props.value && (props.providers.find((p) => p.id === props.value!.providerId)?.name ?? props.value.providerId);

  return (
    <div className="space-y-2">
      <button
        className={`w-full rounded-md border px-3 py-2 text-left text-sm ${props.value ? 'border-[#30363d] bg-[#0d1117]' : 'border-red-700 bg-red-950/30'}`}
        onClick={() => setOpen((o) => !o)}
      >
        {props.value ? (
          <>
            <div className="truncate font-medium">{current?.name ?? props.value.model}</div>
            <div className="text-xs text-slate-500">
              {providerName}
              {current?.free ? ' · free' : ''}
              {!current && ' · not available right now'}
            </div>
          </>
        ) : (
          <span className="text-red-300">Pick a model</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 rounded-md border border-[#30363d] bg-[#0d1117] p-2">
          <div className="flex items-center gap-2">
            <input className="input py-1" autoFocus placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
              <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} /> free
            </label>
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {groups.length === 0 && <p className="text-xs text-slate-500">No models. Connect providers in Settings.</p>}
            {groups.map((g) => (
              <div key={g.name}>
                <div className="px-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{g.name}</div>
                {g.models.map((m) => {
                  const selected = props.value?.providerId === m.providerId && props.value.model === m.model;
                  return (
                    <button
                      key={m.model}
                      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm ${selected ? 'bg-indigo-500/20 text-indigo-100' : 'hover:bg-[#21262d]'}`}
                      onClick={() => {
                        props.onChange({ providerId: m.providerId, model: m.model });
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate" title={m.model}>
                        {m.name}
                      </span>
                      {m.free && <span className="rounded bg-emerald-900/50 px-1 text-[10px] text-emerald-300">free</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
