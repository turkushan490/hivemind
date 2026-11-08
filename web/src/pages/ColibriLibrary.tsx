import type { HfFile, HfRepo } from '@hivemind/shared';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useStored } from '../stored';
import type { CatalogModel, Job } from './Colibri';
import { FIT } from './Colibri';
import { hfLink, hfSearchLink, LIBRARY, TAG_STYLE, type LibModel } from './colibriModels';

const gb = (b?: number) => (b === undefined ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : `${Math.round(b / 1e6)} MB`);
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const SIZES = {
  all: { label: 'All sizes', test: () => true },
  small: { label: 'Small < 30 GB', test: (gbs: number) => gbs < 30 },
  medium: { label: 'Medium 30–200 GB', test: (gbs: number) => gbs >= 30 && gbs < 200 },
  giant: { label: 'Giant 200 GB+', test: (gbs: number) => gbs >= 200 },
} as const;
type SizeFilter = keyof typeof SIZES;

/** A model folder name from a repo and a quant: "unsloth/Qwen3.6-35B-A3B-GGUF" + Q4_K_M → qwen3.6-35b-a3b-q4_k_m. */
const folderName = (repo: string, quant: string) =>
  `${repo.split('/')[1].replace(/-?gguf$/i, '')}-${quant}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 80);

/** The files of a quant: one file, or every part of a split one ("x (6 parts)" in the list). */
const filePattern = (f: HfFile) => {
  const m = f.file.match(/^(.*) \((\d+) parts\)$/);
  return m ? `${m[1]}-*-of-${String(Number(m[2])).padStart(5, '0')}.gguf` : f.file;
};

/**
 * Settings → Colibri → Library: every model family colibri runs, like the Ollama library. Ready-made colibri versions
 * download in one click; GGUF files of any of them are found on Hugging Face and imported (read in place).
 */
export function ColibriLibrary(p: {
  catalog: CatalogModel[];
  catError: string;
  engines?: { cpu?: string[]; cuda?: string[] };
  ramBytes: number;
  diskFree?: number;
  running: Job[];
  busy: boolean;
  onDownload: (m: CatalogModel) => void;
  onImport: (body: { repo: string; file: string; name: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [size, setSize] = useStored<SizeFilter>('colibri.size', 'all');
  const [open, setOpen] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LIBRARY.filter((m) => SIZES[size].test(m.minGb)).filter((m) => !q || `${m.name} ${m.about} ${m.tags.join(' ')} ${m.params}`.toLowerCase().includes(q));
  }, [query, size]);

  const hasEngine = (m: LibModel) => !p.engines || [...(p.engines.cpu ?? []), ...(p.engines.cuda ?? [])].includes(m.engine);

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="font-semibold">Colibri library</h3>
        <p className="text-xs text-slate-500">
          Every model colibri can run. <b>Download</b> gets colibri&apos;s ready-made version; <b>GGUF</b> finds GGUF files of it on Hugging Face (any quant, read in place, often
          faster to start answering). <i>fits</i> means the always-loaded part plus a small expert cache fit in colibri&apos;s {gb(p.ramBytes)} of RAM.
        </p>
      </div>
      <input className="input" placeholder="Search, e.g. qwen, vision, code, deepseek…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(SIZES) as SizeFilter[]).map((s) => (
          <button key={s} className={`rounded-full border px-3 py-0.5 text-xs ${size === s ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-[#30363d] text-slate-400'}`} onClick={() => setSize(s)}>
            {SIZES[s].label}
          </button>
        ))}
      </div>
      {p.catError && <p className="text-sm text-red-300">{p.catError}</p>}
      <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
        {shown.map((m) => {
          const cat = m.catalog ? p.catalog.find((c) => c.id === m.catalog) : undefined;
          const fits = cat ? cat.status : m.ramGb * 1e9 > p.ramBytes ? 'needs-ram' : 'good';
          const isOpen = open === m.id;
          return (
            <div key={m.id} className="rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-sm">
              <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(isOpen ? null : m.id)}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-100">{m.name}</span>
                    <span className="text-xs text-slate-500">{m.params}</span>
                    {cat?.installed && <span className="rounded bg-emerald-900/50 px-1.5 text-xs text-emerald-300">installed</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">{m.about}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {m.tags.map((t) => (
                      <span key={t} className={`rounded px-1.5 text-xs ${TAG_STYLE[t]}`}>
                        {t}
                      </span>
                    ))}
                    <span className="rounded bg-[#21262d] px-1.5 text-xs text-slate-300">{m.size}</span>
                    <span className={`rounded px-1.5 text-xs ${FIT[fits].cls}`}>{FIT[fits].label}</span>
                    {m.minGb >= 150 && <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">slow: for overnight</span>}
                    {!hasEngine(m) && <span className="rounded bg-red-900/50 px-1.5 text-xs text-red-300">engine not in this image</span>}
                  </div>
                </div>
                <span className="text-slate-500">{isOpen ? '▲' : '▼'}</span>
              </button>
              {isOpen && (
                <div className="mt-3 space-y-3 border-t border-[#21262d] pt-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <a className="text-indigo-300 hover:underline" href={m.hf.includes('/') ? hfLink(m.hf) : hfSearchLink(m.name)} target="_blank" rel="noreferrer">
                      Hugging Face ↗
                    </a>
                    {m.gguf && (
                      <a className="text-indigo-300 hover:underline" href={hfSearchLink(m.gguf)} target="_blank" rel="noreferrer">
                        GGUF files on Hugging Face ↗
                      </a>
                    )}
                    {m.license && <span className="text-amber-300">Licence: {m.license}</span>}
                  </div>
                  {m.speed && <p className="text-xs text-slate-400">Speed (colibri&apos;s tests): {m.speed}</p>}
                  {cat && (
                    <div className="flex flex-wrap items-center gap-2 rounded border border-[#21262d] p-2 text-xs">
                      <span className="flex-1 text-slate-300">
                        Ready-made colibri version: {cat.download_gb} GB, RAM {cat.ram_min_gb}–{cat.ram_good_gb} GB. <span className="text-slate-500">{cat.reason}</span>
                      </span>
                      {cat.installed ? (
                        <span className="text-emerald-300">installed</span>
                      ) : (
                        <button className="btn" disabled={p.busy || cat.status === 'needs-disk' || p.running.some((j) => j.model === cat.id)} onClick={() => p.onDownload(cat)}>
                          {cat.downloaded_bytes > 0 ? `Go on (${gb(cat.downloaded_bytes)} there)` : 'Download'}
                        </button>
                      )}
                    </div>
                  )}
                  {m.gguf && <GgufPicker model={m} busy={p.busy} diskFree={p.diskFree} onImport={p.onImport} />}
                  {m.convert && (
                    <p className="text-xs text-amber-300">
                      This one only runs after a conversion with PyTorch (colibri&apos;s converter), which HiveMind can&apos;t do inside its container yet. See the Hugging Face page.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <p className="text-sm text-slate-400">Nothing matches. GGUF files of other Qwen3, DeepSeek, GLM, MiMo, Kimi or OLMoE models can be imported below.</p>}
      </div>
    </div>
  );
}

/** GGUF repositories of one model on Hugging Face, then their quants with sizes; a click imports one. */
function GgufPicker({ model, busy, diskFree, onImport }: { model: LibModel; busy: boolean; diskFree?: number; onImport: (b: { repo: string; file: string; name: string }) => void }) {
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [repo, setRepo] = useState('');
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [err, setErr] = useState('');

  const search = async () => {
    setErr('');
    try {
      setRepos((await api<HfRepo[]>(`/api/hf/search?q=${encodeURIComponent(model.gguf!.replace(/\s*GGUF$/i, ''))}`, { quiet: true })).slice(0, 8));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const pick = async (id: string) => {
    setRepo(id);
    setFiles(null);
    try {
      setFiles(await api<HfFile[]>(`/api/hf/files?repo=${encodeURIComponent(id)}`, { quiet: true }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (!repos)
    return (
      <button className="btn" onClick={search}>
        Find GGUF files on Hugging Face
      </button>
    );
  return (
    <div className="space-y-2 text-xs">
      {err && <p className="text-red-300">{err}</p>}
      <div className="text-slate-400">GGUF repositories (most downloaded first):</div>
      <div className="flex flex-wrap gap-1.5">
        {repos.map((r) => (
          <button key={r.id} className={`rounded border px-2 py-1 ${repo === r.id ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100' : 'border-[#30363d] text-slate-300'}`} onClick={() => pick(r.id)}>
            {r.id} <span className="text-slate-500">↓{count(r.downloads)}</span>
          </button>
        ))}
        {repos.length === 0 && <span className="text-slate-500">None found. Try the Hugging Face link above, then the import box below.</span>}
      </div>
      {repo && !files && <p className="text-slate-500">Reading {repo}…</p>}
      {files && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-slate-400">
            Quants in {repo}
            <a className="text-indigo-300 hover:underline" href={hfLink(repo)} target="_blank" rel="noreferrer">
              ↗
            </a>
          </div>
          {files.length === 0 && <p className="text-slate-500">No GGUF files found in it.</p>}
          <div className="flex flex-wrap gap-1.5">
            {files.map((f) => {
              const tooBig = diskFree !== undefined && (f.sizeBytes ?? 0) > diskFree;
              return (
                <button
                  key={f.file}
                  className="rounded border border-[#30363d] px-2 py-1 text-slate-200 hover:border-indigo-400 disabled:opacity-40"
                  disabled={busy || tooBig}
                  title={tooBig ? 'Not enough disk space' : `Download and import ${f.file}`}
                  onClick={() => {
                    const name = folderName(repo, f.quant);
                    if ((f.sizeBytes ?? 0) > 100e9 && !confirm(`${repo} ${f.quant} is ${gb(f.sizeBytes)}. Start the download?`)) return;
                    onImport({ repo, file: filePattern(f), name });
                  }}
                >
                  {f.quant} <span className="text-slate-500">{gb(f.sizeBytes)}</span>
                  {f.quant === 'Q4_K_M' && <span className="ml-1 text-emerald-300">★</span>}
                </button>
              );
            })}
          </div>
          <p className="text-slate-500">Q4_K_M (★) is the usual sweet spot; smaller quants (IQ2, IQ1) fit giant models in less space but lose quality.</p>
        </div>
      )}
    </div>
  );
}
