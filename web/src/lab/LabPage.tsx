import type { ModelInfo, ModelRef, ProviderInfo } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ModelPicker } from '../canvas/ModelPicker';
import { toast } from '../notify';
import { useStored } from '../stored';
import { DatasetsPanel } from './DatasetsPanel';
import { NewModel } from './NewModel';

/** The Training Lab (D&D only): simulate games with fake players, check every DM turn, build a dataset, compare models. */

interface Status {
  id: string;
  name: string;
  running: boolean;
  games: number;
  turns: number;
  badTurns: number;
  errorsPer100: number;
  turnsPerMin?: number;
  failures: number;
  lastError?: string;
  startedAt: number;
  model?: string;
  state: string;
}

interface Turn {
  id: number;
  run_id: string;
  game: number;
  turn: number;
  model: string;
  input: string;
  output: string;
  json_valid: boolean;
  error_types: string[];
  verdict: { errors?: { type: string; detail: string }[]; story?: number; bookkeeper?: string[] } | null;
  jev_verdict: { p: Record<string, number>; flagged: string[]; story?: number } | null;
  story_score?: number;
  jev_story?: number;
  corrected?: string;
  review?: string;
}

interface Score {
  model: string;
  promptVersion: string;
  turns: number;
  jsonValidPct: number;
  rulesPer100: number;
  resourcesPer100: number;
  story?: number;
  jevStory?: number;
  tokensPerSec?: number;
  msPerTurn?: number;
  vramBytes?: number;
}

const ERROR_LABEL: Record<string, string> = { json: 'invalid JSON', roll: 'missing roll', resource: 'resource', number: 'invented number', contradiction: 'contradiction' };
// Training is for any model; the simulator and scoreboard are the DungeonMind (D&D) part.
const TABS = { train: 'New model', data: 'Datasets', sim: 'D&D simulator', score: 'D&D scoreboard' } as const;
type LabTab = keyof typeof TABS;

export function LabPage({ active }: { active: boolean }) {
  const [tab, setTab] = useStored<LabTab>('lab.tab', 'train');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).then((r) => setModels(r.models)).catch(() => {});
    api<ProviderInfo[]>('/api/providers', { quiet: true }).then(setProviders).catch(() => {});
  }, [active]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">
          Training Lab <span className="text-sm font-normal text-slate-400">· make your own AI models</span>
        </h2>
        <nav className="flex gap-1 rounded-lg bg-[#161b22] p-0.5">
          {(Object.keys(TABS) as LabTab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-sm ${tab === t ? 'bg-indigo-500/25 text-indigo-100' : 'text-slate-400 hover:text-white'}`}>
              {TABS[t]}
            </button>
          ))}
        </nav>
      </div>
      <div hidden={tab !== 'sim'}>
        <Simulator active={active && tab === 'sim'} models={models} providers={providers} />
      </div>
      <div hidden={tab !== 'data'}>{tab === 'data' && <Datasets />}</div>
      <div hidden={tab !== 'score'}>{tab === 'score' && <Scoreboard />}</div>
      <div hidden={tab !== 'train'}>{tab === 'train' && <NewModel active={active} providers={providers} onDatasets={() => setTab('data')} />}</div>
    </div>
  );
}

/** A number that counts up to its new value. */
function Ticker({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const from = shown;
    if (from === value) return;
    const t0 = performance.now();
    let id = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 600);
      setShown(from + (value - from) * (1 - (1 - k) ** 3));
      if (k < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [value]);
  return (
    <>
      {Number.isInteger(value) ? Math.round(shown) : shown.toFixed(1)}
      {suffix}
    </>
  );
}

function Stat({ label, value, suffix, tone = 'text-slate-100' }: { label: string; value: number; suffix?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
      <div className="text-[11px] tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`font-mono text-2xl font-semibold ${tone}`}>
        <Ticker value={value} suffix={suffix} />
      </div>
    </div>
  );
}

function Simulator({ active, models, providers }: { active: boolean; models: ModelInfo[]; providers: ProviderInfo[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [dm, setDm] = useStored<ModelRef[]>('lab.dm', []);
  const [players, setPlayers] = useStored<ModelRef | undefined>('lab.players', undefined);
  const [judge, setJudge] = useStored<ModelRef | undefined>('lab.judge', undefined);
  const [jev, setJev] = useStored<ModelRef | undefined>('lab.jev', undefined);
  const [size, setSize] = useStored('lab.size', 3);
  const [turns, setTurns] = useStored('lab.turns', 8);
  const [seed, setSeed] = useStored('lab.seed', 1);
  const [addingDm, setAddingDm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ active: Status | null }>('/api/lab', { quiet: true }).then((r) => setStatus(r.active)).catch(() => {});
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => {
    if (status?.lastError) toast(`Lab: ${status.lastError}`);
  }, [status?.lastError]);

  const running = !!status?.running;
  const start = async () => {
    if (!dm.length || !players) return toast('Pick the DM model(s) and the players’ model', 'info');
    if (!judge && !jev) return toast('Pick a rules-checker: Jev, an LLM judge, or both', 'info');
    setBusy(true);
    try {
      setStatus(await api<Status>('/api/lab/start', { body: { dm, players, judge, jev, partySize: size, turnsPerGame: turns, seed } }));
      toast('Simulation started — it runs until you press Stop', 'ok');
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      setStatus(await api<Status>('/api/lab/stop', { method: 'POST' }));
    } catch {
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <div className="card space-y-3">
        <h3 className="font-semibold">Setup</h3>
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-slate-300">DM model(s) — more than one compares them on the same seeded games</div>
          {dm.map((m, i) => (
            <div key={`${m.providerId}|${m.model}`} className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{m.model}</span>
              <button className="text-slate-500 hover:text-red-400" disabled={running} onClick={() => setDm(dm.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          {addingDm || !dm.length ? (
            <ModelPicker key={dm.length} models={models} providers={providers} onChange={(m) => (setDm([...dm, m]), setAddingDm(false))} />
          ) : (
            <button className="btn-ghost w-full" disabled={running} onClick={() => setAddingDm(true)}>
              + Compare another model
            </button>
          )}
          <p className="text-[11px] text-slate-500">Try e.g. Qwen 8B / 14B, Gemma 12B, Mistral Small / Cydonia 24B, gpt-oss 20B.</p>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold text-slate-300">Fake players</div>
          <ModelPicker models={models} providers={providers} value={players} onChange={setPlayers} />
          <p className="text-[11px] text-slate-500">Reckless fighter, rules-lawyer who cheats resources, sneaky rogue, healer, typo-heavy casual player.</p>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold text-slate-300">Fast rules-checker (Jev) ⚡</div>
          <ModelPicker kind="decision" models={models} providers={providers} value={jev} onChange={setJev} />
          {jev && (
            <button className="text-xs text-slate-500 hover:text-red-400" onClick={() => setJev(undefined)}>
              don’t use Jev
            </button>
          )}
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold text-slate-300">LLM judge — on turns Jev flags and a 10% sample (every turn without Jev)</div>
          <ModelPicker models={models} providers={providers} value={judge} onChange={setJudge} />
          {judge && (
            <button className="text-xs text-slate-500 hover:text-red-400" onClick={() => setJudge(undefined)}>
              no LLM judge
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-slate-400">Players: {size}</span>
            <input type="range" className="w-full" min={2} max={5} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Turns per game: {turns}</span>
            <input type="range" className="w-full" min={2} max={30} value={turns} onChange={(e) => setTurns(Number(e.target.value))} />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Seed</span>
            <input className="input py-1 text-xs" inputMode="numeric" value={seed} onChange={(e) => setSeed(Number(e.target.value.replace(/\D/g, '')) || 1)} />
          </label>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${running ? 'hm-breathe bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'bg-slate-600'}`} />
          <h3 className="font-semibold">{running ? 'Simulating…' : status ? `Last run: ${status.state}` : 'Not running'}</h3>
          {running ? (
            <button className="btn ml-auto bg-red-600 hover:bg-red-500" disabled={busy} onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn ml-auto" disabled={busy} onClick={start}>
              Start
            </button>
          )}
        </div>
        {status ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Games" value={status.games} />
              <Stat label="Turns" value={status.turns} />
              <Stat label="Errors / 100" value={status.errorsPer100} tone={status.errorsPer100 > 20 ? 'text-red-300' : status.errorsPer100 > 5 ? 'text-amber-300' : 'text-emerald-300'} />
              <Stat label="Turns / min" value={status.turnsPerMin ?? 0} />
            </div>
            {running && <div className="h-1 overflow-hidden rounded bg-[#21262d]"><div className="hm-flow h-full w-full bg-indigo-500/60" /></div>}
            <p className="text-xs text-slate-400">
              {status.model && <>Now playing: <span className="text-slate-200">{status.model}</span> · </>}
              {status.failures} failed turn{status.failures === 1 ? '' : 's'} · started {new Date(status.startedAt).toLocaleTimeString()}
            </p>
            {status.lastError && <p className="rounded bg-red-950/50 px-2 py-1 text-xs text-red-300">Last error: {status.lastError} (also in Problems)</p>}
          </>
        ) : (
          <p className="text-sm text-slate-400">Pick the models and press Start. It plays game after game until you press Stop.</p>
        )}
        <p className="rounded-md bg-indigo-950/30 p-2 text-xs text-indigo-200/90">
          Real runs go first: every simulated call takes the GPU and gives it back right after, so a HiveMind or DungeonMind run started now is next in line.
        </p>
      </div>
    </div>
  );
}

function Datasets() {
  const [queue, setQueue] = useState<Turn[]>([]);
  const [recent, setRecent] = useState<Turn[]>([]);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const load = async () => {
    setQueue(await api<Turn[]>('/api/lab/turns?pending=1&limit=50', { quiet: true }).catch(() => []));
    setRecent(await api<Turn[]>('/api/lab/turns?limit=20', { quiet: true }).catch(() => []));
  };
  useEffect(() => {
    load();
  }, []);
  const review = async (t: Turn, verdict: 'accepted' | 'rejected') => {
    try {
      await api(`/api/lab/turns/${t.id}`, { method: 'PATCH', body: { review: verdict, ...(edits[t.id] !== undefined && { corrected: edits[t.id] }) } });
      setQueue((q) => q.filter((x) => x.id !== t.id));
      toast(verdict === 'accepted' ? 'Accepted: the corrected turn goes into the dataset' : 'Rejected', 'ok');
    } catch {}
  };
  return (
    <div className="space-y-4">
      <DatasetsPanel />
      <div className="card flex flex-wrap items-center gap-3">
        <div>
          <h3 className="font-semibold">DungeonMind turns (D&amp;D simulator)</h3>
          <p className="text-xs text-slate-400">Only for the D&amp;D simulator: its clean turns plus accepted corrections, as JSONL. They also fill the &quot;DungeonMind DM&quot; dataset above.</p>
        </div>
        <a className="btn ml-auto" href="/api/lab/export.jsonl" download>
          Export JSONL
        </a>
      </div>
      <div className="card space-y-3">
        <h3 className="font-semibold">
          D&amp;D review queue <span className="text-sm font-normal text-slate-400">· {queue.length} bad turn{queue.length === 1 ? '' : 's'}</span>
        </h3>
        {queue.length === 0 && <p className="text-sm text-slate-400">Nothing to review.</p>}
        {queue.map((t) => (
          <div key={t.id} className="hm-pop space-y-2 rounded-lg border border-[#30363d] p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">
                Game {t.game + 1} · turn {t.turn + 1} · {t.model.split('|').pop()}
              </span>
              {t.error_types.map((e) => (
                <span key={e} className="rounded-full bg-red-950/60 px-2 py-0.5 text-red-200">
                  {ERROR_LABEL[e] ?? e}
                </span>
              ))}
              {t.jev_verdict && <span className="text-indigo-300">Jev flagged: {t.jev_verdict.flagged.join(', ') || 'nothing'}</span>}
            </div>
            {(t.verdict?.errors?.length || t.verdict?.bookkeeper?.length) && (
              <ul className="list-disc pl-5 text-xs text-amber-200/90">
                {t.verdict?.bookkeeper?.map((b) => <li key={b}>Bookkeeper: {b}</li>)}
                {t.verdict?.errors?.map((e, i) => <li key={i}>{e.detail}</li>)}
              </ul>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-400">What the DM saw and wrote</summary>
              <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-slate-400">{t.input}</pre>
              <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-slate-300">{t.output}</pre>
            </details>
            <textarea
              className="input min-h-24 font-mono text-xs"
              placeholder="The corrected turn as JSON (the judge's correction when it wrote one)"
              value={edits[t.id] ?? t.corrected ?? ''}
              onChange={(e) => setEdits((x) => ({ ...x, [t.id]: e.target.value }))}
            />
            <div className="flex gap-2">
              <button className="btn" onClick={() => review(t, 'accepted')}>
                Accept
              </button>
              <button className="btn-ghost text-red-400" onClick={() => review(t, 'rejected')}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="card space-y-2">
        <h3 className="font-semibold">Latest turns</h3>
        {recent.map((t) => (
          <div key={t.id} className="flex items-center gap-2 border-t border-[#30363d] pt-2 text-xs">
            <span className={`h-2 w-2 rounded-full ${t.error_types.length ? 'bg-red-400' : 'bg-emerald-400'}`} />
            <span className="text-slate-400">#{t.id}</span>
            <span className="truncate">{t.model.split('|').pop()}</span>
            <span className="ml-auto text-slate-500">{t.error_types.map((e) => ERROR_LABEL[e] ?? e).join(', ') || 'clean'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const fmt = (n?: number, d = 1) => (n === undefined ? '—' : n.toFixed(d));

function Scoreboard() {
  const [rows, setRows] = useState<Score[] | null>(null);
  useEffect(() => {
    api<Score[]>('/api/lab/scoreboard', { quiet: true }).then(setRows).catch(() => setRows([]));
  }, []);
  const setDefault = async (model: string) => {
    const [providerId, ...rest] = model.split('|');
    try {
      const r = await api<{ canvases: number; blocks: number }>('/api/lab/default', { body: { model: { providerId, model: rest.join('|') } } });
      toast(`Now the default in ${r.canvases} DungeonMind canvas${r.canvases === 1 ? '' : 'es'} (${r.blocks} blocks)`, 'ok');
    } catch {}
  };
  if (!rows) return null;
  if (!rows.length) return <div className="card text-sm text-slate-400">No simulated turns yet: start the simulator.</div>;
  const best = Math.max(...rows.map((r) => r.story ?? r.jevStory ?? 0), 1);
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-slate-400">
          <tr>
            <th className="py-2">Model</th>
            <th>Turns</th>
            <th>JSON valid</th>
            <th>Rule / number errors per 100</th>
            <th>Missed resources per 100</th>
            <th>Story (judge · Jev)</th>
            <th>Tokens/s</th>
            <th>Time / turn</th>
            <th>VRAM</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.model}-${r.promptVersion}`} className={`border-t border-[#30363d] ${i === 0 ? 'bg-emerald-950/20' : ''}`}>
              <td className="py-2">
                {i === 0 && '🏆 '}
                {r.model.split('|').pop()} <span className="text-xs text-slate-500">{r.promptVersion}</span>
              </td>
              <td>{r.turns}</td>
              <td className={r.jsonValidPct >= 98 ? 'text-emerald-300' : 'text-amber-300'}>{fmt(r.jsonValidPct)}%</td>
              <td className={r.rulesPer100 > 10 ? 'text-red-300' : ''}>{fmt(r.rulesPer100)}</td>
              <td className={r.resourcesPer100 > 5 ? 'text-red-300' : ''}>{fmt(r.resourcesPer100)}</td>
              <td>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-16 overflow-hidden rounded bg-[#21262d]">
                    <div className="hm-dbar h-full bg-fuchsia-400" style={{ width: `${((r.story ?? r.jevStory ?? 0) / best) * 100}%` }} />
                  </div>
                  {fmt(r.story)} · {fmt(r.jevStory)}
                </div>
              </td>
              <td>{fmt(r.tokensPerSec, 0)}</td>
              <td>{r.msPerTurn === undefined ? '—' : `${(r.msPerTurn / 1000).toFixed(1)} s`}</td>
              <td>{r.vramBytes ? `${(r.vramBytes / 1e9).toFixed(1)} GB` : '—'}</td>
              <td>
                <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setDefault(r.model)}>
                  Set as DungeonMind default
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
