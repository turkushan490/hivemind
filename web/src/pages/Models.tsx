import type { HfFile, HfRepo, ModelInfo, ProviderInfo, PullJob } from '@hivemind/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';

const size = (b?: number) => (b === undefined ? '' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Download models into Ollama from the Ollama library or Hugging Face, and delete them. */
export function Models({ active }: { active: boolean }) {
  const [hosts, setHosts] = useState<ProviderInfo[]>([]);
  const [hostId, setHostId] = useStored('models.host', '');
  const [installed, setInstalled] = useState<ModelInfo[]>([]);
  const [jobs, setJobs] = useState<PullJob[]>([]);
  const [picks, setPicks] = useState<{ name: string; note: string }[]>([]);
  const [name, setName] = useState('');

  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];

  const loadInstalled = async () => {
    if (!host) return;
    setInstalled(await api<ModelInfo[]>(`/api/providers/${host.id}/models?fresh=1`, { quiet: true }).catch(() => []));
  };

  useEffect(() => {
    if (!active) return;
    api<ProviderInfo[]>('/api/providers').then((l) => setHosts(l.filter((p) => p.local && p.enabled)));
    api<{ name: string; note: string }[]>('/api/ollama/picks').then(setPicks);
  }, [active]);

  useEffect(() => {
    loadInstalled();
  }, [host?.id, active]);

  // Poll downloads fast while one runs; refresh the installed list when one finishes.
  useEffect(() => {
    if (!active) return;
    let prevRunning = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const list = await api<PullJob[]>('/api/ollama/pulls', { quiet: true }).catch(() => [] as PullJob[]);
      setJobs(list);
      const running = list.filter((j) => j.state === 'running').length;
      if (running < prevRunning) loadInstalled();
      prevRunning = running;
      timer = setTimeout(tick, running ? 1000 : 5000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, host?.id]);

  const download = async (model: string) => {
    if (!host) return;
    try {
      await api(`/api/ollama/${host.id}/pull`, { body: { model } });
      toast(`Downloading ${model}…`, 'info');
      setJobs(await api<PullJob[]>('/api/ollama/pulls'));
    } catch {}
  };

  if (hosts.length === 0)
    return <div className="card text-sm text-slate-400">No Ollama connected. Add one under AI providers first.</div>;

  const hostJobs = jobs.filter((j) => j.providerId === host?.id);

  return (
    <div className="space-y-4">
      {hosts.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
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

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <h2 className="font-semibold">Ollama library</h2>
          <form
            className="flex gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (name.trim()) download(name.trim());
              setName('');
            }}
          >
            <input className="input" placeholder="Model name, e.g. qwen3:8b" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn" disabled={!name.trim()}>
              Download
            </button>
          </form>
          <p className="text-xs text-slate-400">
            Any model from{' '}
            <a className="text-indigo-400 hover:underline" href="https://ollama.com/library" target="_blank" rel="noreferrer">
              ollama.com/library
            </a>{' '}
            works. Some good starting points:
          </p>
          <div className="space-y-1">
            {picks.map((p) => {
              const have = installed.some((m) => m.model === p.name || m.model === `${p.name}:latest`);
              return (
                <div key={p.name} className="flex items-center gap-2 text-sm">
                  <code className="w-32 shrink-0 text-slate-200">{p.name}</code>
                  <span className="flex-1 truncate text-xs text-slate-400">{p.note}</span>
                  {have ? (
                    <span className="text-xs text-emerald-400">installed</span>
                  ) : (
                    <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => download(p.name)}>
                      Download
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <HuggingFace onDownload={download} />
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

function HuggingFace({ onDownload }: { onDownload: (model: string) => void }) {
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
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {files?.map((f) => (
              <div key={f.file} className="flex items-center gap-2 text-sm">
                <code className={`w-24 shrink-0 ${f.quant === 'Q4_K_M' ? 'text-emerald-300' : 'text-slate-200'}`}>{f.quant}</code>
                <span className="flex-1 truncate text-xs text-slate-500" title={f.file}>
                  {f.file}
                </span>
                <span className="w-16 text-right text-xs text-slate-400">{size(f.sizeBytes)}</span>
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  disabled={f.split}
                  title={f.split ? 'Split files can not be pulled by Ollama' : f.pullName}
                  onClick={() => onDownload(f.pullName)}
                >
                  {f.split ? 'split' : 'Download'}
                </button>
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
