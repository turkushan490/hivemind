import { seesPictures, type ModelInfo, type ModelRef } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

type Choice = 'auto' | 'off' | ModelRef;

/**
 * Settings → Pictures: the picture reader. A picture in a question goes straight to models that can see; for a model
 * that can't (a coder, most colibri models), the reader looks first and writes what is in it, text included.
 */
export function PictureReaderPanel({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
  const [state, setState] = useState<{ choice: Choice; using: ModelRef | null } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    if (!active) return;
    api<{ choice: Choice; using: ModelRef | null }>('/api/settings/picture-reader', { quiet: true }).then(setState, () => {});
    api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).then((r) => setModels(r.models.filter((m) => m.kind === undefined && seesPictures(m.model, m))), () => {});
  }, [active]);

  if (!state) return null;
  const key = (c: Choice) => (typeof c === 'string' ? c : `${c.providerId}|${c.model}`);
  const save = async (value: string) => {
    const choice: Choice = value === 'auto' || value === 'off' ? value : { providerId: value.split('|')[0], model: value.slice(value.indexOf('|') + 1) };
    try {
      setState(await api('/api/settings/picture-reader', { method: 'PUT', body: { choice } }));
      toast('Picture reader saved', 'ok');
    } catch {}
  };

  return (
    <div className="card max-w-3xl space-y-3">
      <h2 className="font-semibold">Pictures</h2>
      <p className="text-sm text-slate-400">
        A picture in a question (📎 in the question box) goes straight to models that can see. A model that can&apos;t (a coder, a colibri model, gpt-oss) gets a
        description instead: the <b>picture reader</b> looks at the picture first and writes down what is in it, every bit of text included, so that model can
        still answer about it. A block can also send the picture straight to its own model (block settings → “Send pictures straight to this model”).
      </p>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Picture reader</span>
        <select className="input" disabled={!isAdmin} value={key(state.choice)} onChange={(e) => void save(e.target.value)}>
          <option value="auto">Automatic: the fastest local model that sees</option>
          <option value="off">Off: models that can&apos;t see get the text only</option>
          {models.map((m) => (
            <option key={`${m.providerId}|${m.model}`} value={`${m.providerId}|${m.model}`}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-slate-500">
        {state.using ? (
          <>
            Reading pictures now: <b className="text-slate-300">{state.using.model}</b>
          </>
        ) : state.choice === 'off' ? (
          'No picture reader.'
        ) : (
          'No local model that sees was found: pull one in Settings → Download models (gemma4:e2b is small and fast).'
        )}
      </p>
    </div>
  );
}
