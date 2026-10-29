import type { Dataset, ProviderInfo, TrainJob, TrainOverview } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';

/** Lab → New model: fine-tune a base model on the Lab dataset and put the result into Ollama as a new model. */

const ACTIVE = new Set(['waiting', 'starting', 'loading', 'training', 'exporting', 'importing']);

const STATE: Record<string, { label: string; tone: string }> = {
  waiting: { label: 'Waiting for the GPU', tone: 'text-amber-300' },
  starting: { label: 'Starting', tone: 'text-indigo-300' },
  loading: { label: 'Loading the base model', tone: 'text-indigo-300' },
  training: { label: 'Training', tone: 'text-indigo-200' },
  exporting: { label: 'Making the GGUF', tone: 'text-fuchsia-300' },
  importing: { label: 'Putting it into Ollama', tone: 'text-fuchsia-300' },
  paused: { label: 'Paused — GPU free', tone: 'text-amber-200' },
  done: { label: 'Ready', tone: 'text-emerald-300' },
  error: { label: 'Failed', tone: 'text-red-300' },
  cancelled: { label: 'Cancelled', tone: 'text-slate-400' },
  interrupted: { label: 'Interrupted', tone: 'text-amber-300' },
};

const dur = (s?: number) => {
  if (s === undefined || !Number.isFinite(s)) return '—';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

export function NewModel({ active, providers }: { active: boolean; providers: ProviderInfo[] }) {
  const [info, setInfo] = useState<TrainOverview | null>(null);
  const [base, setBase] = useStored('lab.train.base', 'unsloth/Qwen3.5-9B');
  const [name, setName] = useState(`dungeonmind-dm:${today()}`);
  const [epochs, setEpochs] = useStored('lab.train.epochs', 2);
  const [target, setTarget] = useStored<string>('lab.train.target', '');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useStored<string>('lab.train.dataset', '');
  const ollamas = providers.filter((p) => p.kind === 'ollama' && p.enabled);
  const targetId = ollamas.some((p) => p.id === target) ? target : ollamas[0]?.id;

  const load = () => {
    api<Dataset[]>('/api/datasets', { quiet: true })
      .then((l) => setDatasets(l.filter((d) => d.kind === 'text')))
      .catch(() => {});
    return api<TrainOverview>('/api/lab/train', { quiet: true })
      .then((o) => {
        setInfo(o);
        setUrl((u) => u || (o.trainer.url?.includes('127.0.0.1') ? '' : o.trainer.url) || '');
      })
      .catch(() => {});
  };
  const running = info?.jobs.find((j) => ACTIVE.has(j.state));
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(load, running ? 3000 : 15000);
    return () => clearInterval(t);
  }, [active, !!running]);

  const saveUrl = async () => {
    setBusy(true);
    try {
      setInfo(await api<TrainOverview>('/api/lab/train/settings', { method: 'PUT', body: { url } }));
      toast('Trainer address saved', 'ok');
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!targetId) return toast('Add an Ollama server first (Settings → Providers)', 'info');
    setBusy(true);
    try {
      await api<TrainJob>('/api/lab/train', { body: { base, name, providerId: targetId, epochs, ...(dataset && { datasetId: dataset.id }) } });
      toast(running ? `${name} is queued — it starts when the GPU is free` : `Making ${name} — local AI on this GPU pauses until it's done`, 'ok');
      load();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const act = async (id: string, what: 'pause' | 'resume') => {
    await api(`/api/lab/train/${id}/${what}`, { method: 'POST' }).catch(() => {});
    if (what === 'pause') toast('Pausing after the current step — the GPU is freed when the checkpoint is saved', 'info');
    load();
  };
  const cancel = async (id: string) => {
    if (!confirm('Stop making this model? The work so far is lost.')) return;
    await api(`/api/lab/train/${id}/cancel`, { method: 'POST' }).catch(() => {});
    load();
  };

  if (!info) return <div className="card text-sm text-slate-400">Loading…</div>;
  const chosen = info.bases.find((b) => b.id === base);
  const dataset = datasets.find((d) => d.id === datasetId) ?? datasets.find((d) => d.name === 'DungeonMind DM') ?? datasets[0];
  const rows = dataset ? dataset.items : info.rows;
  const steps = Math.ceil(rows / 4) * epochs;
  const estimate = chosen ? steps * chosen.secPerStep + 600 : undefined;
  const enough = rows >= info.minRows;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <div className="card space-y-3">
        <h3 className="font-semibold">Make a new model</h3>
        <p className="text-xs text-slate-400">
          Trains a base model on one of your datasets and puts the result into Ollama under its own name. Your current models stay as they are. Several jobs
          can be started: they wait their turn for the GPU.
        </p>
        <label className="block space-y-1 text-xs">
          <span className="font-semibold text-slate-300">Dataset</span>
          <select className="input py-1 text-xs" value={dataset?.id ?? ''} onChange={(e) => setDatasetId(e.target.value)}>
            {datasets.length === 0 && <option value="">No text datasets yet — make one in Datasets</option>}
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.items} examples{d.pending ? ` (+${d.pending} to review)` : ''}
              </option>
            ))}
          </select>
        </label>

        <div className={`rounded-md border p-2 text-xs ${info.trainer.ok ? 'border-emerald-800/60 bg-emerald-950/20' : 'border-amber-800/60 bg-amber-950/20'}`}>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${info.trainer.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="font-semibold">Trainer</span>
            <span className="text-slate-400">
              {info.trainer.ok
                ? `ready${info.trainer.gpu ? ` · ${info.trainer.gpu.name}, ${(info.trainer.gpu.usedMb / 1024).toFixed(1)} / ${(info.trainer.gpu.totalMb / 1024).toFixed(0)} GB in use` : ''}`
                : info.trainer.error}
            </span>
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-slate-500">Advanced: use a trainer on another machine</summary>
            <p className="mt-1 text-slate-500">The trainer is built into HiveMind. Only fill this in to train on another computer's GPU; leave it empty for the built-in one.</p>
            <div className="mt-1 flex gap-2">
              <input className="input py-1 text-xs" placeholder="empty = built in" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={saveUrl}>
                Save
              </button>
            </div>
          </details>
        </div>

        <div className="space-y-1">
          <div className="text-xs font-semibold text-slate-300">Base model</div>
          <div className="grid gap-1.5">
            {info.bases.map((b) => (
              <button
                key={b.id}
                onClick={() => setBase(b.id)}
                className={`rounded-md border px-2 py-1.5 text-left text-sm ${base === b.id ? 'border-indigo-500 bg-indigo-500/15' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
              >
                <span className="font-medium">{b.name}</span> <span className="text-xs text-slate-500">{b.id}</span>
                <div className="text-[11px] text-slate-400">{b.note}</div>
              </button>
            ))}
          </div>
          <input className="input py-1 text-xs" value={base} onChange={(e) => setBase(e.target.value.trim())} title="Any Hugging Face model Unsloth can train (Apache-2.0 / MIT if you want to share it)" />
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-slate-400">New model name</span>
            <input className="input py-1 text-xs" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} />
          </label>
          <label className="space-y-1">
            <span className="text-slate-400">Put it on</span>
            <select className="input py-1 text-xs" value={targetId} onChange={(e) => setTarget(e.target.value)}>
              {ollamas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 space-y-1">
            <span className="text-slate-400">Rounds over the data (epochs): {epochs}</span>
            <input type="range" className="w-full" min={1} max={5} value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} />
          </label>
        </div>

        <div className="rounded-md bg-[#0d1117] p-2 text-xs">
          <div>
            Training examples ready: <span className={`font-mono font-semibold ${enough ? 'text-emerald-300' : 'text-amber-300'}`}>{rows}</span>
            {!enough && <span className="text-amber-300"> — at least {info.minRows} needed; a few hundred is better. Let the Simulator run first.</span>}
          </div>
          {enough && <div className="text-slate-400">About {dur(estimate)} on a Tesla T4 ({steps} steps), plus the download of the base model the first time.</div>}
        </div>

        <button className="btn w-full" disabled={busy || !enough || !info.trainer.ok} onClick={start}>
          {running ? `Queue ${name}` : `Make ${name}`}
        </button>
        <p className="text-[11px] text-slate-500">While it trains, Ollama, ComfyUI and the Simulator on this GPU wait. Runs you start meanwhile are queued, not lost.</p>
      </div>

      <div className="card space-y-3">
        <h3 className="font-semibold">Models made here</h3>
        {info.jobs.length === 0 && <p className="text-sm text-slate-400">Nothing yet.</p>}
        {info.jobs.map((j) => {
          const s = STATE[j.state] ?? { label: j.state, tone: 'text-slate-300' };
          const pct = j.state === 'done' ? 100 : j.totalSteps ? Math.min(100, ((j.step ?? 0) / j.totalSteps) * 100) : 0;
          const live = ACTIVE.has(j.state);
          return (
            <div key={j.id} className="space-y-2 rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${live ? 'hm-breathe bg-indigo-400 shadow-[0_0_10px_#818cf8]' : j.state === 'done' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="font-mono text-sm font-semibold">{j.name}</span>
                <span className={`text-xs ${s.tone}`}>{s.label}</span>
                <span className="ml-auto flex gap-3 text-xs">
                  {live && j.state !== 'waiting' && (
                    <button className="text-slate-400 hover:text-amber-300" onClick={() => act(j.id, 'pause')}>
                      ⏸ Pause
                    </button>
                  )}
                  {j.state === 'paused' && (
                    <button className="text-emerald-300 hover:text-emerald-200" onClick={() => act(j.id, 'resume')}>
                      ▶ Resume
                    </button>
                  )}
                  {live && (
                    <button className="text-slate-500 hover:text-red-400" onClick={() => cancel(j.id)}>
                      Cancel
                    </button>
                  )}
                </span>
              </div>
              <div className="text-[11px] text-slate-500">
                from {j.base} · {j.rows} examples · started {j.startedAt} UTC
              </div>
              {(live || j.state === 'done') && (
                <div className="h-2 overflow-hidden rounded bg-[#21262d]">
                  <div className={`h-full rounded transition-all duration-700 ${j.state === 'done' ? 'bg-emerald-500' : 'bg-gradient-to-r from-indigo-500 to-fuchsia-500'} ${live && !j.totalSteps ? 'hm-flow w-full opacity-60' : ''}`} style={j.totalSteps || j.state === 'done' ? { width: `${pct}%` } : undefined} />
                </div>
              )}
              {live && (
                <div className="flex flex-wrap gap-x-4 text-xs text-slate-400">
                  {j.totalSteps ? <span>step {j.step ?? 0} / {j.totalSteps}</span> : null}
                  {j.loss !== undefined && j.loss !== null && <span>loss {Number(j.loss).toFixed(3)}</span>}
                  {j.etaS ? <span>about {dur(j.etaS)} left</span> : null}
                  {j.note && <span className="text-slate-500">{j.note}</span>}
                </div>
              )}
              {j.state === 'done' && <p className="text-xs text-emerald-300/90">In Ollama as {j.name}. Add it as a DM model in the Simulator to compare it on the Scoreboard.</p>}
              {j.error && <p className="rounded bg-red-950/50 px-2 py-1 text-xs text-red-300">{j.error}</p>}
              {j.log && (live || j.state === 'error') && (
                <details>
                  <summary className="cursor-pointer text-[11px] text-slate-500">Trainer log</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-slate-400">{j.log.slice(-2500)}</pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
