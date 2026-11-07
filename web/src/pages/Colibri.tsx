import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { toast } from '../notify';

interface Settings {
  ramGb?: number;
  gpu: 'auto' | 'off';
  vramGb: number;
  keepAliveMin: number;
  callSeconds: number;
  gpuHost?: string;
  ctx: number;
}

interface Job {
  id: string;
  kind: 'download' | 'gguf';
  model: string;
  label: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  doneBytes: number;
  totalBytes: number;
  file?: string;
  error?: string;
}

interface Status {
  available: boolean;
  version?: string;
  ref?: string;
  cudaBuilt: boolean;
  gpu: boolean;
  cudaBroken: boolean;
  gpuDevice: boolean;
  containerLimitBytes: number;
  ramBudgetBytes: number;
  loaded?: { model: string; state: 'starting' | 'ready'; since: string; gpu: boolean };
  health?: Record<string, number>;
  log: string;
  settings: Settings;
  gpuHost: string;
  jobs: Job[];
}

interface CatalogModel {
  id: string;
  name: string;
  download_gb: number;
  ram_min_gb: number;
  ram_good_gb: number;
  summary: string;
  runs: string;
  status: 'good' | 'tight' | 'needs-ram' | 'needs-disk' | 'unsupported';
  reason: string;
  recommended: boolean;
  license_note: string;
  size_class: 'small' | 'large';
  installed: boolean;
  downloaded_bytes: number;
}

interface Installed {
  model: string;
  name: string;
  sizeBytes?: number;
}

const gb = (b: number) => `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`;

const FIT: Record<CatalogModel['status'], { label: string; cls: string }> = {
  good: { label: 'fits', cls: 'bg-emerald-900/50 text-emerald-300' },
  tight: { label: 'fits (tight)', cls: 'bg-amber-900/50 text-amber-300' },
  'needs-ram': { label: 'too big (RAM)', cls: 'bg-red-900/50 text-red-300' },
  'needs-disk': { label: 'no disk space', cls: 'bg-red-900/50 text-red-300' },
  unsupported: { label: 'not on this CPU', cls: 'bg-slate-800 text-slate-400' },
};

/** Settings → Colibri: the engine inside HiveMind for very large mixture-of-experts models. Admins only. */
export function ColibriPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [cat, setCat] = useState<{ models: CatalogModel[]; diskFree: number } | null>(null);
  const [catError, setCatError] = useState('');
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState('');
  const [gguf, setGguf] = useState({ repo: '', file: '', name: '' });

  const loadStatus = async () => {
    const s = await api<Status>('/api/colibri/status', { quiet: true }).catch(() => null);
    setStatus(s);
    if (s && !form) setForm(s.settings);
    return s;
  };
  const loadModels = async (fresh = false) => {
    const providers = await api<{ id: string; preset: string }[]>('/api/providers', { quiet: true }).catch(() => []);
    const p = providers.find((x) => x.preset === 'colibri');
    if (p) setInstalled(await api<Installed[]>(`/api/providers/${p.id}/models?fresh=1`, { quiet: true }).catch(() => []));
    try {
      setCat(await api(`/api/colibri/catalog${fresh ? '?fresh=1' : ''}`, { quiet: true }));
      setCatError('');
    } catch (err) {
      setCatError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!active) return;
    void loadStatus().then((s) => {
      if (s?.available) void loadModels(true);
    });
    // Downloads and a loading model change by the second: follow them while the page is open.
    const t = setInterval(() => {
      void loadStatus().then((s) => {
        if (s?.jobs.some((j) => j.state === 'running')) return;
        if (s?.jobs.length) void loadModels();
      });
    }, 3000);
    return () => clearInterval(t);
  }, [active]);

  if (!status) return null;
  if (!status.available)
    return (
      <div className="card max-w-3xl space-y-2">
        <h2 className="font-semibold">Colibri</h2>
        <p className="text-sm text-slate-400">This HiveMind build has no colibri engine. The Docker image from GitHub has it; a development copy doesn&apos;t.</p>
      </div>
    );

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch {}
    setBusy('');
    await loadStatus();
    await loadModels(true);
  };

  const save = async () => {
    if (!form) return;
    try {
      const next = await api<Settings>('/api/colibri/settings', { method: 'PUT', body: form });
      setForm(next);
      toast('Colibri settings saved (they apply the next time a model loads)', 'ok');
      await loadStatus();
    } catch {}
  };

  const importGguf = async (e: FormEvent) => {
    e.preventDefault();
    await act('import', () => api('/api/colibri/import', { body: gguf }));
    setGguf({ repo: '', file: '', name: '' });
  };

  const running = status.jobs.filter((j) => j.state === 'running');
  const recent = status.jobs.filter((j) => j.state !== 'running').slice(0, 5);
  const limit = status.containerLimitBytes;
  const engine = status.gpu ? 'CUDA on the GPU' : status.cudaBroken ? 'CPU only (the CUDA build would not start here)' : status.cudaBuilt && !status.gpuDevice ? 'CPU only (no GPU passed to the container)' : 'CPU only';

  return (
    <div className="max-w-3xl space-y-4">
      <div className="card space-y-3">
        <h2 className="font-semibold">Colibri</h2>
        <p className="text-sm text-slate-400">
          An engine for very large mixture-of-experts models, inside HiveMind. It keeps the parts a model uses most on the GPU or in RAM and reads the rest from the disk,
          so a model can be far bigger than the memory there is. Small ones (30–35B) answer at several words a second; giant ones (150B–744B) are for slow work overnight.
          Its models show up as <b>Colibri</b> in every model picker, and as <b>Colibri decisions</b> for Decide blocks.
        </p>
        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div>
            <span className="text-slate-500">Engine </span>
            {engine}
            {status.version && <span className="ml-1 text-xs text-slate-500">v{status.version}</span>}
          </div>
          <div>
            <span className="text-slate-500">RAM </span>
            {gb(status.ramBudgetBytes)} for colibri <span className="text-xs text-slate-500">(HiveMind may use {gb(limit)})</span>
          </div>
          <div>
            <span className="text-slate-500">Disk free </span>
            {cat ? gb(cat.diskFree) : '…'}
          </div>
          <div>
            <span className="text-slate-500">Shares the GPU queue with </span>
            {status.gpuHost}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          More RAM: raise <code>--memory</code> in HiveMind&apos;s Docker template (Unraid: Edit → Extra Parameters) and restart it; this page reads the new limit by itself.
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded border border-[#30363d] p-2 text-sm">
          {status.loaded ? (
            <>
              <span className={status.loaded.state === 'ready' ? 'text-emerald-300' : 'text-amber-300'}>{status.loaded.state === 'ready' ? 'Loaded' : 'Loading…'}</span>
              <b>{status.loaded.model}</b>
              <span className="text-xs text-slate-500">{status.loaded.gpu ? 'GPU + RAM' : 'CPU'}</span>
              {status.health && (
                <span className="text-xs text-slate-500">
                  {status.health.active ?? 0} answering, {status.health.queued ?? 0} waiting
                </span>
              )}
              <button className="btn ml-auto" disabled={!!busy} onClick={() => act('unload', () => api('/api/colibri/unload', { method: 'POST' }))}>
                Unload
              </button>
            </>
          ) : (
            <span className="text-slate-400">Nothing loaded. A model loads when a block uses it, and unloads after {status.settings.keepAliveMin} min without calls.</span>
          )}
        </div>
      </div>

      <div className="card space-y-2">
        <h3 className="font-semibold">Your colibri models</h3>
        {installed.length === 0 && <p className="text-sm text-slate-400">None yet: download one below.</p>}
        {installed.map((m) => (
          <div key={m.model} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{m.name}</span>
            {m.sizeBytes !== undefined && <span className="text-xs text-slate-500">{gb(m.sizeBytes)}</span>}
            <span className="ml-auto flex gap-2">
              <button className="btn" disabled={!!busy || status.loaded?.model === m.model} onClick={() => act(`load ${m.model}`, () => api('/api/colibri/load', { body: { model: m.model } }))}>
                {busy === `load ${m.model}` ? 'Loading…' : 'Load now'}
              </button>
              <button
                className="btn"
                disabled={!!busy}
                onClick={() => confirm(`Delete ${m.name} from the disk? Downloading it again takes a while.`) && act('delete', () => api(`/api/colibri/models/${encodeURIComponent(m.model)}`, { method: 'DELETE' }))}
              >
                Delete
              </button>
            </span>
          </div>
        ))}
      </div>

      {(running.length > 0 || recent.length > 0) && (
        <div className="card space-y-2">
          <h3 className="font-semibold">Downloads</h3>
          {[...running, ...recent].map((j) => (
            <div key={j.id} className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span>{j.label}</span>
                <span className={`text-xs ${j.state === 'error' ? 'text-red-300' : j.state === 'done' ? 'text-emerald-300' : 'text-slate-500'}`}>
                  {j.state === 'running' ? (j.totalBytes ? `${gb(j.doneBytes)} of ${gb(j.totalBytes)}` : 'starting…') : j.state}
                </span>
                {j.state === 'running' && (
                  <button className="btn ml-auto py-0.5 text-xs" onClick={() => act('cancel', () => api(`/api/colibri/jobs/${j.id}/cancel`, { method: 'POST' }))}>
                    Stop
                  </button>
                )}
              </div>
              {j.state === 'running' && j.totalBytes > 0 && (
                <div className="h-1.5 rounded bg-[#21262d]">
                  <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${Math.min(100, (j.doneBytes / j.totalBytes) * 100)}%` }} />
                </div>
              )}
              {j.error && <p className="text-xs text-red-300">{j.error}</p>}
            </div>
          ))}
          <p className="text-xs text-slate-500">A stopped or broken download goes on where it was when you start it again.</p>
        </div>
      )}

      <div className="card space-y-2">
        <h3 className="font-semibold">Download a model</h3>
        <p className="text-xs text-slate-500">
          Colibri&apos;s own list, checked against this container: <i>fits</i> means the always-loaded part plus the smallest expert cache fit in its RAM, and the download
          fits on the disk.
        </p>
        {catError && <p className="text-sm text-red-300">{catError}</p>}
        {cat?.models.map((m) => (
          <div key={m.id} className="flex flex-wrap items-start gap-2 border-t border-[#21262d] pt-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                <span className={`rounded px-1.5 text-xs ${FIT[m.status].cls}`}>{FIT[m.status].label}</span>
                {m.recommended && <span className="rounded bg-indigo-900/60 px-1.5 text-xs text-indigo-200">recommended</span>}
                {m.size_class === 'large' && <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">slow: for overnight</span>}
              </div>
              <div className="text-xs text-slate-400">
                {m.summary}. {m.download_gb} GB download, RAM {m.ram_min_gb}–{m.ram_good_gb} GB, {m.runs}.
              </div>
              <div className="text-xs text-slate-500">{m.reason}</div>
              {m.license_note && <div className="text-xs text-amber-300">{m.license_note}</div>}
            </div>
            {m.installed ? (
              <span className="text-xs text-emerald-300">installed</span>
            ) : (
              <button
                className="btn"
                disabled={!!busy || m.status === 'needs-disk' || running.some((j) => j.model === m.id)}
                title={m.status === 'needs-ram' ? 'It downloads, but will only load once HiveMind has more RAM' : undefined}
                onClick={() =>
                  (m.download_gb < 100 || confirm(`${m.name} is a ${m.download_gb} GB download. Start it?`)) && act('download', () => api('/api/colibri/download', { body: { id: m.id } }))
                }
              >
                {m.downloaded_bytes > 0 ? `Go on (${gb(m.downloaded_bytes)} there)` : 'Download'}
              </button>
            )}
          </div>
        ))}
      </div>

      <form className="card space-y-2" onSubmit={importGguf}>
        <h3 className="font-semibold">Import a GGUF from Hugging Face</h3>
        <p className="text-xs text-slate-500">
          For a mixture-of-experts GGUF colibri can read (see its README): the file is downloaded and imported with <code>coli import</code>, which reads the weights from
          the GGUF in place. For a model in several parts, give the first part.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="input" placeholder="owner/repository" value={gguf.repo} onChange={(e) => setGguf({ ...gguf, repo: e.target.value })} />
          <input className="input" placeholder="model-Q4_K_M.gguf" value={gguf.file} onChange={(e) => setGguf({ ...gguf, file: e.target.value })} />
          <input className="input" placeholder="name (e.g. flint-q4)" value={gguf.name} onChange={(e) => setGguf({ ...gguf, name: e.target.value })} />
        </div>
        <button className="btn" disabled={!!busy || !gguf.repo || !gguf.file || !gguf.name}>
          Import
        </button>
      </form>

      {form && (
        <div className="card space-y-3">
          <h3 className="font-semibold">Settings</h3>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-slate-400">RAM for colibri (GB, 0 = all HiveMind may use, minus 4 GB)</span>
              <input className="input" type="number" min={0} value={form.ramGb ?? 0} onChange={(e) => setForm({ ...form, ramGb: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-slate-400">GPU</span>
              <select className="input" value={form.gpu} onChange={(e) => setForm({ ...form, gpu: e.target.value as Settings['gpu'] })}>
                <option value="auto">Use the GPU when it can (waits its turn with Ollama and ComfyUI)</option>
                <option value="off">CPU only (never waits for the GPU)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-slate-400">VRAM for the hot experts (GB, 0 = colibri decides)</span>
              <input className="input" type="number" min={0} step={0.5} value={form.vramGb} onChange={(e) => setForm({ ...form, vramGb: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-slate-400">Unload after (minutes without calls)</span>
              <input className="input" type="number" min={1} value={form.keepAliveMin} onChange={(e) => setForm({ ...form, keepAliveMin: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-slate-400">Time limit per call (seconds, when the block sets none)</span>
              <input className="input" type="number" min={60} value={form.callSeconds} onChange={(e) => setForm({ ...form, callSeconds: Number(e.target.value) })} />
            </label>
            <label className="space-y-1">
              <span className="text-slate-400">Context (tokens, 0 = colibri decides)</span>
              <input className="input" type="number" min={0} step={1024} value={form.ctx} onChange={(e) => setForm({ ...form, ctx: Number(e.target.value) })} />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-slate-400">GPU queue: the machine of the Ollama/ComfyUI that use the same GPU (empty = the first Ollama)</span>
              <input className="input" placeholder={status.gpuHost} value={form.gpuHost ?? ''} onChange={(e) => setForm({ ...form, gpuHost: e.target.value })} />
            </label>
          </div>
          <button className="btn" onClick={save}>
            Save
          </button>
        </div>
      )}

      {status.log && (
        <details className="card">
          <summary className="cursor-pointer text-sm text-slate-400">Engine log</summary>
          <pre className="mt-2 max-h-80 overflow-auto text-xs whitespace-pre-wrap text-slate-400">{status.log}</pre>
        </details>
      )}
    </div>
  );
}
