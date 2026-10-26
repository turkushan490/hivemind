import { SEARCH_SOURCES, type ModelInfo, type ModelRef, type NodeConfig, type NodeType, type ProviderInfo } from '@hivemind/shared';
import { useState } from 'react';
import { toast } from '../notify';
import { ModelPicker } from './ModelPicker';

interface Props {
  nodeId: string;
  kind: NodeType;
  config: NodeConfig;
  models: ModelInfo[];
  providers: ProviderInfo[];
  onChange: (patch: Partial<NodeConfig>) => void;
}

const Label = ({ children }: { children: React.ReactNode }) => <div className="text-xs font-semibold text-slate-300">{children}</div>;

/** The settings each kind of block has, beyond its name and single model. */
export function BlockSettings(p: Props) {
  switch (p.kind) {
    case 'router':
      return (
        <p className="rounded-md bg-orange-950/30 p-2 text-xs text-orange-200/90">
          Wire the Router to two or more blocks and give each a clear name — the model picks one by its name. The other branches are skipped.
        </p>
      );
    case 'debate':
      return (
        <div className="space-y-3">
          <ModelList {...p} title="Debaters" min={2} />
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Rounds: {p.config.rounds ?? 2}</span>
            <input type="range" className="w-full" min={1} max={4} value={p.config.rounds ?? 2} onChange={(e) => p.onChange({ rounds: Number(e.target.value) })} />
          </label>
        </div>
      );
    case 'vote':
      return <ModelList {...p} title="Voters" min={1} />;
    case 'template':
      return (
        <label className="block space-y-1">
          <Label>Text</Label>
          <textarea
            className="input min-h-28 text-xs"
            placeholder={'e.g. Answer as a friendly chef. Question: {{question}}'}
            value={p.config.prompt ?? ''}
            onChange={(e) => p.onChange({ prompt: e.target.value || undefined })}
          />
          <span className="text-xs text-slate-500">
            <code>{'{{question}}'}</code> = the question, <code>{'{{inputs}}'}</code> = what is wired into this block.
          </span>
        </label>
      );
    case 'file':
      return <FileLoader {...p} />;
    case 'search':
      return (
        <div className="space-y-2">
          <label className="block space-y-1">
            <Label>Search with</Label>
            <select className="input" value={p.config.source ?? ''} onChange={(e) => p.onChange({ source: (e.target.value || undefined) as NodeConfig['source'] })}>
              <option value="">Default (Settings → Web search)</option>
              {SEARCH_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s === 'wikipedia' ? 'Wikipedia (free)' : s === 'searxng' ? 'SearXNG (self-hosted)' : `${s[0].toUpperCase()}${s.slice(1)} (API key)`}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Results: {p.config.count ?? 5}</span>
            <input type="range" className="w-full" min={1} max={10} value={p.config.count ?? 5} onChange={(e) => p.onChange({ count: Number(e.target.value) })} />
          </label>
          <p className="text-xs text-slate-500">Searches for the question, or for the text of the block wired before it (e.g. a model that turns the question into search words).</p>
        </div>
      );
    case 'memory':
      return (
        <div className="space-y-2">
          <label className="block space-y-1">
            <Label>Memory name</Label>
            <input className="input" placeholder="default" value={p.config.key ?? ''} onChange={(e) => p.onChange({ key: e.target.value || undefined })} />
          </label>
          <div className="flex gap-1">
            {(['recall', 'save'] as const).map((m) => (
              <button
                key={m}
                className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${(p.config.mode ?? 'recall') === m ? 'border-lime-500 bg-lime-500/15 text-lime-200' : 'border-[#30363d] text-slate-400'}`}
                onClick={() => p.onChange({ mode: m })}
              >
                {m === 'recall' ? 'Recall' : 'Save'}
              </button>
            ))}
          </div>
          {(p.config.mode ?? 'recall') === 'recall' ? (
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Bring back the last {p.config.limit ?? 5}</span>
              <input type="range" className="w-full" min={1} max={20} value={p.config.limit ?? 5} onChange={(e) => p.onChange({ limit: Number(e.target.value) })} />
            </label>
          ) : (
            <p className="text-xs text-slate-500">Saves the question and what is wired into this block, then passes it on. A Recall block with the same name brings it back next time.</p>
          )}
        </div>
      );
    default:
      return null;
  }
}

/** A list of models for Debate / Vote: remove any, add more. */
function ModelList(p: Props & { title: string; min: number }) {
  const list = p.config.models ?? [];
  const [adding, setAdding] = useState(list.length < p.min);
  const set = (models: ModelRef[]) => p.onChange({ models });
  return (
    <div className="space-y-1.5">
      <Label>
        {p.title} <span className="font-normal text-slate-500">(at least {p.min})</span>
      </Label>
      {list.map((m, i) => (
        <div key={`${m.providerId}|${m.model}|${i}`} className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate" title={m.model}>
            {m.model}
          </span>
          <button className="text-slate-500 hover:text-red-400" aria-label="Remove model" onClick={() => set(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      {adding ? (
        <ModelPicker
          key={`${p.nodeId}-${list.length}`}
          models={p.models}
          providers={p.providers}
          onChange={(m) => {
            set([...list, m]);
            setAdding(list.length + 1 < p.min);
          }}
        />
      ) : (
        <button className="btn-ghost w-full" onClick={() => setAdding(true)}>
          + Add a model
        </button>
      )}
    </div>
  );
}

const MAX_CHARS = 200_000;

/** Reads a text or PDF file in the browser and keeps its text in the block. */
function FileLoader(p: Props) {
  const [busy, setBusy] = useState(false);
  const load = async (file: File) => {
    setBusy(true);
    try {
      let text: string;
      if (file.name.toLowerCase().endsWith('.pdf')) {
        // Loaded only when needed: the PDF reader is big.
        const pdfjs = await import('pdfjs-dist');
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const content = await (await doc.getPage(i)).getTextContent();
          pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
        }
        text = pages.join('\n\n');
      } else {
        text = await file.text();
      }
      text = text.replace(/\u0000/g, '').trim();
      if (!text) throw new Error('No text found in this file (a scanned PDF has only images)');
      if (text.length > MAX_CHARS) {
        toast(`Only the first ${MAX_CHARS / 1000}k characters of ${file.name} are used`, 'info');
        text = text.slice(0, MAX_CHARS);
      }
      p.onChange({ text, fileName: file.name });
    } catch (err) {
      toast(`Could not read ${file.name}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-[#30363d] px-3 py-4 text-sm text-slate-300 hover:border-teal-500">
        <input type="file" className="hidden" accept=".txt,.md,.csv,.json,.log,.xml,.html,.pdf,text/*,application/pdf" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
        {busy ? 'Reading…' : p.config.fileName ? `Replace ${p.config.fileName}` : 'Choose a file (txt, md, csv, json, PDF)'}
      </label>
      {p.config.text && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-400">
            {p.config.fileName} · {p.config.text.length.toLocaleString()} characters
          </summary>
          <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-slate-400">{p.config.text.slice(0, 3000)}</pre>
        </details>
      )}
    </div>
  );
}
