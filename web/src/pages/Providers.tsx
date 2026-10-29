import type { ModelInfo, ProviderInfo, ProviderPreset } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { DecisionBars } from '../canvas/DecisionBars';
import type { DecisionEvent } from '@hivemind/shared';

type Status = { state: 'checking' } | { state: 'ok'; total: number; free: number } | { state: 'error'; error: string };

const GROUPS: { title: string; hint: string; ids: string[] }[] = [
  { title: 'Free', hint: 'Local models and cloud providers with a free key — no credit card.', ids: ['ollama', 'openrouter', 'groq', 'gemini'] },
  { title: 'Paid', hint: 'Pay per use with your own key.', ids: ['anthropic', 'openai', 'opencode-zen'] },
  { title: 'Other', hint: 'Any OpenAI-compatible server (LM Studio, vLLM, LiteLLM, Azure, ...).', ids: ['custom'] },
  {
    title: 'Decisions',
    hint: 'Decision models answer yes/no, choice and score questions with probabilities in ~0.1 s — for Decide blocks, the Auto model and the Jev router.',
    ids: ['typesafe', 'ollama-decisions', 'openai-decisions', 'clef-cloud'],
  },
];

export function Providers({ isAdmin }: { isAdmin: boolean }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});

  const check = async (p: ProviderInfo, fresh = false) => {
    setStatus((s) => ({ ...s, [p.id]: { state: 'checking' } }));
    try {
      const models = await api<ModelInfo[]>(`/api/providers/${p.id}/models${fresh ? '?fresh=1' : ''}`, { quiet: true });
      setStatus((s) => ({ ...s, [p.id]: { state: 'ok', total: models.length, free: models.filter((m) => m.free).length } }));
      return true;
    } catch (err) {
      setStatus((s) => ({ ...s, [p.id]: { state: 'error', error: (err as Error).message } }));
      return false;
    }
  };

  const load = async () => {
    const [list, pre] = await Promise.all([api<ProviderInfo[]>('/api/providers'), api<ProviderPreset[]>('/api/providers/presets')]);
    setProviders(list);
    setPresets(pre);
    list.filter((p) => p.enabled).forEach((p) => check(p));
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      {GROUPS.map((g) => (
        <section key={g.title} className="space-y-2">
          <div className="flex items-baseline gap-3">
            <h2 className="text-lg font-semibold">{g.title}</h2>
            <span className="text-sm text-slate-400">{g.hint}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {g.ids
              .map((id) => presets.find((p) => p.id === id))
              .filter((p): p is ProviderPreset => !!p)
              // Local and custom AI servers are added by an admin (the server calls their address); users still see the ones that exist.
              .filter((p) => isAdmin || (!p.local && !!p.baseUrl) || providers.some((x) => x.preset === p.id))
              .map((preset) => (
                <ProviderCard
                  key={preset.id}
                  preset={preset}
                  rows={providers.filter((p) => p.preset === preset.id)}
                  status={status}
                  isAdmin={isAdmin}
                  onCheck={check}
                  onChanged={load}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProviderCard(props: {
  preset: ProviderPreset;
  rows: ProviderInfo[];
  status: Record<string, Status>;
  isAdmin: boolean;
  onCheck: (p: ProviderInfo, fresh?: boolean) => Promise<boolean>;
  onChanged: () => void;
}) {
  const { preset, rows, status, isAdmin } = props;
  const [adding, setAdding] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editKey, setEditKey] = useState<Record<string, string>>({});
  const showForm = adding || rows.length === 0;
  const askUrl = preset.id === 'ollama' || preset.id === 'custom' || preset.id === 'ollama-decisions';
  const [tested, setTested] = useState<Record<string, DecisionEvent>>({});

  const connect = async () => {
    setBusy(true);
    try {
      const p = await api<ProviderInfo>('/api/providers', { body: { preset: preset.id, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined, shared } });
      setApiKey('');
      setBaseUrl('');
      setAdding(false);
      props.onChanged();
      if (await props.onCheck(p, true)) toast(`${preset.name} connected`, 'ok');
      else toast(`${preset.name} was saved, but the test failed — check the key or URL`);
    } catch {
      // api() already showed the reason
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{preset.name}</h3>
        {preset.local && <span className="rounded bg-emerald-900/50 px-1.5 text-xs text-emerald-300">local</span>}
        {preset.free && !preset.local && <span className="rounded bg-emerald-900/50 px-1.5 text-xs text-emerald-300">free key</span>}
        {!preset.free && preset.id !== 'custom' && <span className="rounded bg-slate-700 px-1.5 text-xs">paid</span>}
        {rows.length > 0 && !adding && (
          <button className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => setAdding(true)}>
            + Add another
          </button>
        )}
      </div>
      {preset.note && <p className="text-sm text-slate-400">{preset.note}</p>}

      {rows.map((p) => {
        const st = status[p.id];
        return (
          <div key={p.id} className="space-y-2 rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${!p.enabled ? 'bg-slate-600' : st?.state === 'ok' ? 'bg-emerald-400' : st?.state === 'error' ? 'bg-red-500' : 'bg-amber-400'}`} />
              <span className="font-medium">{p.name}</span>
              {!p.shared && <span className="rounded bg-slate-700 px-1.5 text-xs">only you</span>}
              <span className="truncate text-xs text-slate-500">{p.baseUrl}</span>
            </div>
            <p className={`text-xs ${st?.state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>
              {!p.enabled
                ? 'Disabled'
                : st?.state === 'ok'
                  ? `Connected · ${st.total} models${st.free && st.free !== st.total ? ` · ${st.free} free` : ''}`
                  : st?.state === 'error'
                    ? st.error
                    : 'Checking…'}
            </p>
            {preset.needsKey && (
              <div className="flex gap-2">
                <input
                  className="input py-1"
                  type="password"
                  placeholder={p.hasKey ? 'Key saved — type a new one to replace it' : 'API key'}
                  value={editKey[p.id] ?? ''}
                  onChange={(e) => setEditKey((k) => ({ ...k, [p.id]: e.target.value }))}
                />
                <button
                  className="btn-ghost"
                  disabled={!editKey[p.id]}
                  onClick={async () => {
                    await api(`/api/providers/${p.id}`, { method: 'PATCH', body: { apiKey: editKey[p.id] } });
                    setEditKey((k) => ({ ...k, [p.id]: '' }));
                    if (await props.onCheck(p, true)) toast('Key updated and working', 'ok');
                  }}
                >
                  Save key
                </button>
              </div>
            )}
            {p.local && (
              <label className="flex items-start gap-2 rounded-md border border-[#30363d] px-2 py-1.5 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={p.parallel}
                  onChange={async (e) => {
                    await api(`/api/providers/${p.id}`, { method: 'PATCH', body: { parallel: e.target.checked } });
                    toast(e.target.checked ? 'Local models now run at the same time' : 'Local models now run one at a time', 'ok');
                    props.onChanged();
                  }}
                />
                <span>
                  <span className="font-medium text-slate-200">Run models at the same time</span>
                  <span className="block text-slate-500">
                    Off: one model at a time, safest for the GPU. On: blocks on this server run together — only when the models fit in GPU memory
                    together, otherwise Ollama swaps them and it gets slower. Cloud AIs always run at the same time.
                  </span>
                </span>
              </label>
            )}
            {tested[p.id] && (
              <div className="hm-pop space-y-1 rounded-md border border-indigo-900/60 bg-indigo-950/20 p-2">
                <p className="text-[11px] text-slate-400">Spam example from the Jev guide (a scam comment):</p>
                <DecisionBars d={tested[p.id]} />
              </div>
            )}
            <div className="flex gap-1">
              <button
                className="btn-ghost"
                onClick={async () => {
                  if (!(await props.onCheck(p, true)) || preset.kind !== 'decision') return;
                  // Decision providers also answer the spam example, so the key and model are proven to work.
                  try {
                    const r = await api<{ model: string; ms: number; answers: Record<string, any> }>(`/api/providers/${p.id}/test-decision`, { method: 'POST', quiet: true });
                    setTested((t) => ({ ...t, [p.id]: toDecisionEvent(r) }));
                    toast(`${p.name} decided in ${r.ms} ms`, 'ok');
                  } catch (err) {
                    toast((err as Error).message);
                  }
                }}
              >
                Test
              </button>
              <button
                className="btn-ghost"
                onClick={async () => {
                  await api(`/api/providers/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
                  props.onChanged();
                }}
              >
                {p.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                className="btn-ghost ml-auto text-red-400"
                onClick={async () => {
                  if (!confirm(`Remove ${p.name}? Workflows using it will stop working.`)) return;
                  await api(`/api/providers/${p.id}`, { method: 'DELETE' });
                  props.onChanged();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}

      {showForm && (
        <div className="space-y-2">
          {askUrl && <input className="input" placeholder={preset.baseUrl || 'http://server:port/v1'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
          {(preset.needsKey || preset.id === 'custom') && (
            <input className="input" type="password" placeholder={preset.needsKey ? 'API key' : 'API key (optional)'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn" disabled={busy || (preset.needsKey && !apiKey) || (preset.id === 'custom' && !baseUrl)} onClick={connect}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            {adding && rows.length > 0 && (
              <button className="btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
            )}
            {preset.keyUrl && (
              <a className="text-sm text-indigo-400 hover:underline" href={preset.keyUrl} target="_blank" rel="noreferrer">
                {preset.free ? 'Get a free key →' : 'Get a key →'}
              </a>
            )}
            {isAdmin && (
              <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
                <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with all users
              </label>
            )}
          </div>
        </div>
      )}

      {preset.id === 'openrouter' && <OpenRouterFree />}
    </div>
  );
}

const SPAM_LEVELS = ['Negative', 'Neutral', 'Positive'];

/** The test answer as the canvas shows decisions. */
function toDecisionEvent(r: { model: string; ms: number; answers: Record<string, any> }): DecisionEvent {
  return {
    model: r.model,
    ms: r.ms,
    answers: Object.entries(r.answers).map(([name, a]) =>
      a.type === 'noul'
        ? { name, type: 'noul', p: a.p }
        : a.type === 'choice'
          ? { name, type: 'choice', pick: a.choice, probabilities: a.probabilities }
          : a.type === 'score'
            ? { name, type: 'score', score: a.score, levels: SPAM_LEVELS, probabilities: a.probabilities }
            : { name, type: a.type },
    ),
  };
}

/** OpenRouter's free models, shown before a key exists so you know what you get. */
function OpenRouterFree() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  useEffect(() => {
    api<ModelInfo[]>('/api/catalog/openrouter-free', { quiet: true })
      .then(setModels)
      .catch(() => setModels([]));
  }, []);
  if (!models?.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-slate-400">{models.length} free models on OpenRouter right now</summary>
      <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto text-xs text-slate-300">
        {models.map((m) => (
          <li key={m.model} className="flex gap-2">
            <span className="truncate">{m.name}</span>
            {m.contextLength && <span className="ml-auto text-slate-500">{Math.round(m.contextLength / 1000)}k ctx</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
