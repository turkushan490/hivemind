import type { AccessOverview, AccessProfile, ModelInfo, ProviderAccess, ProviderInfo } from '@hivemind/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

/** Same rule as the server: an exact name, or a glob where only * is special. */
const globMatch = (pattern: string, name: string) => {
  const norm = (s: string) => s.trim().replace(/\\/g, '/').replace(/:latest$/i, '').toLowerCase();
  const p = norm(pattern);
  const n = norm(name);
  if (!p.includes('*')) return p === n;
  return new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(n);
};

type List = 'all' | 'none' | string[];

/**
 * One list (models or LoRAs) of one provider: "all", "none", or names and folder globs ("dnd/*"), with search,
 * select all and a glob box. Names the provider no longer has stay in the list (shown in the glob row).
 */
function Checklist({ label, names, value, onChange, allowNone }: { label: string; names: string[]; value: List; onChange: (v: List) => void; allowNone?: boolean }) {
  const [q, setQ] = useState('');
  const [glob, setGlob] = useState('');
  const picked = Array.isArray(value) ? value : [];
  const globs = picked.filter((p) => p.includes('*') || !names.includes(p));
  const shown = names.filter((n) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 400);
  const on = (n: string) => value === 'all' || picked.some((p) => globMatch(p, n));
  const toggle = (n: string) => onChange(picked.includes(n) ? picked.filter((p) => p !== n) : [...picked, n]);
  const mode = value === 'all' ? 'all' : value === 'none' || (allowNone && picked.length === 0) ? 'none' : 'some';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="w-14 font-medium text-slate-300">{label}</span>
        {(['all', 'some', ...(allowNone ? ['none'] : [])] as const).map((m) => (
          <label key={m} className="flex items-center gap-1 text-slate-400">
            <input type="radio" checked={mode === m} onChange={() => onChange(m === 'all' ? 'all' : m === 'none' ? 'none' : [])} />
            {m === 'all' ? 'All' : m === 'none' ? 'None' : 'Chosen'}
          </label>
        ))}
        <span className="text-slate-500">
          {value === 'all' ? `all ${names.length}` : `${names.filter(on).length} of ${names.length}`}
        </span>
      </div>
      {mode === 'some' && (
        <div className="space-y-1.5 rounded-md border border-[#30363d] p-2">
          <div className="flex flex-wrap gap-1.5">
            <input className="input w-48 py-1 text-xs" placeholder={`Search ${names.length}…`} value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-ghost text-xs" onClick={() => onChange([...new Set([...picked, ...shown])])}>
              Select all{q ? ' shown' : ''}
            </button>
            <button className="btn-ghost text-xs" onClick={() => onChange(picked.filter((p) => !shown.includes(p)))}>
              Clear{q ? ' shown' : ''}
            </button>
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (glob.trim()) onChange([...new Set([...picked, glob.trim()])]);
                setGlob('');
              }}
            >
              <input className="input w-36 py-1 text-xs" placeholder="Folder glob: dnd/*" value={glob} onChange={(e) => setGlob(e.target.value)} />
              <button className="btn-ghost text-xs" disabled={!glob.trim()}>
                Add
              </button>
            </form>
          </div>
          {globs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {globs.map((g) => (
                <span key={g} className="flex items-center gap-1 rounded bg-indigo-950/60 px-1.5 py-0.5 text-xs text-indigo-200">
                  <code>{g}</code>
                  <button className="text-slate-400 hover:text-white" title="Remove" onClick={() => onChange(picked.filter((p) => p !== g))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {shown.map((n) => (
              <label key={n} className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={on(n)} disabled={!picked.includes(n) && on(n)} onChange={() => toggle(n)} />
                <span className="truncate" title={n}>
                  {n}
                </span>
              </label>
            ))}
            {names.length === 0 && <p className="text-xs text-slate-500">The provider lists nothing right now (offline?). Globs still work.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** One provider in the profile: off, or which models (and for ComfyUI which LoRAs). */
function ProviderAccessRow({ p, value, onChange }: { p: ProviderInfo; value: ProviderAccess | undefined; onChange: (v: ProviderAccess | undefined) => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [loras, setLoras] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || models) return;
    api<ModelInfo[]>(`/api/providers/${p.id}/models`, { quiet: true })
      .then((m) => setModels(m.map((x) => x.model)))
      .catch(() => setModels([]));
    if (p.kind === 'comfyui') api<string[]>(`/api/providers/${p.id}/loras`, { quiet: true }).then(setLoras).catch(() => {});
  }, [open]);
  const summary = !value ? 'not allowed' : `${value.models === 'all' ? 'all models' : `${value.models.length} model entries`}${p.kind === 'comfyui' ? ` · ${value.loras === 'all' ? 'all LoRAs' : Array.isArray(value.loras) && value.loras.length ? `${value.loras.length} LoRA entries` : 'no LoRAs'}` : ''}`;
  return (
    <div className="border-t border-[#30363d] pt-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? { models: 'all', loras: 'none' } : undefined)} />
        <span className="font-medium">{p.name}</span>
        <span className="text-xs text-slate-500">
          {p.kind}
          {p.local ? ' · local' : ''}
          {!p.shared ? ' · own' : ''}
        </span>
        <span className="text-xs text-slate-400">{summary}</span>
        {value && (
          <button className="btn-ghost ml-auto text-xs" onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Choose…'}
          </button>
        )}
      </div>
      {value && open && (
        <div className="mt-2 space-y-2 pl-6">
          <Checklist label="Models" names={models ?? []} value={value.models} onChange={(m) => onChange({ ...value, models: m === 'none' ? [] : m })} />
          {p.kind === 'comfyui' && <Checklist label="LoRAs" names={loras} value={value.loras ?? 'none'} allowNone onChange={(l) => onChange({ ...value, loras: Array.isArray(l) && !l.length ? 'none' : l })} />}
        </div>
      )}
    </div>
  );
}

function ProfileEditor({ profile, providers, isDefault, onSaved, onDeleted }: { profile: AccessProfile; providers: ProviderInfo[]; isDefault: boolean; onSaved: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(profile.name);
  const [map, setMap] = useState(profile.providers);
  useEffect(() => {
    setName(profile.name);
    setMap(profile.providers);
  }, [profile]);
  if (profile.builtin)
    return (
      <div className="card space-y-2">
        <h3 className="font-semibold">{profile.name}</h3>
        <p className="text-sm text-slate-400">Built in: every provider, model and LoRA. Admins always have it. It can't be changed or deleted.</p>
      </div>
    );
  const changed = name !== profile.name || JSON.stringify(map) !== JSON.stringify(profile.providers);
  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-56 py-1 font-semibold" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn ml-auto"
          disabled={!changed || !name.trim()}
          onClick={async () => {
            await api(`/api/access/profiles/${profile.id}`, { method: 'PUT', body: { name, providers: map } });
            toast(`Saved ${name}`, 'ok');
            onSaved();
          }}
        >
          Save
        </button>
        <button
          className="btn-ghost text-red-400"
          disabled={isDefault}
          title={isDefault ? 'New users get this profile: pick another one for them first' : undefined}
          onClick={async () => {
            if (!confirm(`Delete ${profile.name}? Its users get the "New users get" profile; its tokens go back to what their user has.`)) return;
            await api(`/api/access/profiles/${profile.id}`, { method: 'DELETE' });
            onDeleted();
          }}
        >
          Delete
        </button>
      </div>
      <p className="text-xs text-slate-500">A provider that isn't ticked can't be used at all. Providers a user added with their own key are always theirs.</p>
      {providers.map((p) => (
        <ProviderAccessRow
          key={p.id}
          p={p}
          value={map[p.id]}
          onChange={(v) => {
            const next = { ...map };
            if (v) next[p.id] = v;
            else delete next[p.id];
            setMap(next);
          }}
        />
      ))}
    </div>
  );
}

/** Settings → Access (admins): who may use which providers, models and LoRAs. */
export function Access({ active }: { active: boolean }) {
  const [data, setData] = useState<AccessOverview | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [sel, setSel] = useState<string>('basic');
  const [newName, setNewName] = useState('');
  const load = () => api<AccessOverview>('/api/access', { quiet: true }).then(setData).catch((err) => toast(`Could not load access: ${(err as Error).message}`));
  useEffect(() => {
    if (!active) return;
    load();
    api<ProviderInfo[]>('/api/providers', { quiet: true }).then(setProviders).catch(() => {});
  }, [active]);
  const profile = useMemo(() => data?.profiles.find((p) => p.id === sel) ?? data?.profiles[0], [data, sel]);
  if (!data) return null;
  const names = Object.fromEntries(data.profiles.map((p) => [p.id, p.name]));
  const settings = async (body: { newUsers?: string; keepComfyCopy?: boolean }) => {
    await api('/api/access/settings', { method: 'PUT', body });
    load();
  };
  const options = (extra?: string) => (
    <>
      {extra && <option value="">{extra}</option>}
      {data.profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </>
  );
  return (
    <div className="max-w-3xl space-y-4">
      <div className="card space-y-3">
        <h2 className="font-semibold">Access</h2>
        <p className="text-sm text-slate-400">
          Which AI providers, models and LoRAs each user and each API token may use and see. The server checks it on every list and every run, also on shared
          workflows. An API token with a profile of its own gets only what both the token and its user allow.
        </p>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          New users get
          <select className="input w-auto py-1" value={data.newUsers} onChange={(e) => settings({ newUsers: e.target.value })}>
            {options()}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={data.keepComfyCopy} onChange={(e) => settings({ keepComfyCopy: e.target.checked })} />
          <span>
            Keep a copy in ComfyUI's output folder
            <span className="block text-xs text-slate-500">
              Off: Image blocks use ComfyUI's temp folder (PreviewImage) and HiveMind keeps the picture in the owner's Files. Anyone who can reach ComfyUI's own port can
              list and download what is in its output folder, so keep that port inside your network.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-3 md:flex-row">
        <div className="card shrink-0 space-y-1 md:w-52">
          <h3 className="text-sm font-semibold">Profiles</h3>
          {data.profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setSel(p.id)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${profile?.id === p.id ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {p.name}
              {p.builtin && <span className="text-xs text-slate-500"> · built in</span>}
              {p.id === data.newUsers && <span className="text-xs text-slate-500"> · new users</span>}
            </button>
          ))}
          <form
            className="flex gap-1 pt-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const p = await api<AccessProfile>('/api/access/profiles', { body: { name: newName.trim(), providers: {} } });
              setNewName('');
              setSel(p.id);
              load();
            }}
          >
            <input className="input py-1 text-xs" placeholder="New profile" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn-ghost text-xs" disabled={!newName.trim()}>
              Add
            </button>
          </form>
        </div>
        <div className="min-w-0 flex-1">{profile && <ProfileEditor profile={profile} providers={providers} isDefault={profile.id === data.newUsers} onSaved={load} onDeleted={() => (setSel('basic'), load())} />}</div>
      </div>

      <div className="card space-y-2">
        <h3 className="font-semibold">Users</h3>
        {data.users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
            <span className="font-medium">{u.username}</span>
            <span className="text-xs text-slate-500">{u.role}</span>
            <select
              className="input ml-auto w-auto py-1 text-xs"
              value={u.profileId}
              disabled={u.role === 'admin'}
              title={u.role === 'admin' ? 'Admins always have Everything' : 'Access profile'}
              onChange={async (e) => {
                await api(`/api/access/users/${u.id}`, { method: 'PUT', body: { profileId: e.target.value } });
                toast(`${u.username} now has ${names[e.target.value]}`, 'ok');
                load();
              }}
            >
              {options()}
            </select>
          </div>
        ))}
      </div>

      <div className="card space-y-2">
        <h3 className="font-semibold">API tokens</h3>
        {data.tokens.length === 0 && <p className="text-sm text-slate-500">No API tokens yet.</p>}
        {data.tokens.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
            <span className="font-medium">{t.name}</span>
            <code className="text-xs text-slate-500">{t.prefix}…</code>
            <span className="text-xs text-slate-500">of {t.username}</span>
            <select
              className="input ml-auto w-auto py-1 text-xs"
              value={t.profileId ?? ''}
              onChange={async (e) => {
                await api(`/api/access/tokens/${t.id}`, { method: 'PUT', body: { profileId: e.target.value || null } });
                load();
              }}
            >
              {options('Same as its user')}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
