import type { ProviderInfo, ProviderPreset } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';

export function Providers({ isAdmin }: { isAdmin: boolean }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [preset, setPreset] = useState('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [shared, setShared] = useState(true);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = async () => {
    setProviders(await api('/api/providers'));
    setPresets(await api('/api/providers/presets'));
  };
  useEffect(() => {
    load();
  }, []);

  const chosen = presets.find((p) => p.id === preset);

  const add = async () => {
    setError('');
    try {
      await api('/api/providers', { body: { preset, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined, shared } });
      setApiKey('');
      setBaseUrl('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const test = async (p: ProviderInfo) => {
    setStatus((s) => ({ ...s, [p.id]: 'testing…' }));
    try {
      const models = await api<{ free: boolean }[]>(`/api/providers/${p.id}/models?fresh=1`);
      setStatus((s) => ({ ...s, [p.id]: `OK, ${models.length} models (${models.filter((m) => m.free).length} free)` }));
    } catch (err) {
      setStatus((s) => ({ ...s, [p.id]: (err as Error).message }));
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="card space-y-2">
        <h2 className="font-semibold">Connected providers</h2>
        {providers.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
            <span className="font-medium">{p.name}</span>
            <span className="text-slate-500">{p.baseUrl}</span>
            {p.local && <span className="rounded bg-emerald-900/50 px-1.5 text-xs text-emerald-300">local</span>}
            {!p.shared && <span className="rounded bg-slate-700 px-1.5 text-xs">only you</span>}
            <span className="ml-auto flex gap-1">
              <button className="btn-ghost" onClick={() => test(p)}>
                Test
              </button>
              <button
                className="btn-ghost"
                onClick={async () => {
                  await api(`/api/providers/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
                  load();
                }}
              >
                {p.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                className="btn-ghost text-red-400"
                onClick={async () => {
                  if (!confirm(`Remove ${p.name}?`)) return;
                  await api(`/api/providers/${p.id}`, { method: 'DELETE' });
                  load();
                }}
              >
                Remove
              </button>
            </span>
            {status[p.id] && <p className="w-full text-xs text-slate-400">{status[p.id]}</p>}
          </div>
        ))}
      </div>

      <div className="card space-y-2">
        <h2 className="font-semibold">Add a provider</h2>
        <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.free ? ' — free' : ''}
            </option>
          ))}
        </select>
        {chosen?.note && <p className="text-xs text-slate-400">{chosen.note}</p>}
        {chosen?.keyUrl && (
          <a className="text-xs text-indigo-400 hover:underline" href={chosen.keyUrl} target="_blank" rel="noreferrer">
            Get a key →
          </a>
        )}
        <input className="input" placeholder={chosen?.baseUrl || 'Base URL'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <input className="input" type="password" placeholder={chosen?.needsKey ? 'API key' : 'API key (optional)'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        {isAdmin && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with all users
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
