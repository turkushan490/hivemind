import type { DecisionEvent, DecisionView } from '@hivemind/shared';
import { useEffect, useState } from 'react';

const COLOR: Record<string, string> = { noul: '#818cf8', choice: '#22d3ee', score: '#f472b6', box: '#facc15', refusal: '#6e7681' };
const pct = (p?: number) => `${Math.round((p ?? 0) * 100)}%`;

/** Starts at 0 and fills to the value one frame later, so every new answer animates in. */
function useGrow(value: number, key: unknown) {
  const [v, setV] = useState(0);
  useEffect(() => {
    setV(0);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setV(value)));
    return () => cancelAnimationFrame(id);
  }, [value, key]);
  return v;
}

function Bar({ label, p, color, picked, delay, big, seed }: { label: string; p: number; color: string; picked?: boolean; delay: number; big?: boolean; seed: unknown }) {
  const w = useGrow(p, seed);
  return (
    <div className={`flex items-center gap-1.5 px-1 ${picked ? 'hm-picked' : ''}`} style={{ ['--hm-pick' as string]: color }}>
      <span className={`w-20 shrink-0 truncate ${big ? 'text-xs' : 'text-[10px]'} ${picked ? 'font-semibold text-white' : 'text-slate-400'}`} title={label}>
        {label}
      </span>
      <div className={`relative flex-1 overflow-hidden rounded-full bg-[#21262d] ${big ? 'h-2.5' : 'h-1.5'}`}>
        <div
          className={`hm-dbar relative h-full overflow-hidden rounded-full ${picked ? 'hm-dbar-sweep' : ''}`}
          style={{ width: `${Math.max(0, Math.min(1, w)) * 100}%`, background: picked ? `linear-gradient(90deg, ${color}aa, ${color})` : `${color}66`, transitionDelay: `${delay}ms` }}
        />
      </div>
      <span className={`w-9 shrink-0 text-right font-mono ${big ? 'text-xs' : 'text-[10px]'} ${picked ? 'text-white' : 'text-slate-500'}`}>{pct(p)}</span>
    </div>
  );
}

function Answer({ a, i, big, threshold, seed }: { a: DecisionView; i: number; big?: boolean; threshold?: number; seed: unknown }) {
  const color = COLOR[a.type] ?? '#818cf8';
  const head = (right: string) => (
    <div className={`flex items-center gap-1 px-1 ${big ? 'text-xs' : 'text-[10px]'}`}>
      <span className="font-semibold text-slate-200">{a.name}</span>
      <span className="rounded px-1 text-[9px] uppercase" style={{ color, background: `${color}22` }}>
        {a.type}
      </span>
      <span className="ml-auto truncate text-slate-400">{right}</span>
    </div>
  );
  const d = i * 120;
  if (a.type === 'noul') {
    const yes = (a.p ?? 0) >= (threshold ?? 0.5);
    return (
      <div className="space-y-0.5">
        {head(yes ? 'yes' : 'no')}
        <Bar label="yes" p={a.p ?? 0} color={color} picked={yes} delay={d} big={big} seed={seed} />
        <Bar label="no" p={1 - (a.p ?? 0)} color="#64748b" picked={!yes} delay={d + 60} big={big} seed={seed} />
      </div>
    );
  }
  if (a.type === 'choice' || a.type === 'score') {
    const entries = Object.entries(a.probabilities ?? {});
    const labelOf = (k: string) => (a.type === 'score' ? (a.levels?.[Number(k)] ?? `level ${k}`) : k);
    const best = entries.reduce((m, e) => (e[1] > m[1] ? e : m), ['', -1] as [string, number])[0];
    return (
      <div className="space-y-0.5">
        {head(a.type === 'score' ? `${(a.score ?? 0).toFixed(2)} / ${Math.max(0, (a.levels?.length ?? entries.length) - 1)}` : (a.pick ?? best))}
        {entries.slice(0, 8).map(([k, p], j) => (
          <Bar key={k} label={labelOf(k)} p={p} color={color} picked={a.type === 'choice' ? k === (a.pick ?? best) : k === best} delay={d + j * 60} big={big} seed={seed} />
        ))}
      </div>
    );
  }
  if (a.type === 'box' && a.box)
    return head(`top ${pct(a.box.top)} · left ${pct(a.box.left)} · ${pct(a.box.right - a.box.left)} × ${pct(a.box.bottom - a.box.top)}`);
  return head('no answer (refused)');
}

/** Live probability bars of a decision model's answer: fill on arrival, pick glows, decision time in ms. */
export function DecisionBars({ d, big }: { d: DecisionEvent; big?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px]">
        <span className="hm-zap rounded-full bg-indigo-500/20 px-1.5 py-px font-mono font-semibold text-indigo-200">⚡ {d.ms} ms</span>
        <span className="truncate text-slate-500">{d.model}</span>
        {d.route && <span className="hm-zap ml-auto truncate rounded-full bg-emerald-500/15 px-1.5 py-px font-semibold text-emerald-200">→ {d.route}</span>}
      </div>
      {d.answers.map((a, i) => (
        <Answer key={a.name} a={a} i={i} big={big} threshold={d.threshold} seed={d} />
      ))}
    </div>
  );
}

/** The box a box question found, drawn over the image. */
export function BoxOverlay({ image, box }: { image: string; box: NonNullable<DecisionView['box']> }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-[#30363d]">
      <img src={`/api/files/raw?inline=1&path=${encodeURIComponent(image)}`} alt="" className="block w-full" />
      <div
        className="hm-pop absolute border-2 border-yellow-300 shadow-[0_0_12px_#facc15]"
        style={{ top: `${box.top * 100}%`, left: `${box.left * 100}%`, width: `${(box.right - box.left) * 100}%`, height: `${(box.bottom - box.top) * 100}%` }}
      />
    </div>
  );
}
