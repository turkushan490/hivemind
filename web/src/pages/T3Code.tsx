import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

type Role = 'fast' | 'planner' | 'coder' | 'slow' | 'check';
const ROLES: { id: Role; label: string }[] = [
  { id: 'fast', label: 'fast' },
  { id: 'planner', label: 'planner' },
  { id: 'coder', label: 'coder' },
  { id: 'slow', label: 'slow + best' },
  { id: 'check', label: 'check' },
];

interface Choice {
  name?: string;
  description?: string;
  role?: Role;
  reasoning?: boolean;
}
interface Model {
  id: string;
  name: string;
  modelName: string;
  provider: string;
  providerName: string;
  kind: 'model' | 'workflow';
  local: boolean;
  tools: boolean;
  contextLength?: number;
  sizeBytes?: number;
  description?: string;
  t3Name: string;
}
interface Folder {
  dir: string;
  mapped: boolean;
  configExists: boolean;
  inFile: string[];
  writtenAt?: string;
  tokenPresent: boolean;
  error?: string;
}
interface T3Data {
  folder: Folder;
  settings: { baseUrl: string; owner: string; models: Record<string, Choice> };
  models: Model[];
}

type Filter = 'all' | 'chosen' | 'local' | 'cloud' | 'workflows' | 'tools' | 'inT3';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'chosen', label: 'Chosen' },
  { id: 'local', label: 'Local' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'tools', label: 'Edits files' },
  { id: 'inT3', label: 'In T3 now' },
];

const gb = (b?: number) => (b ? `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB` : '');

/** Settings → T3 Code: pick the HiveMind models T3 Code offers (through OpenCode) and write them with one button. */
export function T3CodePanel({ active }: { active: boolean }) {
  const [data, setData] = useState<T3Data>();
  const [chosen, setChosen] = useState<Record<string, Choice>>({});
  const [baseUrl, setBaseUrl] = useState('');
  const [owner, setOwner] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    const d = await api<T3Data>('/api/t3');
    setData(d);
    setChosen(d.settings.models);
    setBaseUrl(d.settings.baseUrl);
    setOwner(d.settings.owner);
    setDirty(false);
  };
  useEffect(() => {
    if (active) load().catch(() => {});
  }, [active]);

  const change = (id: string, c: Choice | undefined) => {
    setChosen((prev) => {
      const next = { ...prev };
      if (c) next[id] = c;
      else delete next[id];
      return next;
    });
    setDirty(true);
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const inFile = new Set(data.folder.inFile);
    return data.models
      .filter((m) => {
        if (filter === 'chosen' && !chosen[m.id]) return false;
        if (filter === 'local' && !(m.local && m.kind === 'model')) return false;
        if (filter === 'cloud' && (m.local || m.kind !== 'model')) return false;
        if (filter === 'workflows' && m.kind !== 'workflow') return false;
        if (filter === 'tools' && !m.tools) return false;
        if (filter === 'inT3' && !inFile.has(m.id)) return false;
        if (!q) return true;
        return `${m.name} ${m.id} ${m.providerName} ${chosen[m.id]?.description ?? ''} ${m.description ?? ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => Number(!!chosen[b.id]) - Number(!!chosen[a.id]) || Number(a.kind === 'workflow') - Number(b.kind === 'workflow') || a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name));
  }, [data, query, filter, chosen]);

  const body = () => ({ baseUrl, owner, models: chosen });
  const save = async () => {
    setBusy(true);
    try {
      await api('/api/t3', { method: 'PUT', body: body() });
      await load();
      toast('Saved');
    } finally {
      setBusy(false);
    }
  };
  const update = async () => {
    setBusy(true);
    try {
      const r = await api<{ written: number; missing: string[]; tokenCreated: boolean; warnings: string[] }>('/api/t3/update', { body: body() });
      await load();
      toast(
        `${r.written} model${r.written === 1 ? '' : 's'} written to T3.${r.tokenCreated ? ' Made an API token for T3.' : ''}${r.missing.length ? ` ${r.missing.length} chosen model(s) are no longer offered.` : ''} In T3: Settings → Providers → refresh.`,
      );
      for (const w of r.warnings) toast(w);
    } finally {
      setBusy(false);
    }
  };
  const newToken = async () => {
    if (!confirm('Make a new API token for T3? The old T3 token stops working.')) return;
    const r = await api<{ warnings?: string[] }>('/api/t3/token', { body: {} });
    toast('New token written for T3');
    for (const w of r.warnings ?? []) toast(w);
    await load();
  };

  if (!data) return <div className="card max-w-3xl text-sm text-slate-400">Loading…</div>;
  const f = data.folder;
  const count = Object.keys(chosen).length;
  const inFile = new Set(f.inFile);

  return (
    <div className="max-w-4xl space-y-4">
      <div className="card space-y-3">
        <h2 className="font-semibold">T3 Code</h2>
        <p className="text-sm text-slate-400">
          Choose which HiveMind models and workflows T3 Code offers. They go through OpenCode in T3 to this HiveMind’s <code>/v1</code> API.
          <b> Update T3</b> writes only the HiveMind part of T3’s <code>opencode.json</code>, the rest of that file stays as it is.
        </p>
        {f.mapped ? (
          <p className="text-sm text-emerald-400">
            T3’s OpenCode folder is connected ({f.dir}): {f.inFile.length} HiveMind model{f.inFile.length === 1 ? '' : 's'} in T3 now
            {f.writtenAt && `, written ${new Date(f.writtenAt).toLocaleString()}`}. API token for T3: {f.tokenPresent ? 'present' : 'none yet (Update T3 makes one)'}.
          </p>
        ) : (
          <div className="rounded-md border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
            HiveMind can’t reach T3’s OpenCode folder yet. In HiveMind’s Docker template, set <b>T3 Code OpenCode folder</b> to the host folder that T3 mounts as{' '}
            <code>~/.config/opencode</code> (in the T3 container’s appdata: <code>.config/opencode</code>) and apply. Until then, use <b>Download opencode.json</b> and copy it there yourself.
          </div>
        )}
        {f.error && <p className="text-sm text-red-400">{f.error}</p>}
        <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
          <label className="space-y-1 text-xs text-slate-300">
            <span>Address T3 uses to reach HiveMind</span>
            <input className="input" value={baseUrl} onChange={(e) => (setBaseUrl(e.target.value), setDirty(true))} placeholder="http://<hivemind-host>:4820/v1" />
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            <span>File owner (uid:gid)</span>
            <input className="input" value={owner} onChange={(e) => (setOwner(e.target.value), setDirty(true))} placeholder="99:100" />
          </label>
        </div>
        <p className="text-xs text-slate-500">Use an address T3’s container can reach directly (not one behind a login page). Unraid containers like T3 run as 99:100.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" disabled={busy || !f.mapped} onClick={update} title={f.mapped ? 'Write the chosen models into T3' : 'Map the folder first'}>
            Update T3 ({count})
          </button>
          <button className="btn-ghost" disabled={busy || !dirty} onClick={save}>
            Save choices
          </button>
          <a className="btn-ghost" href="/api/t3/opencode.json">
            Download opencode.json
          </a>
          {f.mapped && (
            <button className="btn-ghost" onClick={newToken}>
              New token
            </button>
          )}
          {dirty && <span className="text-xs text-amber-300">Not written to T3 yet</span>}
        </div>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input className="input min-w-[12rem] flex-1" placeholder="Search models…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {FILTERS.map((x) => (
            <button key={x.id} className={`rounded-full px-3 py-1 text-xs ${filter === x.id ? 'bg-indigo-600 text-white' : 'bg-[#21262d] text-slate-300 hover:text-white'}`} onClick={() => setFilter(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          {rows.length} of {data.models.length} shown, {count} chosen. In T3 a model is called “name · where · role (description)”.
        </p>
        <div className="divide-y divide-[#30363d]">
          {rows.map((m) => {
            const c = chosen[m.id];
            return (
              <div key={m.id} className="space-y-2 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!c} onChange={(e) => change(m.id, e.target.checked ? {} : undefined)} />
                  <span className="font-medium">{m.kind === 'workflow' ? m.name : m.modelName}</span>
                  <span className="rounded bg-[#21262d] px-1.5 text-xs text-slate-400">{m.providerName}</span>
                  <span className={`rounded px-1.5 text-xs ${m.kind === 'workflow' ? 'bg-violet-900/50 text-violet-300' : m.local ? 'bg-emerald-900/50 text-emerald-300' : 'bg-sky-900/50 text-sky-300'}`}>
                    {m.kind === 'workflow' ? 'workflow' : m.local ? 'local' : 'cloud'}
                  </span>
                  <span className={`text-xs ${m.tools ? 'text-slate-400' : 'text-amber-400'}`}>{m.tools ? 'edits files' : 'chat only'}</span>
                  {m.sizeBytes ? <span className="text-xs text-slate-500">{gb(m.sizeBytes)}</span> : null}
                  {m.contextLength ? <span className="text-xs text-slate-500">{Math.round(m.contextLength / 1024)}k ctx</span> : null}
                  {inFile.has(m.id) && <span className="text-xs text-indigo-300">in T3</span>}
                  <code className="ml-auto truncate text-xs text-slate-500" title={m.id}>
                    {m.id}
                  </code>
                </div>
                {c && (
                  <div className="ml-6 grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
                    <input className="input py-1 text-xs" placeholder={m.kind === 'workflow' ? m.name : m.modelName} value={c.name ?? ''} onChange={(e) => change(m.id, { ...c, name: e.target.value })} title="Name in T3" />
                    <input className="input py-1 text-xs" placeholder="Short description, e.g. fast: simple code" value={c.description ?? ''} onChange={(e) => change(m.id, { ...c, description: e.target.value })} title="A few words on what it's for" />
                    <select className="input w-auto py-1 text-xs" value={c.role ?? ''} onChange={(e) => change(m.id, { ...c, role: (e.target.value || undefined) as Role | undefined })}>
                      <option value="">no role</option>
                      {ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    {m.kind === 'model' ? (
                      <label className="flex items-center gap-1 text-xs text-slate-400" title="OpenCode offers a reasoning setting for models that think">
                        <input type="checkbox" checked={c.reasoning ?? /qwen3|deepseek|gpt-oss|gemini|think|reason|glm|kimi/i.test(`${m.id}`)} onChange={(e) => change(m.id, { ...c, reasoning: e.target.checked })} />
                        thinks
                      </label>
                    ) : (
                      <span />
                    )}
                    {!dirty && <div className="text-xs text-slate-500 sm:col-span-4">In T3: {m.t3Name}</div>}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <p className="py-3 text-sm text-slate-500">Nothing matches.</p>}
        </div>
      </div>
    </div>
  );
}
