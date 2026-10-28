import type { HfFile, HfRepo, ModelInfo, OllamaLibraryModel, OllamaPick, OllamaTag, ProviderInfo, PullJob } from '@hivemind/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';

const size = (b?: number) => (b === undefined ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Rough Q4 download size from a parameter size like "8b" (exact sizes come from the tags list). */
function estimate(sizeTag: string): number | undefined {
  const m = sizeTag.toLowerCase().match(/^(?:(\d+)x)?e?(\d+(?:\.\d+)?)([bm])$/);
  if (!m) return;
  const params = Number(m[2]) * (m[3] === 'b' ? 1e9 : 1e6) * (m[1] ? Number(m[1]) : 1);
  return params * 0.6 + 0.3e9;
}

type Fit = 'fits' | 'slow' | 'big';
const FIT: Record<Fit, { label: string; cls: string }> = {
  fits: { label: 'fits your GPU', cls: 'bg-emerald-900/50 text-emerald-300' },
  slow: { label: 'slow: part on CPU', cls: 'bg-amber-900/50 text-amber-300' },
  big: { label: 'too big', cls: 'bg-red-900/50 text-red-300' },
};
/** A model needs its file size plus some room for context in VRAM. */
const fitOf = (bytes: number | undefined, vramGb: number): Fit | undefined =>
  bytes === undefined ? undefined : bytes <= vramGb * 0.85e9 ? 'fits' : bytes <= vramGb * 2e9 ? 'slow' : 'big';

function FitBadge({ bytes, vram }: { bytes?: number; vram: number }) {
  const f = fitOf(bytes, vram);
  return f ? <span className={`rounded px-1.5 text-xs whitespace-nowrap ${FIT[f].cls}`}>{FIT[f].label}</span> : null;
}

const SIZE_FILTERS = {
  all: { label: 'All sizes', test: () => true },
  small: { label: 'Small < 3 GB', test: (b: number) => b < 3e9 },
  medium: { label: 'Medium 3–8 GB', test: (b: number) => b >= 3e9 && b < 8e9 },
  large: { label: 'Large 8 GB+', test: (b: number) => b >= 8e9 },
} as const;
type SizeFilter = keyof typeof SIZE_FILTERS;

/** Download models into Ollama from the Ollama library or Hugging Face, and delete them. */
export function Models({ active }: { active: boolean }) {
  const [hosts, setHosts] = useState<ProviderInfo[]>([]);
  const [hostId, setHostId] = useStored('models.host', '');
  const [vram, setVram] = useStored('models.vramGb', 16);
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const [jobs, setJobs] = useState<PullJob[]>([]);

  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];

  const loadInstalled = async () => {
    if (!host) return;
    setInstalled(await api<ModelInfo[]>(`/api/providers/${host.id}/models?fresh=1`, { quiet: true }).catch(() => []));
  };

  useEffect(() => {
    if (!active) return;
    api<ProviderInfo[]>('/api/providers').then((l) => setHosts(l.filter((p) => p.local && p.enabled)));
  }, [active]);

  useEffect(() => {
    loadInstalled();
  }, [host?.id, active]);

  // Poll downloads fast while one runs; refresh the installed list whenever one finishes (even a very fast one).
  useEffect(() => {
    if (!active) return;
    let finished: Set<string> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const list = await api<PullJob[]>('/api/ollama/pulls', { quiet: true }).catch(() => [] as PullJob[]);
      setJobs(list);
      const done = list.filter((j) => j.state === 'done').map((j) => j.id);
      if (finished && done.some((id) => !finished!.has(id))) loadInstalled();
      finished = new Set(done);
      const running = list.filter((j) => j.state === 'running').length;
      timer = setTimeout(tick, running ? 1000 : 3000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, host?.id]);

  const isInstalled = (name: string) => installed.some((m) => m.model === name || m.model === `${name}:latest`);

  const download = async (model: string, bytes?: number) => {
    if (!host) return;
    if (bytes && fitOf(bytes, vram) === 'big' && !confirm(`${model} is ${size(bytes)} — much bigger than your ${vram} GB GPU. It will be very slow or fail. Download anyway?`)) return;
    try {
      await api(`/api/ollama/${host.id}/pull`, { body: { model } });
      toast(`Downloading ${model}…`, 'info');
      setJobs(await api<PullJob[]>('/api/ollama/pulls'));
    } catch {}
  };

  if (hosts.length === 0)
    return <div className="card text-sm text-slate-400">No Ollama connected. Add one under AI providers first.</div>;

  const hostJobs = jobs.filter((j) => j.providerId === host?.id);
  const ctx = { vram, download, isInstalled };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {hosts.length > 1 && (
          <label className="flex items-center gap-2">
            Download to
            <select className="input w-auto" value={host?.id} onChange={(e) => setHostId(e.target.value)}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} — {h.baseUrl}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2">
          GPU memory of this Ollama server
          <input className="input w-20 py-1" type="number" min={0} max={512} value={vram} onChange={(e) => setVram(Math.max(0, Number(e.target.value) || 0))} />
          GB
        </label>
        <span className="text-xs text-slate-500">Used to tell what fits (e.g. Tesla T4 or RTX 4080: 16 GB, RTX 4090: 24 GB).</span>
      </div>

      {hostJobs.length > 0 && (
        <div className="card space-y-3">
          <h2 className="font-semibold">Downloads</h2>
          {hostJobs.map((j) => {
            const pct = j.state === 'done' ? 100 : j.totalBytes ? Math.min(100, ((j.doneBytes ?? 0) / j.totalBytes) * 100) : 0;
            return (
              <div key={j.id} className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{j.model}</span>
                  <span className={`text-xs ${j.state === 'error' ? 'text-red-400' : j.state === 'done' ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {j.state === 'running' ? `${j.status}${j.totalBytes ? ` · ${size(j.doneBytes)} / ${size(j.totalBytes)}` : ''}` : j.state === 'error' ? 'failed' : j.state}
                  </span>
                  {j.state === 'running' && (
                    <button className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => api(`/api/ollama/pulls/${j.id}/cancel`, { method: 'POST' })}>
                      Cancel
                    </button>
                  )}
                </div>
                <div className="h-2 overflow-hidden rounded bg-[#21262d]">
                  <div
                    className={`h-full rounded transition-all ${j.state === 'error' ? 'bg-red-500' : j.state === 'done' ? 'bg-emerald-500' : 'bg-gradient-to-r from-indigo-500 to-cyan-400'}`}
                    style={{ width: `${j.state === 'error' ? 100 : pct}%` }}
                  />
                </div>
                {j.error && <p className="text-xs break-words text-red-400">{j.error}</p>}
              </div>
            );
          })}
        </div>
      )}

      <Recommended active={active} {...ctx} />

      <div className="grid gap-4 lg:grid-cols-2">
        <OllamaLibrary active={active} {...ctx} />
        <HuggingFace {...ctx} />
      </div>

      <div className="card space-y-2">
        <div className="flex items-center">
          <h2 className="font-semibold">Installed on {host?.name}</h2>
          <span className="ml-2 text-sm text-slate-400">
            {installed.length} models · {size(installed.reduce((s, m) => s + (m.sizeBytes ?? 0), 0))}
          </span>
          <button className="btn-ghost ml-auto" onClick={loadInstalled}>
            Refresh
          </button>
        </div>
        {installed.map((m) => (
          <div key={m.model} className="flex items-center gap-3 border-t border-[#30363d] pt-2 text-sm">
            <span className="min-w-0 flex-1 truncate" title={m.model}>
              {m.model}
            </span>
            {m.quant && <span className="text-xs text-slate-500">{m.quant}</span>}
            {/* Cloud models are only a few KB locally; no GPU label for those. */}
            {(m.sizeBytes ?? 0) > 50e6 ? <FitBadge bytes={m.sizeBytes} vram={vram} /> : null}
            <span className="w-16 text-right text-xs text-slate-400">{size(m.sizeBytes)}</span>
            <button
              className="btn-ghost px-2 py-0.5 text-xs text-red-400"
              onClick={async () => {
                if (!confirm(`Delete ${m.model} from ${host?.name}? This frees ${size(m.sizeBytes)} of disk.`)) return;
                try {
                  await api(`/api/ollama/${host!.id}/models?model=${encodeURIComponent(m.model)}`, { method: 'DELETE' });
                  toast(`Deleted ${m.model}`, 'ok');
                  loadInstalled();
                } catch {}
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Ctx {
  vram: number;
  download: (model: string, bytes?: number) => void;
  isInstalled: (name: string) => boolean;
}

function DownloadButton({ name, bytes, ctx }: { name: string; bytes?: number; ctx: Ctx }) {
  return ctx.isInstalled(name) ? (
    <span className="px-2 text-xs text-emerald-400">installed</span>
  ) : (
    <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => ctx.download(name, bytes)}>
      Download
    </button>
  );
}

function Caps({ caps }: { caps: string[] }) {
  return (
    <>
      {caps.map((c) => (
        <span key={c} className="rounded bg-indigo-950 px-1.5 text-xs text-indigo-300">
          {c}
        </span>
      ))}
    </>
  );
}

/** The most popular library models that fit this GPU, in three size groups. */
function Recommended({ active, ...ctx }: Ctx & { active: boolean }) {
  const [picks, setPicks] = useState<OllamaPick[] | null>(null);
  useEffect(() => {
    if (active && !picks) api<OllamaPick[]>('/api/ollama/picks', { quiet: true }).then(setPicks).catch(() => setPicks([]));
  }, [active]);

  const groups = useMemo(() => {
    if (!picks) return [];
    const fits = picks.filter((p) => fitOf(p.estBytes, ctx.vram) === 'fits');
    // Most downloaded first, one size per model family per group.
    const top = (list: OllamaPick[]) => {
      const seen = new Set<string>();
      return [...list]
        .sort((a, b) => b.score - a.score)
        .filter((p) => !seen.has(p.name) && seen.add(p.name))
        .slice(0, 6)
        .sort((a, b) => a.estBytes - b.estBytes);
    };
    return [
      { title: 'Small', hint: 'fast, fine as helper / builder', list: top(fits.filter((p) => p.estBytes < 3e9)) },
      { title: 'Medium', hint: 'good all-rounders', list: top(fits.filter((p) => p.estBytes >= 3e9 && p.estBytes < 8e9)) },
      { title: 'Large', hint: 'smartest that still fits', list: top(fits.filter((p) => p.estBytes >= 8e9)) },
    ];
  }, [picks, ctx.vram]);

  return (
    <div className="card space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="font-semibold">Recommended for a {ctx.vram} GB GPU</h2>
        <span className="text-xs text-slate-400">popular and recent on ollama.com, small to big · sizes are estimates</span>
      </div>
      {!picks && <p className="text-sm text-slate-400">Loading from ollama.com…</p>}
      {picks?.length === 0 && <p className="text-sm text-red-400">Could not reach ollama.com.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {groups.map((g) => (
          <div key={g.title} className="space-y-1.5">
            <div className="text-sm">
              <span className="font-semibold">{g.title}</span> <span className="text-xs text-slate-500">{g.hint}</span>
            </div>
            {g.list.length === 0 && <p className="text-xs text-slate-500">Nothing in this size fits.</p>}
            {g.list.map((p) => (
              <div key={p.pullName} className="flex items-center gap-2 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-sm" title={p.description}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <code className="truncate text-slate-100">{p.pullName}</code>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
                    ~{size(p.estBytes)} · ↓ {count(p.downloads)} <Caps caps={p.capabilities.filter((c) => c !== 'cloud')} />
                  </div>
                </div>
                <DownloadButton name={p.pullName} bytes={p.estBytes} ctx={ctx} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Live search of ollama.com's library; open a model to see every version with its exact size. */
function OllamaLibrary({ active, ...ctx }: Ctx & { active: boolean }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useStored<SizeFilter>('models.sizeFilter', 'all');
  const [results, setResults] = useState<OllamaLibraryModel[] | null>(null);
  const [open, setOpen] = useState('');
  const [tags, setTags] = useState<OllamaTag[] | null>(null);
  const [exact, setExact] = useState('');

  // Search as you type (debounced); empty = most popular.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      api<OllamaLibraryModel[]>(`/api/ollama/library?q=${encodeURIComponent(q.trim())}`, { quiet: true })
        .then(setResults)
        .catch(() => setResults([]));
    }, 350);
    return () => clearTimeout(t);
  }, [q, active]);

  const openModel = async (name: string) => {
    if (open === name) return setOpen('');
    setOpen(name);
    setTags(null);
    setTags(await api<OllamaTag[]>(`/api/ollama/library/${encodeURIComponent(name)}/tags`).catch(() => []));
  };

  const test = SIZE_FILTERS[filter].test;
  const shown = (results ?? [])
    .filter((m) => !m.cloudOnly)
    .map((m) => ({ ...m, sizes: m.sizes.filter((s) => filter === 'all' || test(estimate(s) ?? 0)) }))
    .filter((m) => filter === 'all' || m.sizes.length > 0);

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Ollama library</h2>
      <input className="input" placeholder="Search ollama.com, e.g. qwen, llama, coder, vision…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="flex flex-wrap gap-1">
        {(Object.keys(SIZE_FILTERS) as SizeFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === f ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200' : 'border-[#30363d] text-slate-400'}`}
          >
            {SIZE_FILTERS[f].label}
          </button>
        ))}
      </div>
      {!results && <p className="text-xs text-slate-400">Loading…</p>}
      {results && shown.length === 0 && <p className="text-xs text-slate-400">No models found{filter !== 'all' ? ' in this size' : ''}.</p>}
      <div className="max-h-[32rem] space-y-1 overflow-y-auto pr-1">
        {shown.map((m) => (
          <div key={m.name} className="rounded-md border border-[#30363d]">
            <button className="w-full space-y-1 px-2 py-1.5 text-left hover:bg-[#21262d]" onClick={() => openModel(m.name)}>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{m.name}</span>
                <span className="text-xs text-slate-500">↓ {count(m.downloads)}</span>
                <span className="ml-auto text-xs text-slate-500">{open === m.name ? '▲' : '▼'}</span>
              </div>
              <p className="line-clamp-2 text-xs text-slate-400">{m.description}</p>
              <div className="flex flex-wrap gap-1">
                <Caps caps={m.capabilities} />
                {m.sizes.map((s) => {
                  const f = fitOf(estimate(s), ctx.vram);
                  return (
                    <span key={s} className={`rounded px-1.5 text-xs ${f ? FIT[f].cls : 'bg-slate-800 text-slate-300'}`}>
                      {s}
                    </span>
                  );
                })}
              </div>
            </button>
            {open === m.name && (
              <div className="max-h-64 space-y-1 overflow-y-auto border-t border-[#30363d] px-2 py-2">
                {tags === null && <p className="text-xs text-slate-400">Loading versions…</p>}
                {tags?.length === 0 && <p className="text-xs text-slate-400">No downloadable versions (cloud only?).</p>}
                {tags
                  ?.filter((t) => filter === 'all' || test(t.sizeBytes))
                  .map((t) => (
                    <div key={t.tag} className="flex items-center gap-2 border-b border-[#21262d] pb-1 text-sm last:border-0">
                      <div className="min-w-0 flex-1">
                        <code className="block truncate text-slate-200" title={t.tag}>
                          {t.tag}
                        </code>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                          <span className="text-slate-400">{size(t.sizeBytes)}</span>
                          <FitBadge bytes={t.sizeBytes} vram={ctx.vram} />
                          {t.context && <span>{t.context} context</span>}
                          {t.input && t.input !== 'Text' && <span>{t.input} input</span>}
                        </div>
                      </div>
                      <DownloadButton name={t.tag} bytes={t.sizeBytes} ctx={ctx} />
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-[#30363d] pt-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (exact.trim()) ctx.download(exact.trim());
          setExact('');
        }}
      >
        <input className="input py-1" placeholder="Or type an exact name, e.g. qwen3:8b" value={exact} onChange={(e) => setExact(e.target.value)} />
        <button className="btn-ghost" disabled={!exact.trim()}>
          Download
        </button>
      </form>
    </div>
  );
}

function HuggingFace(ctx: Ctx) {
  const [q, setQ] = useState('');
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [repo, setRepo] = useState('');
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setRepo('');
    setFiles(null);
    try {
      setRepos(await api<HfRepo[]>(`/api/hf/search?q=${encodeURIComponent(q)}`));
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setRepo(id);
    setFiles(null);
    try {
      setFiles(await api<HfFile[]>(`/api/hf/files?repo=${encodeURIComponent(id)}`));
    } catch {
      setFiles([]);
    }
  };

  const allSplit = !!files?.length && files.every((f) => f.split);

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Hugging Face (GGUF)</h2>
      <form className="flex gap-2" onSubmit={search}>
        <input className="input" placeholder="Search, e.g. qwen 7b instruct" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {!repos && <p className="text-xs text-slate-400">Search GGUF models, pick a quant, and Ollama downloads it as hf.co/user/repo:QUANT. Q4_K_M is the usual sweet spot.</p>}
      {repo ? (
        <div className="space-y-1">
          <button className="text-xs text-indigo-400 hover:underline" onClick={() => setRepo('')}>
            ← back to results
          </button>
          <div className="truncate text-sm font-medium">{repo}</div>
          {files === null && <p className="text-xs text-slate-400">Loading files…</p>}
          {files?.length === 0 && <p className="text-xs text-slate-400">No GGUF files Ollama can use in this repo.</p>}
          {allSplit && (
            <p className="rounded-md border border-amber-700 bg-amber-950/40 p-2 text-xs text-amber-200">
              This repo only has sharded files (each quant split in parts). Ollama can't download those — pick a repo with single-file quants
              (e.g. from bartowski, unsloth or mradermacher).
            </p>
          )}
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {files?.map((f) => (
              <div key={f.quant} className={`flex items-center gap-2 text-sm ${f.split ? 'opacity-50' : ''}`}>
                <code className={`w-24 shrink-0 ${f.quant === 'Q4_K_M' ? 'text-emerald-300' : 'text-slate-200'}`}>{f.quant}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={f.file}>
                  {f.file}
                </span>
                <FitBadge bytes={f.sizeBytes} vram={ctx.vram} />
                <span className="w-16 text-right text-xs text-slate-400">{size(f.sizeBytes)}</span>
                {f.split ? (
                  <span className="w-[70px] text-center text-xs text-slate-500" title="Split in parts: Ollama can't download these">
                    sharded
                  </span>
                ) : (
                  <DownloadButton name={f.pullName} bytes={f.sizeBytes} ctx={ctx} />
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {repos?.length === 0 && <p className="text-xs text-slate-400">Nothing found.</p>}
          {repos?.map((r) => (
            <button key={r.id} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-[#21262d]" onClick={() => open(r.id)}>
              <span className="flex-1 truncate">{r.id}</span>
              <span className="text-xs text-slate-500">↓ {count(r.downloads)}</span>
              <span className="text-xs text-slate-500">♥ {count(r.likes)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
