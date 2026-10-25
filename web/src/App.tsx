import { useEffect, useState } from 'react';
import { api } from './api';
import { MemoryButton } from './components/MemoryButton';
import { Toasts } from './components/Toasts';
import { Login } from './pages/Login';
import { Problems } from './pages/Problems';
import { Providers } from './pages/Providers';
import { RunPage } from './pages/Run';
import { Tokens } from './pages/Tokens';
import { useStored } from './stored';

interface Me {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

const TABS = { run: 'Council test', providers: 'Providers', tokens: 'API tokens', problems: 'Problems' } as const;
type Tab = keyof typeof TABS;

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [tab, setTab] = useStored<Tab>('tab', 'run');
  // Tabs stay mounted once opened, so switching never loses what you picked or a running council.
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  useEffect(() => setOpened((o) => (o.has(tab) ? o : new Set(o).add(tab))), [tab]);
  const [unseen, setUnseen] = useState(0);
  const [serverDown, setServerDown] = useState(false);

  const load = async () => {
    try {
      const setup = await api<{ needsSetup: boolean }>('/api/setup', { quiet: true });
      setNeedsSetup(setup.needsSetup);
      setServerDown(false);
    } catch {
      setServerDown(true);
    }
    setMe(await api<Me>('/api/auth/me', { quiet: true }).catch(() => null));
  };
  useEffect(() => {
    load();
  }, []);

  // Heartbeat: a dead server or new problems show up without a reload.
  useEffect(() => {
    if (!me) return;
    const beat = async () => {
      try {
        const { unseen } = await api<{ unseen: number }>('/api/problems/unseen', { quiet: true });
        setUnseen(unseen);
        setServerDown(false);
      } catch (err) {
        if ((err as { status?: number }).status === 0) setServerDown(true);
        if ((err as { status?: number }).status === 401) setMe(null);
      }
    };
    beat();
    const t = setInterval(beat, 10_000);
    return () => clearInterval(t);
  }, [me]);

  const banner = serverDown && (
    <div role="alert" className="sticky top-0 z-30 bg-red-700 px-4 py-2 text-center text-sm font-medium text-white">
      Lost connection to the HiveMind server. Retrying every 10 seconds… (is the container running?)
    </div>
  );

  if (me === undefined) return banner || null;
  if (!me)
    return (
      <>
        {banner}
        <Login setup={needsSetup} onDone={load} />
        <Toasts />
      </>
    );

  return (
    <>
      {banner}
      <div className="mx-auto max-w-7xl p-4">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <img src="/icon.svg" className="h-8 w-8" alt="" />
          <h1 className="text-xl font-semibold">HiveMind</h1>
          <nav className="ml-4 flex gap-1">
            {(Object.keys(TABS) as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${tab === t ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {TABS[t]}
                {t === 'problems' && unseen > 0 && <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{unseen}</span>}
              </button>
            ))}
          </nav>
          <span className="ml-auto" />
          <MemoryButton />
          <span className="text-sm text-slate-400">{me.username}</span>
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
        {opened.has('run') && (
          <div hidden={tab !== 'run'}>
            <RunPage active={tab === 'run'} onProblem={() => setUnseen((n) => n + 1)} />
          </div>
        )}
        {opened.has('providers') && (
          <div hidden={tab !== 'providers'}>
            <Providers isAdmin={me.role === 'admin'} />
          </div>
        )}
        {opened.has('tokens') && (
          <div hidden={tab !== 'tokens'}>
            <Tokens />
          </div>
        )}
        {opened.has('problems') && (
          <div hidden={tab !== 'problems'}>
            <Problems active={tab === 'problems'} onSeen={() => setUnseen(0)} />
          </div>
        )}
      </div>
      <Toasts />
    </>
  );
}
