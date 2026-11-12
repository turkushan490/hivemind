import { useEffect, useState } from 'react';
import { api } from './api';
import { MemoryButton } from './components/MemoryButton';
import { Toasts } from './components/Toasts';
import { CanvasPage, type FollowRequest } from './canvas/CanvasPage';
import { ActivityPage } from './pages/ActivityPage';
import { FilesPage } from './pages/FilesPage';
import { Login } from './pages/Login';
import { Problems } from './pages/Problems';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunPage } from './pages/Run';
import { Settings } from './pages/Settings';
import { Stats } from './pages/Stats';
import { SetupWizard } from './pages/SetupWizard';
import { UsePage } from './pages/UsePage';
import { useStored } from './stored';
import { useIsPhone } from './phone';
import { LabPage } from './lab/LabPage';

interface Me {
  id: string;
  username: string;
  role: 'admin' | 'user' | 'viewer';
}

const TABS = { use: 'Use', canvas: 'Workflow', projects: 'Projects', files: 'Files', run: 'Quick council', stats: 'Stats', lab: 'Lab', activity: 'Activity', settings: 'Settings', problems: 'Problems' } as const;
type Tab = keyof typeof TABS;
/** Viewers only use canvases. */
const VIEWER_TABS: Tab[] = ['use', 'activity', 'settings', 'problems'];
/** Phone: these four sit in the bottom bar; the rest are under "More". */
const PHONE_TABS: Tab[] = ['use', 'canvas', 'activity', 'settings'];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [storedTab, setTab] = useStored<Tab>('tab', 'canvas');
  const allowed = (t: Tab) => t in TABS && (me?.role !== 'viewer' || VIEWER_TABS.includes(t));
  const tab: Tab = allowed(storedTab) ? storedTab : me?.role === 'viewer' ? 'use' : 'canvas';
  // Tabs stay mounted once opened, so switching never loses what you picked or a running council.
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  useEffect(() => setOpened((o) => (o.has(tab) ? o : new Set(o).add(tab))), [tab]);
  const [unseen, setUnseen] = useState(0);
  const [waiting, setWaiting] = useState(0);
  // Activity → Follow on canvas: the Workflow tab shows that run live.
  const [followRequest, setFollowRequest] = useState<FollowRequest>();
  const [serverDown, setServerDown] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [build, setBuild] = useState<{ version: string; release: string }>();
  const phone = useIsPhone();
  const [more, setMore] = useState(false);

  useEffect(() => {
    api<{ version: string; release: string }>('/api/health', { quiet: true }).then(setBuild).catch(() => {});
  }, []);

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

  // First login: the setup wizard (once per user; Settings → Builder AI shows it again).
  useEffect(() => {
    if (!me || me.role === 'viewer') return;
    api<{ setupDone?: boolean }>('/api/me/prefs', { quiet: true })
      .then((p) => !p.setupDone && setWizard(true))
      .catch(() => {});
  }, [me?.id]);

  // Heartbeat: a dead server or new problems show up without a reload.
  useEffect(() => {
    if (!me) return;
    const beat = async () => {
      try {
        const { unseen } = await api<{ unseen: number }>('/api/problems/unseen', { quiet: true });
        setUnseen(unseen);
        // Runs waiting at a Pause block (yours; an admin's: everyone's).
        const act = await api<{ runs: { paused?: unknown[] }[] }>('/api/activity/running', { quiet: true }).catch(() => undefined);
        if (act) setWaiting(act.runs.reduce((n, r) => n + (r.paused?.length ?? 0), 0));
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

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setMe(null);
  };

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
      {/* Every tab has the same full-width frame, so nothing jumps when you switch. */}
      <div className={`mx-auto max-w-none p-2 sm:p-4 ${phone ? 'pb-20' : ''}`}>
        <header className="mb-3 flex flex-wrap items-center gap-2 sm:mb-4 sm:gap-3">
          <img src="/icon.svg" className="h-7 w-7 sm:h-8 sm:w-8" alt="" />
          <h1 className="text-lg font-semibold sm:text-xl">HiveMind</h1>
          {build &&
            // A clean release (e.g. 1.0.0) shows just its version; a rolling build (1.0.0-dev.N) is marked "Beta".
            (build.release.includes('-') || build.release === 'dev' ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300" title={`Commit ${build.version.slice(0, 7)}`}>
                Beta · v{build.release}
              </span>
            ) : (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-300" title={`Commit ${build.version.slice(0, 7)}`}>
                v{build.release}
              </span>
            ))}
          {!phone && (
            <nav className="ml-2 flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none] 2xl:ml-4 2xl:gap-1">
              {(Object.keys(TABS) as Tab[]).filter(allowed).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm 2xl:px-3 ${tab === t ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  {TABS[t]}
                  <Badge t={t} unseen={unseen} waiting={waiting} />
                </button>
              ))}
            </nav>
          )}
          <span className="ml-auto" />
          {me.role !== 'viewer' && <MemoryButton />}
          {!phone && (
            <span className="hidden text-sm text-slate-400 2xl:inline" title={`Role: ${me.role}`}>
              {me.username}
              {me.role !== 'user' && <span className="ml-1.5 rounded bg-[#21262d] px-1.5 py-0.5 text-xs text-slate-400">{me.role}</span>}
            </span>
          )}
          {!phone && (
            <button className="btn-ghost" onClick={logout}>
              Log out
            </button>
          )}
        </header>
        {opened.has('use') && (
          <div hidden={tab !== 'use'}>
            <UsePage active={tab === 'use'} viewer={me.role === 'viewer'} onProblem={() => setUnseen((n) => n + 1)} onBuild={() => setTab('canvas')} />
          </div>
        )}
        {opened.has('canvas') && (
          <div hidden={tab !== 'canvas'}>
            <CanvasPage active={tab === 'canvas'} onProblem={() => setUnseen((n) => n + 1)} followRequest={followRequest} />
          </div>
        )}
        {opened.has('projects') && (
          <div hidden={tab !== 'projects'}>
            <ProjectsPage active={tab === 'projects'} />
          </div>
        )}
        {opened.has('files') && (
          <div hidden={tab !== 'files'}>
            <FilesPage isAdmin={me.role === 'admin'} active={tab === 'files'} />
          </div>
        )}
        {opened.has('run') && (
          <div hidden={tab !== 'run'}>
            <RunPage active={tab === 'run'} onProblem={() => setUnseen((n) => n + 1)} />
          </div>
        )}
        {opened.has('stats') && (
          <div hidden={tab !== 'stats'}>
            <Stats active={tab === 'stats'} isAdmin={me.role === 'admin'} />
          </div>
        )}
        {opened.has('lab') && (
          <div hidden={tab !== 'lab'}>
            <LabPage active={tab === 'lab'} />
          </div>
        )}
        {opened.has('activity') && (
          <div hidden={tab !== 'activity'}>
            <ActivityPage
              active={tab === 'activity'}
              isAdmin={me.role === 'admin'}
              onOpenLab={() => setTab('lab')}
              onFollow={(runId, title) => {
                setFollowRequest((f) => ({ runId, title, n: (f?.n ?? 0) + 1 }));
                setTab('canvas');
              }}
            />
          </div>
        )}
        {opened.has('settings') && (
          <div hidden={tab !== 'settings'}>
            <Settings role={me.role} meId={me.id} active={tab === 'settings'} onWizard={() => setWizard(true)} />
          </div>
        )}
        {opened.has('problems') && (
          <div hidden={tab !== 'problems'}>
            <Problems active={tab === 'problems'} onSeen={() => setUnseen(0)} />
          </div>
        )}
      </div>
      {phone && (
        <>
          {more && <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setMore(false)} />}
          {more && (
            <div className="fixed inset-x-0 bottom-16 z-50 mx-2 grid grid-cols-2 gap-2 rounded-xl border border-[#30363d] bg-[#161b22] p-3 shadow-2xl">
              {(Object.keys(TABS) as Tab[])
                .filter((t) => allowed(t) && !PHONE_TABS.includes(t))
                .map((t) => (
                  <button
                    key={t}
                    className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-left text-sm ${tab === t ? 'bg-[#21262d] text-white' : 'text-slate-300'}`}
                    onClick={() => {
                      setTab(t);
                      setMore(false);
                    }}
                  >
                    {TABS[t]}
                    <Badge t={t} unseen={unseen} waiting={waiting} />
                  </button>
                ))}
              <div className="col-span-2 flex items-center pt-1 text-xs text-slate-500">
                Signed in as {me.username}
                <button className="btn-ghost ml-auto min-h-11 text-sm" onClick={logout}>
                  Log out
                </button>
              </div>
            </div>
          )}
          <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-[#30363d] bg-[#0d1117]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
            {PHONE_TABS.filter(allowed).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTab(t);
                  setMore(false);
                }}
                className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${tab === t ? 'text-white' : 'text-slate-400'}`}
              >
                <span className="text-lg leading-none">{PHONE_ICONS[t]}</span>
                <span className="flex items-center gap-1">
                  {TABS[t]}
                  <Badge t={t} unseen={unseen} waiting={waiting} />
                </span>
              </button>
            ))}
            <button
              onClick={() => setMore((m) => !m)}
              className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${more || !PHONE_TABS.includes(tab) ? 'text-white' : 'text-slate-400'}`}
            >
              <span className="text-lg leading-none">☰</span>
              <span className="flex items-center gap-1">
                More
                {unseen > 0 && <span className="h-2 w-2 rounded-full bg-red-600" />}
              </span>
            </button>
          </nav>
        </>
      )}
      {wizard && <SetupWizard onDone={() => setWizard(false)} onOpen={(t) => setTab(t)} />}
      <Toasts />
    </>
  );
}

const PHONE_ICONS: Partial<Record<Tab, string>> = { use: '💬', canvas: '🕸', activity: '⏱', settings: '⚙' };

/** Problems not seen yet; runs waiting at a Pause block. */
function Badge({ t, unseen, waiting }: { t: Tab; unseen: number; waiting: number }) {
  if (t === 'problems' && unseen > 0) return <span className="rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">{unseen}</span>;
  if (t === 'activity' && waiting > 0)
    return (
      <span className="rounded-full bg-orange-500 px-1.5 text-xs font-semibold text-white" title="Runs waiting for you at a Pause block">
        {waiting}
      </span>
    );
  return null;
}
