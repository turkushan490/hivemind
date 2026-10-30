import { useEffect, useState } from 'react';
import { api } from '../api';

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  scope?: { canvases: string[]; memory: string[] };
}

const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState('');
  const [limit, setLimit] = useState(false);
  const [canvases, setCanvases] = useState('');
  const [memory, setMemory] = useState('');

  const load = async () => setTokens(await api('/api/tokens'));
  useEffect(() => {
    load();
  }, []);

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
            const t = await api<{ token: string }>('/api/tokens', { body: { name, ...(limit && { canvases: list(canvases), memory: list(memory) }) } });
            setFresh(t.token);
            setName('');
            setLimit(false);
            load();
          }}
        >
          Create
        </button>
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
          <p className="text-xs text-slate-500 sm:col-span-2">
            Comma or space separated; a <code>*</code> at the end matches the start. The token can then only install, run and read those workflows and use those memory keys — nothing else in HiveMind.
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
            <span className="truncate rounded bg-indigo-950/60 px-1.5 py-0.5 text-xs text-indigo-200" title={`Workflows: ${t.scope.canvases.join(', ') || 'none'} · Memory: ${t.scope.memory.join(', ') || 'none'}`}>
              limited: {t.scope.canvases.join(' ') || 'no canvases'} · {t.scope.memory.join(' ') || 'no memory'}
            </span>
          )}
          <span className="text-xs text-slate-500">last used: {t.lastUsedAt ?? 'never'}</span>
          <button
            className="btn-ghost ml-auto text-red-400"
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
