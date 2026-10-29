import type { Dataset, DatasetItem, DatasetKind } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

/** All your datasets: make one, upload examples (JSONL, CSV, text), add by hand, review and export. */

const KIND_LABEL: Record<DatasetKind, string> = { text: 'Text / chat', image: 'Images', decision: 'Decisions', voice: 'Voice' };
const SOURCE_LABEL: Record<string, string> = { lab: 'Lab', thumbs: '👍', upload: 'upload', generated: 'AI-made', block: 'workflow', manual: 'by hand' };

export function DatasetsPanel() {
  const [list, setList] = useState<Dataset[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [items, setItems] = useState<DatasetItem[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DatasetKind>('text');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const load = () => api<Dataset[]>('/api/datasets', { quiet: true }).then(setList).catch(() => {});
  const loadItems = (id: string) => api<DatasetItem[]>(`/api/datasets/${id}/items?limit=200`, { quiet: true }).then(setItems).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (open) loadItems(open);
  }, [open]);

  const create = async () => {
    if (!name.trim()) return toast('Give the dataset a name', 'info');
    try {
      const d = await api<Dataset>('/api/datasets', { body: { name, kind } });
      setName('');
      await load();
      setOpen(d.id);
    } catch {}
  };
  const upload = async (f: File) => {
    if (!open) return;
    const text = await f.text();
    const format = /\.jsonl?$/i.test(f.name) ? 'jsonl' : /\.csv$/i.test(f.name) ? 'csv' : 'txt';
    try {
      const r = await api<{ added: number }>(`/api/datasets/${open}/items`, { body: { text, format } });
      toast(`Added ${r.added} examples from ${f.name}`, 'ok');
      load();
      loadItems(open);
    } catch {}
  };
  const addOne = async () => {
    if (!open || !output.trim()) return toast('Write at least the answer', 'info');
    try {
      await api(`/api/datasets/${open}/items`, { body: { items: [{ input, output }] } });
      setInput('');
      setOutput('');
      load();
      loadItems(open);
    } catch {}
  };
  const review = async (it: DatasetItem, r: 'accepted' | 'rejected') => {
    await api(`/api/datasets/items/${it.id}`, { method: 'PATCH', body: { review: r } }).catch(() => {});
    load();
    if (open) loadItems(open);
  };
  const remove = async (it: DatasetItem) => {
    await api(`/api/datasets/items/${it.id}`, { method: 'DELETE' }).catch(() => {});
    load();
    if (open) loadItems(open);
  };
  const drop = async (d: Dataset) => {
    if (!confirm(`Delete the dataset "${d.name}" with its ${d.items + d.pending} examples?`)) return;
    await api(`/api/datasets/${d.id}`, { method: 'DELETE' }).catch(() => {});
    setOpen(null);
    load();
  };

  const current = list.find((d) => d.id === open);
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">Datasets</h3>
        <span className="text-xs text-slate-400">Training examples for any model: from the Lab, 👍 on answers, uploads, and workflow blocks.</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {list.map((d) => (
          <button
            key={d.id}
            onClick={() => setOpen(open === d.id ? null : d.id)}
            className={`rounded-lg border px-3 py-1.5 text-left text-sm ${open === d.id ? 'border-indigo-500 bg-indigo-500/15' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
          >
            <div className="font-medium">{d.name}</div>
            <div className="text-[11px] text-slate-400">
              {KIND_LABEL[d.kind]} · {d.items} examples{d.pending ? ` · ${d.pending} to review` : ''}
            </div>
          </button>
        ))}
        <div className="flex items-center gap-1 rounded-lg border border-dashed border-[#30363d] px-2 py-1">
          <input className="input w-40 py-1 text-xs" placeholder="New dataset name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <select className="input w-auto py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value as DatasetKind)}>
            {(Object.keys(KIND_LABEL) as DatasetKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={create}>
            + Make
          </button>
        </div>
      </div>

      {current && (
        <div className="space-y-2 rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-sm font-semibold">{current.name}</span>
            <span className="text-slate-500">{KIND_LABEL[current.kind]}</span>
            <span className="ml-auto flex gap-3">
              <input ref={file} type="file" accept=".jsonl,.json,.csv,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <button className="text-indigo-300 hover:text-indigo-200" onClick={() => file.current?.click()}>
                ⬆ Upload JSONL / CSV / text
              </button>
              <a className="text-indigo-300 hover:text-indigo-200" href={`/api/datasets/${current.id}/export.jsonl`}>
                ⬇ Export JSONL
              </a>
              <button className="text-slate-500 hover:text-red-400" onClick={() => drop(current)}>
                Delete
              </button>
            </span>
          </div>
          {current.kind === 'text' && (
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
              <textarea className="input min-h-14 text-xs" placeholder="Question / input (optional)" value={input} onChange={(e) => setInput(e.target.value)} />
              <textarea className="input min-h-14 text-xs" placeholder="The answer the model should learn" value={output} onChange={(e) => setOutput(e.target.value)} />
              <button className="btn-ghost self-start px-3 py-1 text-xs" onClick={addOne}>
                + Add
              </button>
            </div>
          )}
          {current.kind !== 'text' && <p className="text-xs text-amber-300/90">Training {KIND_LABEL[current.kind].toLowerCase()} models comes in a later update; you can already collect examples.</p>}
          <div className="max-h-[28rem] space-y-1.5 overflow-auto">
            {items.length === 0 && <p className="text-xs text-slate-500">No examples yet.</p>}
            {items.map((it) => (
              <div key={it.id} className={`rounded-md border p-2 text-xs ${it.review === 'pending' ? 'border-amber-700/60' : it.review === 'rejected' ? 'border-red-900/60 opacity-60' : 'border-[#30363d]'}`}>
                <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <span>#{it.id}</span>
                  <span>{SOURCE_LABEL[it.source] ?? it.source}</span>
                  {it.review && <span className={it.review === 'pending' ? 'text-amber-300' : it.review === 'rejected' ? 'text-red-300' : 'text-emerald-300'}>{it.review}</span>}
                  <span className="ml-auto flex gap-2">
                    {it.review === 'pending' && (
                      <>
                        <button className="text-emerald-300" onClick={() => review(it, 'accepted')}>
                          ✓ keep
                        </button>
                        <button className="text-red-300" onClick={() => review(it, 'rejected')}>
                          ✕ reject
                        </button>
                      </>
                    )}
                    <button className="hover:text-red-400" onClick={() => remove(it)}>
                      delete
                    </button>
                  </span>
                </div>
                {it.input && <div className="mb-1 line-clamp-3 whitespace-pre-wrap text-slate-400">{it.input}</div>}
                <div className="line-clamp-4 whitespace-pre-wrap text-slate-200">{it.output}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
