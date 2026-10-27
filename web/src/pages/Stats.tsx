import type { StatsReport } from '@hivemind/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStored } from '../stored';

/** One hue for every single-series chart (contrast-checked against the card surface). */
const BAR = '#818cf8';
const RANGES = [7, 30, 90, 365] as const;

const usd = (v: number) => (v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v).toLocaleString('en')}`);
const num = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v.toLocaleString('en'));
const short = (m: string) => m.split('/').pop()!.replace(/:latest$/, '');

/** Stats: what the AIs cost, how fast they are, and which models win Judge/Vote picks. */
export function Stats({ active, isAdmin }: { active: boolean; isAdmin: boolean }) {
  const [days, setDays] = useStored<number>('stats.days', 30);
  const [everyone, setEveryone] = useStored('stats.everyone', false);
  const [r, setR] = useState<StatsReport | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    api<StatsReport>(`/api/stats?days=${days}${isAdmin && everyone ? '&scope=all' : ''}`, { quiet: true })
      .then((x) => {
        setR(x);
        setError('');
      })
      .catch((err) => setError((err as Error).message));
  }, [active, days, everyone, isAdmin]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-lg font-semibold">Stats</h2>
        <div className="flex rounded-md border border-[#30363d] p-0.5">
          {RANGES.map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`rounded px-3 py-1 text-sm ${days === d ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}>
              {d === 365 ? '1 year' : `${d} days`}
            </button>
          ))}
        </div>
        {isAdmin && (
          <div className="flex rounded-md border border-[#30363d] p-0.5">
            {[false, true].map((all) => (
              <button key={String(all)} onClick={() => setEveryone(all)} className={`rounded px-3 py-1 text-sm ${everyone === all ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}>
                {all ? 'Everyone' : 'Only me'}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">Could not load the stats: {error}</p>}
      {r && r.totals.calls === 0 && (
        <div className="card text-sm text-slate-400">No model calls in this period yet. Every run from now on is counted here: cost, tokens, speed and which models win.</div>
      )}
      {r && r.totals.calls > 0 && <Report r={r} />}
    </div>
  );
}

function Report({ r }: { r: StatsReport }) {
  const t = r.totals;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Cost" value={usd(t.cost)} note={t.unpricedCalls ? `${t.unpricedCalls} call${t.unpricedCalls > 1 ? 's' : ''} with unknown price` : 'free models count as $0'} />
        <Tile label="Tokens in / out" value={`${num(t.inputTokens)} / ${num(t.outputTokens)}`} />
        <Tile label="Runs" value={num(t.runs)} />
        <Tile label="Model calls" value={num(t.calls)} />
      </div>

      <section className="card space-y-2">
        <h3 className="font-semibold">Cost per day</h3>
        <DayChart r={r} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-2">
          <h3 className="font-semibold">Per provider</h3>
          <BarTable
            rows={r.byProvider.map((p) => ({ key: p.providerId, label: p.name, value: p.cost, cells: [num(p.calls), num(p.inputTokens + p.outputTokens), usd(p.cost)] }))}
            heads={['Provider', 'Calls', 'Tokens', 'Cost']}
          />
        </section>
        <section className="card space-y-2">
          <h3 className="font-semibold">Speed (tokens/sec)</h3>
          <BarTable
            rows={r.byModel
              .filter((m) => m.tokensPerSec)
              .sort((a, b) => b.tokensPerSec! - a.tokensPerSec!)
              .map((m) => ({ key: `${m.providerId}|${m.model}`, label: short(m.model), title: `${m.model} (${m.providerId})`, value: m.tokensPerSec!, cells: [m.tokensPerSec!.toFixed(1)] }))}
            heads={['Model', 'Tokens/sec']}
            empty="No speed measured yet (needs a provider that reports generation time, like Ollama)."
          />
        </section>
      </div>

      <section className="card space-y-2">
        <h3 className="font-semibold">Per model</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="py-1 pr-3 font-medium">Provider</th>
                <th className="py-1 pr-3 text-right font-medium">Calls</th>
                <th className="py-1 pr-3 text-right font-medium">Tokens in</th>
                <th className="py-1 pr-3 text-right font-medium">Tokens out</th>
                <th className="py-1 pr-3 text-right font-medium">Tokens/sec</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {r.byModel.map((m) => (
                <tr key={`${m.providerId}|${m.model}`} className="border-t border-[#30363d]">
                  <td className="py-1.5 pr-3" title={m.model}>
                    {short(m.model)}
                  </td>
                  <td className="py-1.5 pr-3 text-slate-400">{m.providerId}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{num(m.calls)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{num(m.inputTokens)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{num(m.outputTokens)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.tokensPerSec ? m.tokensPerSec.toFixed(1) : '–'}</td>
                  <td className="py-1.5 text-right tabular-nums" title={m.priced ? undefined : 'Price unknown for some calls (counted as $0) — add it to server/src/services/pricing.ts'}>
                    {usd(m.cost)}
                    {!m.priced && <span className="ml-1 text-amber-300">?</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-2">
        <h3 className="font-semibold">Leaderboard</h3>
        <p className="text-xs text-slate-400">How often a model’s answer was picked as the best by a Judge (it names the best answer) or won a Vote.</p>
        {r.leaderboard.length === 0 ? (
          <p className="text-sm text-slate-500">No Judge or Vote picks yet — run a canvas with a Judge or Vote block and two or more answers.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="w-8 py-1 font-medium">#</th>
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="py-1 pr-3 text-right font-medium">Wins</th>
                <th className="py-1 pr-3 text-right font-medium">Contests</th>
                <th className="w-1/3 py-1 font-medium">Win rate</th>
              </tr>
            </thead>
            <tbody>
              {r.leaderboard.map((l, i) => (
                <tr key={l.model} className="border-t border-[#30363d]">
                  <td className="py-1.5 text-slate-500 tabular-nums">{i + 1}</td>
                  <td className="py-1.5 pr-3" title={l.model}>
                    {short(l.model)}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{l.wins}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{l.contests}</td>
                  <td className="py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-full bg-[#21262d]">
                        <div className="h-2 rounded-full" style={{ width: `${Math.round(l.winRate * 100)}%`, background: BAR }} />
                      </div>
                      <span className="w-10 text-right text-xs text-slate-300 tabular-nums">{Math.round(l.winRate * 100)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

const Tile = ({ label, value, note }: { label: string; value: string; note?: string }) => (
  <div className="card space-y-1">
    <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">{label}</div>
    <div className="text-2xl font-semibold tabular-nums">{value}</div>
    {note && <div className="text-xs text-slate-500">{note}</div>}
  </div>
);

/** Rows with an inline bar for the first value, scaled to the largest. */
function BarTable({ rows, heads, empty }: { rows: { key: string; label: string; title?: string; value: number; cells: string[] }[]; heads: string[]; empty?: string }) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{empty ?? 'Nothing yet.'}</p>;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-slate-500">
        <tr>
          {heads.map((h, i) => (
            <th key={h} className={`py-1 font-medium ${i ? 'pl-3 text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-[#30363d]">
            <td className="py-1.5" title={r.title ?? r.label}>
              <div className="truncate">{r.label}</div>
              <div className="mt-1 h-1.5 rounded-full" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: BAR }} />
            </td>
            {r.cells.map((c, i) => (
              <td key={i} className="py-1.5 pl-3 text-right align-top tabular-nums">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Bars per day (missing days are 0), with a hover tooltip and a table view. */
function DayChart({ r }: { r: StatsReport }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => {
    const byDay = new Map(r.byDay.map((d) => [d.day, d]));
    const out: { day: string; cost: number; tokens: number; runs: number }[] = [];
    const n = Math.min(r.days, 365);
    for (let i = n - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      out.push(byDay.get(day) ?? { day, cost: 0, tokens: 0, runs: 0 });
    }
    return out;
  }, [r]);
  const max = Math.max(...days.map((d) => d.cost));
  const W = 800;
  const H = 180;
  const pad = { l: 52, b: 22, t: 8 };
  const slot = (W - pad.l) / days.length;
  const bw = Math.max(1, slot - 2);
  const y = (v: number) => H - pad.b - (max ? (v / max) * (H - pad.b - pad.t) : 0);
  const ticks = max ? [0, max / 2, max] : [0];
  const h = hover !== null ? days[hover] : null;

  if (max === 0) return <p className="text-sm text-slate-500">Everything in this period was free ($0) — see tokens per model below.</p>;
  return (
    <div className="space-y-2">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cost per day" onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W} y1={y(v)} y2={y(v)} stroke="#30363d" strokeWidth={1} />
              <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="#8b949e">
                {usd(v)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const x = pad.l + i * slot + 1;
            const top = y(d.cost);
            const height = H - pad.b - top;
            return (
              <g key={d.day}>
                {height > 0 && (
                  <path
                    d={`M${x},${H - pad.b} V${top + Math.min(4, height)} q0,-${Math.min(4, height)} ${Math.min(4, bw / 2)},-${Math.min(4, height)} H${x + bw - Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, height)} V${H - pad.b} Z`}
                    fill={BAR}
                    opacity={hover === null || hover === i ? 1 : 0.5}
                  />
                )}
                {/* Hit target: the whole column, bigger than the bar. */}
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          {[0, days.length - 1].map((i) => (
            <text key={i} x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor={i ? 'end' : 'start'} fontSize={11} fill="#8b949e">
              {days[i].day.slice(5)}
            </text>
          ))}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute top-0 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-xs shadow-lg"
            style={{ left: `${((pad.l + hover! * slot + slot / 2) / W) * 100}%`, transform: 'translateX(-50%)' }}
          >
            <div className="font-semibold text-slate-200">{h.day}</div>
            <div className="text-slate-300">
              {usd(h.cost)} · {num(h.tokens)} tokens · {h.runs} run{h.runs === 1 ? '' : 's'}
            </div>
          </div>
        )}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-400">Show as table</summary>
        <table className="mt-1 w-full">
          <tbody>
            {days
              .filter((d) => d.runs)
              .map((d) => (
                <tr key={d.day} className="border-t border-[#30363d]">
                  <td className="py-1">{d.day}</td>
                  <td className="py-1 text-right tabular-nums">{usd(d.cost)}</td>
                  <td className="py-1 text-right tabular-nums">{num(d.tokens)} tokens</td>
                  <td className="py-1 text-right tabular-nums">{d.runs} runs</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
