import type { Dataset, DatasetItem, DatasetKind, DecisionSpec, ModelInfo, ProviderInfo } from '@hivemind/shared';
import { parseDecisionSpec } from '@hivemind/shared';
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
          {current.kind === 'decision' && (
            <>
              <DecisionQuestion key={current.id} dataset={current} onSaved={load} />
              <div className="grid gap-2 md:grid-cols-[1fr_12rem_auto]">
                <textarea className="input min-h-14 text-xs" placeholder="State: the text the model reads" value={input} onChange={(e) => setInput(e.target.value)} />
                <input className="input self-start text-xs" placeholder="Right answer (option key)" value={output} onChange={(e) => setOutput(e.target.value)} />
                <button className="btn-ghost self-start px-3 py-1 text-xs" onClick={addOne}>
                  + Add
                </button>
              </div>
              <p className="text-[11px] text-slate-500">
                Upload JSONL lines like <code>{'{"state": "…", "answer": "bug"}'}</code>; a line may bring its own <code>question</code>, <code>type</code> and <code>options</code>.
              </p>
            </>
          )}
          {current.kind === 'image' && <Pictures key={current.id} dataset={current} onChanged={() => (load(), loadItems(current.id))} />}
          {current.kind === 'voice' && <p className="text-xs text-amber-300/90">Training voices comes in a later update; you can already collect examples.</p>}
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
                {it.files?.[0] && /\.(png|jpe?g|webp)$/i.test(it.files[0]) && (
                  <img className="float-left mr-2 h-14 w-14 rounded object-cover" loading="lazy" src={`/api/files/raw?inline=1&path=${encodeURIComponent(it.files[0])}`} alt="" />
                )}
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

const NL = String.fromCharCode(10);

/** The question a decision dataset teaches: the text, its kind, and the options (one per line, "key: description"). */
function DecisionQuestion({ dataset, onSaved }: { dataset: Dataset; onSaved: () => void }) {
  const spec = parseDecisionSpec(dataset.system);
  const [question, setQuestion] = useState(spec?.question ?? '');
  const [type, setType] = useState<DecisionSpec['type']>(spec?.type ?? 'choice');
  const [options, setOptions] = useState(
    !spec?.options ? '' : Array.isArray(spec.options) ? spec.options.join(NL) : Object.entries(spec.options).map(([k, d]) => (d ? `${k}: ${d}` : k)).join(NL),
  );
  const save = async () => {
    if (!question.trim()) return toast('Write the question the model answers', 'info');
    const lines = options.split(NL).map((l) => l.trim()).filter(Boolean);
    if (type !== 'noul' && lines.length < 2) return toast('Give at least two options, one per line', 'info');
    const next: DecisionSpec = {
      question: question.trim(),
      type,
      ...(type === 'choice' && { options: Object.fromEntries(lines.map((l) => [l.split(':')[0].trim(), l.includes(':') ? l.slice(l.indexOf(':') + 1).trim() : ''])) }),
      ...(type === 'score' && { options: lines }),
    };
    try {
      await api(`/api/datasets/${dataset.id}`, { method: 'PATCH', body: { system: JSON.stringify(next) } });
      toast('Question saved', 'ok');
      onSaved();
    } catch {}
  };

  return (
    <div className="space-y-1.5 rounded-md border border-[#30363d] p-2 text-xs">
      <div className="flex flex-wrap gap-2">
        <input className="input flex-1 text-xs" placeholder="Question, e.g. Which label fits this ticket?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <select className="input w-auto text-xs" value={type} onChange={(e) => setType(e.target.value as DecisionSpec['type'])}>
          <option value="choice">Choice</option>
          <option value="noul">Yes / no (answers true / false)</option>
          <option value="score">Score (levels low → high)</option>
        </select>
        <button className="btn-ghost px-3 py-1 text-xs" onClick={save}>
          Save question
        </button>
      </div>
      {type !== 'noul' && (
        <textarea
          className="input min-h-16 text-xs"
          placeholder={type === 'choice' ? ['One option per line, "key: description"', 'bug: Software errors', 'billing: Payments'].join(NL) : ['One level per line, lowest first', 'bad', 'okay', 'great'].join(NL)}
          value={options}
          onChange={(e) => setOptions(e.target.value)}
        />
      )}
      <p className="text-slate-500">Answers are option keys{type === 'noul' ? ' (true / false, or yes / no)' : type === 'score' ? ' (a level, or its number from 0)' : ''}.</p>
    </div>
  );
}

/** Image datasets: pictures from a Files folder, captioned by hand (a .txt beside each picture) or by a vision model in Ollama. */
function Pictures({ dataset, onChanged }: { dataset: Dataset; onChanged: () => void }) {
  const [folder, setFolder] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('');
  const [captioning, setCaptioning] = useState<string | null>(null);
  const stop = useRef(false);
  useEffect(() => {
    Promise.all([api<{ models: ModelInfo[] }>('/api/models', { quiet: true }), api<ProviderInfo[]>('/api/providers', { quiet: true })])
      .then(([m, p]) => {
        const ollama = new Set(p.filter((x) => x.kind === 'ollama' && x.enabled).map((x) => x.id));
        const list = m.models.filter((x) => ollama.has(x.providerId) && !x.kind);
        setModels(list);
        // Models that can see pictures, when one is there: gemma4, qwen3.5 / qwen-vl, llava, minicpm-v.
        const seeing = list.find((x) => /gemma[34]|qwen3\.5|qwen.*vl|llava|minicpm-v|vision/i.test(x.model));
        setModel((v) => v || `${(seeing ?? list[0])?.providerId ?? ''}|${(seeing ?? list[0])?.model ?? ''}`);
      })
      .catch(() => {});
  }, []);

  const add = async () => {
    if (!folder.trim()) return toast('Type the folder in Files that holds the pictures', 'info');
    try {
      const r = await api<{ added: number }>(`/api/datasets/${dataset.id}/pictures`, { body: { folder: folder.trim() } });
      toast(`Added ${r.added} pictures`, 'ok');
      onChanged();
    } catch {}
  };
  const caption = async () => {
    const [providerId, name] = model.split('|');
    if (!name) return toast('Pick a model that can see pictures', 'info');
    stop.current = false;
    setCaptioning('Starting…');
    try {
      for (let total = 0; !stop.current; ) {
        const r = await api<{ captioned: number; left: number }>(`/api/datasets/${dataset.id}/caption`, { body: { providerId, model: name } });
        total += r.captioned;
        setCaptioning(`${total} captioned, ${r.left} to go`);
        onChanged();
        if (!r.left || !r.captioned) break;
      }
    } catch {
    } finally {
      setCaptioning(null);
    }
  };

  return (
    <div className="space-y-1.5 rounded-md border border-[#30363d] p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-56 py-1 text-xs" placeholder="Folder in Files, e.g. lora/my-face" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <button className="btn-ghost px-3 py-1 text-xs" onClick={add}>
          + Add pictures
        </button>
        <span className="text-slate-500">10–30 sharp pictures of one person, style or thing. A .txt with the same name is its caption.</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-64 py-1 text-xs" value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={`${m.providerId}|${m.model}`} value={`${m.providerId}|${m.model}`}>
              {m.name}
            </option>
          ))}
        </select>
        {captioning ? (
          <button className="btn-ghost px-3 py-1 text-xs" onClick={() => (stop.current = true)}>
            ■ Stop ({captioning})
          </button>
        ) : (
          <button className="btn-ghost px-3 py-1 text-xs" onClick={caption}>
            ✎ Caption the rest with AI
          </button>
        )}
        <span className="text-slate-500">Needs a model that can see pictures (gemma4, qwen3.5…).</span>
      </div>
    </div>
  );
}
