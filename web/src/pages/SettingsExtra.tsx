import { SEARCH_SOURCES, type ModelInfo, type ModelRef, type ProviderInfo, type SearchSettings, type SearchSource } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { BuilderModelChooser } from '../canvas/BuilderModelChooser';
import { toast } from '../notify';

/** Settings → Builder AI: the model that turns requests into canvases, and the setup wizard. */
export function BuilderSettings({ active, onWizard }: { active: boolean; onWizard: () => void }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [model, setModel] = useState<ModelRef | undefined>();
  useEffect(() => {
    if (!active) return;
    api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).then((r) => setModels(r.models)).catch(() => {});
    api<ProviderInfo[]>('/api/providers', { quiet: true }).then(setProviders).catch(() => {});
    api<{ builderModel?: ModelRef }>('/api/me/prefs', { quiet: true }).then((p) => setModel(p.builderModel)).catch(() => {});
  }, [active]);
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Builder AI</h2>
      <p className="text-sm text-slate-400">
        The Builder (✨ on the Canvas) turns what you ask into a canvas. It writes a small plan, so mid-size models (4–9B local, or a cloud model)
        work best. Now: <span className="text-slate-200">{model?.model ?? 'not chosen'}</span>
      </p>
      <BuilderModelChooser
        models={models}
        providers={providers}
        value={model}
        onPick={async (m) => {
          await api('/api/me/prefs', { method: 'PUT', body: { builderModel: m } });
          setModel(m);
          toast(`The Builder now uses ${m.model}`, 'ok');
        }}
      />
      <button className="btn-ghost" onClick={onWizard}>
        Show the setup wizard again
      </button>
    </div>
  );
}

const SOURCE_INFO: Record<SearchSource, string> = {
  wikipedia: 'Free, no key. Great for facts; not for news or shopping.',
  brave: 'Real web search. Free plan with a key from brave.com/search/api.',
  tavily: 'Search made for AI. Free monthly credits with a key from tavily.com.',
  searxng: 'Your own self-hosted meta search (e.g. a SearXNG container on Unraid). JSON output must be enabled.',
};

/** Settings → Web search: the default source for Web search blocks, keys, and a test. */
export function SearchSettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [s, setS] = useState<SearchSettings | null>(null);
  const [brave, setBrave] = useState('');
  const [tavily, setTavily] = useState('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<{ title: string; url: string }[] | null>(null);

  useEffect(() => {
    api<SearchSettings>('/api/settings/search', { quiet: true }).then(setS).catch(() => {});
  }, []);
  if (!s) return null;

  const save = async (patch: Partial<SearchSettings> & { braveKey?: string; tavilyKey?: string }) => {
    setS(await api<SearchSettings>('/api/settings/search', { method: 'PUT', body: patch }));
    toast('Web search settings saved', 'ok');
  };

  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Web search</h2>
      <p className="text-sm text-slate-400">Used by Web search blocks that don’t pick their own source.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {SEARCH_SOURCES.map((src) => (
          <button
            key={src}
            disabled={!isAdmin}
            className={`rounded-lg border px-3 py-2 text-left ${s.source === src ? 'border-blue-500 bg-blue-500/10' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
            onClick={() => save({ source: src })}
          >
            <div className="text-sm font-medium capitalize">{src === 'searxng' ? 'SearXNG' : src}</div>
            <div className="text-xs text-slate-400">{SOURCE_INFO[src]}</div>
          </button>
        ))}
      </div>
      {isAdmin && (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Wikipedia language</span>
            <input className="input w-24 py-1" defaultValue={s.wikiLang} onBlur={(e) => e.target.value !== s.wikiLang && save({ wikiLang: e.target.value })} />
            <span className="text-xs text-slate-500">en, nl, de, …</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Brave key</span>
            <input className="input py-1" type="password" placeholder={s.hasBraveKey ? 'saved — type to replace' : 'API key'} value={brave} onChange={(e) => setBrave(e.target.value)} />
            <button className="btn-ghost" disabled={!brave} onClick={() => save({ braveKey: brave }).then(() => setBrave(''))}>
              Save
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Tavily key</span>
            <input className="input py-1" type="password" placeholder={s.hasTavilyKey ? 'saved — type to replace' : 'API key'} value={tavily} onChange={(e) => setTavily(e.target.value)} />
            <button className="btn-ghost" disabled={!tavily} onClick={() => save({ tavilyKey: tavily }).then(() => setTavily(''))}>
              Save
            </button>
          </div>
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">SearXNG address</span>
            <input
              className="input py-1"
              placeholder="http://192.168.1.10:8888"
              defaultValue={s.searxngUrl ?? ''}
              onBlur={(e) => e.target.value !== (s.searxngUrl ?? '') && save({ searxngUrl: e.target.value })}
            />
          </label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          className="btn-ghost"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setResults(null);
            try {
              setResults(await api<{ title: string; url: string }[]>('/api/settings/search/test', { body: { q: 'Eiffel Tower' } }));
            } catch {
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? 'Searching…' : 'Test search'}
        </button>
        {results && <span className="text-xs text-emerald-400">{results.length} results</span>}
      </div>
      {results?.map((r) => (
        <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-indigo-400 hover:underline">
          {r.title}
        </a>
      ))}
    </div>
  );
}

/** Settings → Memory: what Memory blocks have saved, per name. */
export function MemorySettings({ active }: { active: boolean }) {
  const [keys, setKeys] = useState<{ key: string; count: number; last: string }[]>([]);
  const load = () => api<typeof keys>('/api/memory/keys', { quiet: true }).then(setKeys).catch(() => {});
  useEffect(() => {
    if (active) load();
  }, [active]);
  return (
    <div className="card max-w-2xl space-y-2">
      <h2 className="font-semibold">Memory</h2>
      <p className="text-sm text-slate-400">What your Memory blocks remembered. Clearing a name makes those blocks start fresh.</p>
      {keys.length === 0 && <p className="text-sm text-slate-500">Nothing remembered yet.</p>}
      {keys.map((k) => (
        <div key={k.key} className="flex items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
          <span className="font-medium">{k.key}</span>
          <span className="text-xs text-slate-500">
            {k.count} saved · last {new Date(k.last.replace(' ', 'T') + 'Z').toLocaleString()}
          </span>
          <button
            className="btn-ghost ml-auto text-red-400"
            onClick={async () => {
              if (!confirm(`Forget everything saved under "${k.key}"?`)) return;
              await api(`/api/memory/keys/${encodeURIComponent(k.key)}`, { method: 'DELETE' });
              load();
            }}
          >
            Clear
          </button>
        </div>
      ))}
    </div>
  );
}
