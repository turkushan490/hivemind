import { useEffect, useState } from 'react';
import { api } from '../api';

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState('');

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
            const t = await api<{ token: string }>('/api/tokens', { body: { name } });
            setFresh(t.token);
            setName('');
            load();
          }}
        >
          Create
        </button>
      </div>
      {fresh && (
        <p className="rounded-md border border-amber-700 bg-amber-950/40 p-2 text-sm">
          Copy it now, it won't be shown again: <code className="break-all">{fresh}</code>
        </p>
      )}
      {tokens.map((t) => (
        <div key={t.id} className="flex items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
          <span className="font-medium">{t.name}</span>
          <code className="text-slate-500">{t.prefix}…</code>
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
