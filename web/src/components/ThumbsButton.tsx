import type { Dataset } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';

/** 👍 on an answer: its question and answer become a training example in a dataset you pick. */
export function ThumbsButton({ runId, className = '' }: { runId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [list, setList] = useState<Dataset[]>([]);
  const [last, setLast] = useStored('thumbs.dataset', 'My good answers');
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setDone(false), [runId]);
  useEffect(() => {
    if (!open) return;
    api<Dataset[]>('/api/datasets', { quiet: true })
      .then((l) => setList(l.filter((d) => d.kind === 'text')))
      .catch(() => {});
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const keep = async (dataset: string) => {
    if (!dataset.trim()) return;
    try {
      const r = await api<{ dataset: Dataset }>(`/api/runs/${runId}/thumbs`, { body: { dataset } });
      setLast(dataset);
      setDone(true);
      setOpen(false);
      toast(`👍 Kept in "${r.dataset.name}" (${r.dataset.items} examples)`, 'ok');
    } catch {}
  };

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        className={`rounded px-1.5 py-0.5 text-xs ${done ? 'bg-emerald-500/20 text-emerald-300' : 'text-slate-400 hover:bg-[#21262d] hover:text-white'}`}
        title="Good answer: keep it as a training example"
        onClick={() => (done ? setOpen(!open) : keep(last))}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        👍{done ? ' kept' : ''}
      </button>
      <button className="px-0.5 text-[10px] text-slate-500 hover:text-white" title="Pick the dataset" onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 space-y-1 rounded-lg border border-[#30363d] bg-[#161b22] p-2 text-xs shadow-xl">
          <div className="text-[11px] text-slate-500">Keep this answer in…</div>
          {list.map((d) => (
            <button key={d.id} className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-[#21262d] ${d.name === last ? 'text-indigo-200' : ''}`} onClick={() => keep(d.name)}>
              {d.name} <span className="text-slate-500">· {d.items}</span>
            </button>
          ))}
          <div className="flex gap-1">
            <input className="input py-1 text-xs" placeholder="New dataset" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && keep(name)} />
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => keep(name)}>
              +
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
