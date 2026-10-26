import type { ModelInfo, ModelRef, ProviderInfo } from '@hivemind/shared';
import { useMemo, useState } from 'react';
import { ModelPicker } from './ModelPicker';

/**
 * Recommended models for the Builder: it has to write a small JSON plan, so mid-size models work best.
 * Local models of about 3–10 GB first (no cost, private), then free cloud models, then the rest.
 */
export function recommendBuilderModels(all: ModelInfo[]): { model: ModelInfo; why: string }[] {
  const models = all.filter((m) => m.kind !== 'image');
  // The same weights can be installed under two names (e.g. "x" and "ollama.com/x"): count them once.
  const seen = new Set<string>();
  const local = models
    .filter((m) => (m.sizeBytes ?? 0) > 2.5e9 && (m.sizeBytes ?? 0) < 10e9)
    .sort((a, b) => b.sizeBytes! - a.sizeBytes!)
    .filter((m) => {
      const base = m.model.split('/').pop()!;
      return !seen.has(base) && seen.add(base);
    });
  const cloudFree = models.filter((m) => m.sizeBytes === undefined && m.free);
  const out: { model: ModelInfo; why: string }[] = [];
  if (local[0]) out.push({ model: local[0], why: 'Local, strongest that fits — private and free' });
  if (local[1]) out.push({ model: local[1], why: local[1].sizeBytes! < local[0].sizeBytes! - 0.5e9 ? 'Local, smaller and faster' : 'Local alternative' });
  for (const m of cloudFree.slice(0, 2)) out.push({ model: m, why: 'Free cloud model — no GPU needed' });
  if (!out.length) {
    const any = models.filter((m) => (m.sizeBytes ?? 1e9) > 50e6).sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    if (any[0]) out.push({ model: any[0], why: 'Best of what you have' });
  }
  return out;
}

export function BuilderModelChooser(props: { models: ModelInfo[]; providers: ProviderInfo[]; value?: ModelRef; onPick: (m: ModelRef) => void }) {
  const recs = useMemo(() => recommendBuilderModels(props.models), [props.models]);
  const [other, setOther] = useState(false);
  const gb = (b?: number) => (b ? `${(b / 1e9).toFixed(1)} GB` : 'cloud');
  return (
    <div className="space-y-2">
      {recs.map(({ model: m, why }, i) => (
        <button
          key={`${m.providerId}|${m.model}`}
          className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left hover:border-indigo-500 ${
            props.value?.model === m.model ? 'border-indigo-500 bg-indigo-500/10' : 'border-[#30363d] bg-[#161b22]'
          }`}
          onClick={() => props.onPick({ providerId: m.providerId, model: m.model })}
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{m.name}</div>
            <div className="text-xs text-slate-400">{why}</div>
          </div>
          <div className="shrink-0 text-right text-xs text-slate-500">
            {i === 0 && <div className="mb-0.5 rounded bg-indigo-600 px-1.5 text-[10px] font-semibold text-white">Recommended</div>}
            {gb(m.sizeBytes)}
          </div>
        </button>
      ))}
      {recs.length === 0 && <p className="text-sm text-amber-300">No models yet. Download one in Settings → Download models, or connect a free provider.</p>}
      {other ? (
        <ModelPicker models={props.models} providers={props.providers} value={props.value} onChange={props.onPick} />
      ) : (
        <button className="text-sm text-indigo-400 hover:underline" onClick={() => setOther(true)}>
          Choose another model…
        </button>
      )}
    </div>
  );
}
