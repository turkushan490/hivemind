import { useEffect, useMemo, useRef } from 'react';
import type { NodeState } from '../run/state';

/** Colours of the spinning aura around a working block. */
const AURA: Partial<Record<NodeState, [string, string]>> = {
  loading: ['#f59e0b', '#fde68a'],
  thinking: ['#a78bfa', '#f472b6'],
  streaming: ['#22d3ee', '#818cf8'],
};

/** A conic-gradient ring that spins around the block, plus a soft blurred glow behind it. */
export function Aura({ state }: { state: NodeState }) {
  const c = AURA[state];
  if (!c) return null;
  const style = { ['--c1' as string]: c[0], ['--c2' as string]: c[1] };
  return (
    <>
      <div className="hm-aura hm-aura-glow" style={style} aria-hidden />
      <div className="hm-aura" style={style} aria-hidden />
    </>
  );
}

/** Green ring that pops once when a block finishes (or red when it fails). */
export function Burst({ state }: { state: NodeState }) {
  if (state !== 'done' && state !== 'error') return null;
  return <div key={state} className={`hm-burst ${state === 'error' ? 'hm-burst-error' : ''}`} aria-hidden />;
}

/** A small "brain core": pulsing nucleus with particles orbiting on three tilted rings. */
export function ThinkingCore() {
  return (
    <svg viewBox="0 0 64 64" className="h-12 w-12 shrink-0" aria-hidden>
      <defs>
        <radialGradient id="hm-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fdf4ff" />
          <stop offset="45%" stopColor="#e879f9" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="13" fill="url(#hm-core)" className="hm-core-pulse" />
      {[0, 60, 120].map((tilt, i) => (
        <g key={tilt} transform={`rotate(${tilt} 32 32)`}>
          <ellipse cx="32" cy="32" rx="27" ry="9" fill="none" stroke="#a78bfa" strokeOpacity="0.35" strokeWidth="1" />
          <circle r={i === 0 ? 2.6 : 2} fill={i === 1 ? '#f472b6' : '#c4b5fd'} style={{ filter: 'drop-shadow(0 0 3px #e879f9)' }}>
            <animateMotion dur={`${1.6 + i * 0.7}s`} repeatCount="indefinite" path="M5,32 a27,9 0 1,0 54,0 a27,9 0 1,0 -54,0" />
          </circle>
        </g>
      ))}
    </svg>
  );
}

/**
 * The model's real thinking, a few words at a time: the newest words drift up and fade out,
 * so you literally see what it is thinking about.
 */
export function ThoughtWords({ text }: { text: string }) {
  const words = useMemo(() => {
    const all = text.split(/\s+/).filter(Boolean);
    // Key by absolute position so only new words start a fresh animation.
    return all.slice(-6).map((w, i) => ({ w: w.replace(/[*#_`]/g, '').slice(0, 18), key: all.length - 6 + i }));
  }, [text]);
  return (
    <div className="relative h-12 min-w-0 flex-1 overflow-hidden" aria-label="Thinking">
      {words.map(({ w, key }, i) => (
        <span
          key={key}
          className="hm-thought absolute text-[11px] font-medium text-violet-200"
          style={{ left: `${(key * 37) % 70}%`, animationDelay: `${i * 0.05}s` }}
        >
          {w}
        </span>
      ))}
    </div>
  );
}

/** The last words of the answer as it is being written, with a blinking cursor. */
export function WritingTail({ text }: { text: string }) {
  const tail = text.slice(-110).replace(/\s+/g, ' ');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [tail]);
  return (
    <div ref={ref} className="hm-writing max-h-10 overflow-hidden font-mono text-[10.5px] leading-snug text-cyan-100/90">
      {tail}
      <span className="hm-caret text-cyan-300">▍</span>
    </div>
  );
}

/** A GPU chip whose cores light up while the model is loaded into memory. */
export function GpuChip({ pct }: { pct: number }) {
  const lit = Math.round((Math.max(0, Math.min(97, pct)) / 100) * 16);
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9 shrink-0" aria-hidden>
      <rect x="6" y="6" width="28" height="28" rx="4" fill="#1c1917" stroke="#f59e0b" strokeWidth="1.5" />
      {[10, 16, 22, 28].flatMap((y) => [1, 35].map((x) => <rect key={`p${x}-${y}`} x={x} y={y} width="4" height="2" fill="#f59e0b" opacity={0.7} />))}
      {Array.from({ length: 16 }, (_, i) => (
        <rect
          key={i}
          x={10 + (i % 4) * 5.2}
          y={10 + Math.floor(i / 4) * 5.2}
          width="4"
          height="4"
          rx="0.8"
          fill={i < lit ? '#fbbf24' : '#3f3f46'}
          style={i < lit ? { filter: 'drop-shadow(0 0 2px #f59e0b)' } : undefined}
        />
      ))}
    </svg>
  );
}

/** Plays an SVG animation once when mounted (SMIL `begin` is relative to page load otherwise). */
export function useBeginOnMount<T extends SVGAnimationElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.beginElement();
  }, []);
  return ref;
}
