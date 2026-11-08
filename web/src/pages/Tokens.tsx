import type { AccessOverview } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  scope?: { canvases: string[]; memory: string[]; training?: boolean; datasets?: string[]; skills?: boolean };
  /** Settings → Access: a profile of its own (it gets only what both it and its user allow). */
  profileId?: string;
}

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function Tokens({ isAdmin = false }: { isAdmin?: boolean }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [profiles, setProfiles] = useState<AccessOverview['profiles']>([]);
  const [profileId, setProfileId] = useState('');
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState('');
  const [limit, setLimit] = useState(false);
  const [canvases, setCanvases] = useState('');
  const [memory, setMemory] = useState('');
  const [training, setTraining] = useState(false);
  const [datasets, setDatasets] = useState('');
  const [skills, setSkills] = useState(false);

  const load = async () => setTokens(await api('/api/tokens'));
  useEffect(() => {
    load();
    if (isAdmin) api<AccessOverview>('/api/access', { quiet: true }).then((a) => setProfiles(a.profiles)).catch(() => {});
  }, [isAdmin]);
  const profileSelect = (value: string, onChange: (v: string) => void, cls = '') =>
    profiles.length > 0 && (
      <select className={`input w-auto py-1 text-xs ${cls}`} value={value} title="Access profile: which models and LoRAs this token may use" onChange={(e) => onChange(e.target.value)}>
        <option value="">Access: same as its user</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            Access: {p.name}
          </option>
        ))}
      </select>
    );

  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">API tokens</h2>
      <p className="text-sm text-slate-400">
        For the phone app, Home Assistant or scripts. Send as <code>Authorization: Bearer hm_…</code>.
      </p>
      <div className="flex gap-2">
        <input className="input" placeholder="Name, e.g. Home Assistant" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn"
          onClick={async () => {
            const t = await api<{ token: string }>('/api/tokens', {
              body: {
                name,
                ...(profileId && { profileId }),
                ...(limit && { canvases: list(canvases), memory: list(memory), training, skills, ...(list(datasets).length && { datasets: list(datasets) }) }),
              },
            });
            setFresh(t.token);
            setName('');
            setProfileId('');
            setLimit(false);
            load();
          }}
        >
          Create
        </button>
        {profileSelect(profileId, setProfileId)}
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={limit} onChange={(e) => setLimit(e.target.checked)} />
        Limit to some workflows and memory (e.g. for DungeonMind)
      </label>
      {limit && (
        <div className="hm-pop grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Workflow ids</span>
            <input className="input text-xs" placeholder="dnd-*" value={canvases} onChange={(e) => setCanvases(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Memory keys</span>
            <input className="input text-xs" placeholder="dnd:* rules:*" value={memory} onChange={(e) => setMemory(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Datasets (by name)</span>
            <input className="input text-xs" placeholder="DungeonMind*" value={datasets} onChange={(e) => setDatasets(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 self-end pb-1.5 text-xs text-slate-300">
            <input type="checkbox" checked={training} onChange={(e) => setTraining(e.target.checked)} />
            May train models on those datasets
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2">
            <input type="checkbox" checked={skills} onChange={(e) => setSkills(e.target.checked)} />
            May write skills (an app that keeps its own guides, like HiveBot&apos;s Ultron)
          </label>
          <p className="text-xs text-slate-500 sm:col-span-2">
            Comma or space separated; a <code>*</code> at the end matches the start. The token can then only install, run and read those workflows, use those memory keys,
            fill those datasets and (when allowed) train on them and follow its own training jobs — nothing else in HiveMind.
          </p>
        </div>
      )}
      {fresh && (
        <p className="rounded-md border border-amber-700 bg-amber-950/40 p-2 text-sm">
          Copy it now, it won't be shown again: <code className="break-all">{fresh}</code>
        </p>
      )}
      {tokens.map((t) => (
        <div key={t.id} className="flex items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
          <span className="font-medium">{t.name}</span>
          <code className="text-slate-500">{t.prefix}…</code>
          {t.scope && (
            <span
              className="truncate rounded bg-indigo-950/60 px-1.5 py-0.5 text-xs text-indigo-200"
              title={`Workflows: ${t.scope.canvases.join(', ') || 'none'} · Memory: ${t.scope.memory.join(', ') || 'none'} · Datasets: ${t.scope.datasets?.join(', ') || 'none'}${t.scope.training ? ' · may train' : ''}`}
            >
              limited: {t.scope.canvases.join(' ') || 'no canvases'} · {t.scope.memory.join(' ') || 'no memory'}
              {t.scope.datasets?.length ? ` · ${t.scope.datasets.join(' ')}` : ''}
              {t.scope.training ? ' · trains' : ''}
            </span>
          )}
          {t.scope && (
            <label className="flex shrink-0 items-center gap-1 text-xs text-slate-400" title="May make, change and delete skills">
              <input
                type="checkbox"
                checked={!!t.scope.skills}
                onChange={async (e) => {
                  await api(`/api/tokens/${t.id}`, { method: 'PATCH', body: { skills: e.target.checked } });
                  load();
                }}
              />
              skills
            </label>
          )}
          <span className="text-xs text-slate-500">last used: {t.lastUsedAt ?? 'never'}</span>
          {profileSelect(t.profileId ?? '', async (v) => {
            await api(`/api/access/tokens/${t.id}`, { method: 'PUT', body: { profileId: v || null } });
            load();
          }, 'ml-auto')}
          <button
            className={`btn-ghost text-red-400 ${profiles.length ? '' : 'ml-auto'}`}
            onClick={async () => {
              await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
              load();
            }}
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}
