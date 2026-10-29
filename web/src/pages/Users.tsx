import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

type Role = 'admin' | 'user' | 'viewer';
interface UserRow {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
}

const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything, including users and shared settings',
  user: 'Builds and runs their own workflows, adds their own AI keys',
  viewer: 'Only uses shared canvases (Use mode, voice, API tokens)',
};

/** Settings → Users (admins): add people, change roles, reset passwords, remove. */
export function Users({ meId, active }: { meId: string; active: boolean }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const load = () => api<UserRow[]>('/api/users', { quiet: true }).then(setUsers).catch((err) => toast(`Could not load users: ${(err as Error).message}`));
  useEffect(() => {
    if (active) load();
  }, [active]);

  const add = async () => {
    await api('/api/users', { body: { username: name.trim(), password, role } });
    toast(`Added ${name.trim()} as ${role}`, 'ok');
    setName('');
    setPassword('');
    load();
  };

  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Users</h2>
      <ul className="space-y-0.5 text-xs text-slate-400">
        {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
          <li key={r}>
            <span className="font-semibold text-slate-300 capitalize">{r}</span> — {ROLE_INFO[r]}
          </li>
        ))}
      </ul>
      {users.map((u) => (
        <div key={u.id} className="flex flex-wrap items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
          <span className="font-medium">{u.username}</span>
          {u.id === meId && <span className="text-xs text-slate-500">(you)</span>}
          <select
            className="input ml-auto w-auto py-1 text-xs"
            value={u.role}
            disabled={u.id === meId}
            title={u.id === meId ? "You can't change your own role" : 'Role'}
            onChange={async (e) => {
              await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } });
              toast(`${u.username} is now ${e.target.value}`, 'ok');
              load();
            }}
          >
            {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost text-xs"
            onClick={async () => {
              const pw = prompt(`New password for ${u.username} (at least 8 characters):`);
              if (!pw) return;
              await api(`/api/users/${u.id}`, { method: 'PATCH', body: { password: pw } });
              toast(`New password set for ${u.username}${u.id === meId ? '' : ' — they are logged out everywhere'}`, 'ok');
            }}
          >
            Password
          </button>
          {u.id !== meId && (
            <button
              className="btn-ghost text-xs text-red-400"
              onClick={async () => {
                if (!confirm(`Remove ${u.username}? Their workflows, runs and tokens are deleted too.`)) return;
                await api(`/api/users/${u.id}`, { method: 'DELETE' });
                load();
              }}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <form
        className="flex flex-wrap gap-2 border-t border-[#30363d] pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          add().catch(() => {});
        }}
      >
        <input className="input w-40 py-1" placeholder="Username" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <input className="input w-44 py-1" type="password" placeholder="Password (8+)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <select className="input w-auto py-1" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!name.trim() || password.length < 8}>
          Add user
        </button>
      </form>
    </div>
  );
}
