import { useEffect, useState } from 'react';
import { api } from './api';
import { Login } from './pages/Login';
import { Providers } from './pages/Providers';
import { RunPage } from './pages/Run';
import { Tokens } from './pages/Tokens';

interface Me {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

const TABS = { run: 'Council test', providers: 'Providers', tokens: 'API tokens' } as const;
type Tab = keyof typeof TABS;

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [tab, setTab] = useState<Tab>('run');

  const load = async () => {
    const setup = await api<{ needsSetup: boolean }>('/api/setup');
    setNeedsSetup(setup.needsSetup);
    setMe(await api<Me>('/api/auth/me').catch(() => null));
  };
  useEffect(() => {
    load();
  }, []);

  if (me === undefined) return null;
  if (!me) return <Login setup={needsSetup} onDone={load} />;

  return (
    <div className="mx-auto max-w-7xl p-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <img src="/icon.svg" className="h-8 w-8" alt="" />
        <h1 className="text-xl font-semibold">HiveMind</h1>
        <nav className="ml-4 flex gap-1">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}>
              {TABS[t]}
            </button>
          ))}
        </nav>
        <span className="ml-auto text-sm text-slate-400">{me.username}</span>
        <button
          className="btn-ghost"
          onClick={async () => {
            await api('/api/auth/logout', { method: 'POST' });
            setMe(null);
          }}
        >
          Log out
        </button>
      </header>
      {tab === 'run' && <RunPage />}
      {tab === 'providers' && <Providers isAdmin={me.role === 'admin'} />}
      {tab === 'tokens' && <Tokens />}
    </div>
  );
}
