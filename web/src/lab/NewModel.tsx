import type { Dataset, HfHardware, ModelInfo, ProviderInfo, TrainBase, TrainJob, TrainOverview } from '@hivemind/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';

/**
 * Lab → New model: one screen in three steps — your data, a "brain" (base model) and Start. Everything technical
 * (any base, a Hugging Face id, the trainer address, epochs, cloud machines) waits under Advanced.
 */

const ACTIVE = new Set(['queued', 'waiting', 'starting', 'loading', 'training', 'exporting', 'importing']);

const STATE: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Waiting for the training window', tone: 'text-amber-200' },
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

/** The three choices most people need; the full list is under Advanced. */
const BRAINS = [
  { id: 'unsloth/Qwen3.5-2B', title: 'Small & fast', blurb: 'Quick to train and to answer. Good for one clear task.' },
  { id: 'unsloth/Qwen3.5-4B', title: 'Balanced', blurb: 'Smarter, still fairly quick to answer.' },
  { id: 'unsloth/Qwen3-8B', title: 'Smart, slow', blurb: 'The best answers; training takes hours.' },
];

const dur = (s?: number) => {
  if (s === undefined || !Number.isFinite(s)) return '—';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

function Step({ n, title, children, dim }: { n: number; title: string; children: ReactNode; dim?: boolean }) {
  return (
    <section className={`space-y-2 ${dim ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/25 text-xs font-semibold text-indigo-100">{n}</span>
        <h4 className="font-semibold">{title}</h4>
      </div>
      <div className="space-y-2 pl-8">{children}</div>
    </section>
  );
}

/** The loss per step as a small line: going down means it is learning. */
function LossLine({ losses }: { losses: { step: number; loss: number }[] }) {
  if (losses.length < 2) return null;
  const xs = losses.map((l) => l.step);
  const ys = losses.map((l) => l.loss);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pts = losses.map((l) => `${((l.step - x0) / (x1 - x0 || 1)) * 200},${38 - ((l.loss - y0) / (y1 - y0 || 1)) * 36}`).join(' ');
  return (
    <svg viewBox="0 0 200 40" className="h-10 w-full" preserveAspectRatio="none" aria-label="Loss per step">
      <polyline points={pts} fill="none" stroke="#818cf8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function NewModel({ active, providers, onDatasets }: { active: boolean; providers: ProviderInfo[]; onDatasets: () => void }) {
  const [info, setInfo] = useState<TrainOverview | null>(null);
  const [base, setBase] = useStored('lab.train.base', 'unsloth/Qwen3.5-2B');
  // The name follows the dataset (my-dataset:20261029) until you type your own.
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [epochs, setEpochs] = useStored('lab.train.epochs', 2);
  const [target, setTarget] = useStored<string>('lab.train.target', '');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useStored<string>('lab.train.dataset', '');
  // Where it trains: "local" (this server's GPU) or a Hugging Face Jobs machine.
  const [where, setWhere] = useStored<string>('lab.train.where', 'local');
  const [nightly, setNightly] = useStored('lab.train.nightly', false);
  const [hardware, setHardware] = useState<HfHardware[]>([]);
  // Image LoRAs: a ComfyUI checkpoint to train on, the steps and a trigger word.
  const [checkpoints, setCheckpoints] = useState<ModelInfo[]>([]);
  const [checkpoint, setCheckpoint] = useStored<string>('lab.train.checkpoint', '');
  const [imageSteps, setImageSteps] = useState<number | ''>('');
  const [trigger, setTrigger] = useState('');
  const [testRun, setTestRun] = useState(false);
  useEffect(() => {
    if (!active) return;
    api<{ models: ModelInfo[] }>('/api/models', { quiet: true })
      .then((r) => setCheckpoints(r.models.filter((m) => m.kind === 'image' && providers.some((p) => p.id === m.providerId && p.kind === 'comfyui'))))
      .catch(() => {});
  }, [active, providers.length]);
  const [estimate, setEstimate] = useState<{ hours: number; usd: number; label: string } | { error: string } | null>(null);
  const ollamas = providers.filter((p) => p.kind === 'ollama' && p.enabled);
  const targetId = ollamas.some((p) => p.id === target) ? target : ollamas[0]?.id;

  const load = () => {
    api<Dataset[]>('/api/datasets', { quiet: true })
      .then((l) => setDatasets(l.filter((d) => d.kind !== 'voice')))
      .catch(() => {});
    return api<TrainOverview>('/api/lab/train', { quiet: true })
      .then((o) => {
        setInfo(o);
        if (o.hf.hasToken && !hardware.length)
          api<{ hardware: HfHardware[] }>('/api/hf', { quiet: true })
            .then((h) => setHardware(h.hardware))
            .catch(() => {});
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
  const cloud = where !== 'local' && hardware.some((h) => h.name === where) ? hardware.find((h) => h.name === where) : undefined;
  useEffect(() => {
    setEstimate(null);
    if (!cloud || !info) return;
    const t = setTimeout(() => {
      api<{ hours: number; usd: number; label: string }>('/api/lab/train/estimate', { body: { flavor: cloud.name, base, epochs, ...(datasetId && { datasetId }) }, quiet: true })
        .then(setEstimate)
        .catch((err) => setEstimate({ error: (err as Error).message }));
    }, 400);
    return () => clearTimeout(t);
  }, [cloud?.name, base, epochs, datasetId, !!info]);

  const startImage = async () => {
    const ck = checkpoints.find((c) => `${c.providerId}|${c.model}` === checkpoint) ?? checkpoints[0];
    if (!ck || !dataset) return toast('Add ComfyUI under Settings → Providers first', 'info');
    setBusy(true);
    try {
      await api<TrainJob>('/api/lab/train', {
        body: {
          base: ck.model,
          name: shownName,
          providerId: ck.providerId,
          datasetId: dataset.id,
          ...(imageSteps && { steps: imageSteps }),
          ...(trigger.trim() && { trigger: trigger.trim() }),
          ...(nightly && { nightly: true }),
        },
      });
      toast(`Training the LoRA ${shownName} in ComfyUI — it starts when ComfyUI's queue is empty`, 'ok');
      load();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!targetId) return toast('Add an Ollama server first (Settings → Providers)', 'info');
    let confirmUsd: number | undefined;
    if (cloud) {
      if (!estimate || 'error' in estimate) return toast('Waiting for the price estimate', 'info');
      if (!confirm(`Train ${shownName} on Hugging Face (${estimate.label})?\n\nAbout ${estimate.hours} h, about $${estimate.usd.toFixed(2)} on your Hugging Face account. The machine stops when the job ends; Cancel stops it early.`)) return;
      confirmUsd = estimate.usd;
    }
    setBusy(true);
    try {
      const job = await api<TrainJob>('/api/lab/train', {
        body: {
          base,
          name: shownName,
          providerId: targetId,
          epochs,
          ...(dataset && { datasetId: dataset.id }),
          ...(cloud && { flavor: cloud.name, confirmUsd }),
          ...(!enough && { allowSmall: true }),
          ...(nightly && { nightly: true }),
        },
      });
      toast(
        job.state === 'queued'
          ? `${shownName} waits for the training window (${info?.window.start}–${info?.window.end})`
          : cloud
            ? `${shownName} is training on Hugging Face`
            : running
              ? `${shownName} is queued — it starts when the GPU is free`
              : `Making ${shownName} — local AI on this GPU pauses until it's done`,
        'ok',
      );
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
  const publish = async (j: TrainJob) => {
    const repo = prompt(`Hugging Face repo for ${j.name} (it starts private; make it public on Hugging Face when you like):`, j.name.replace(/:/g, '-'));
    if (!repo) return;
    try {
      const r = await api<{ url: string }>(`/api/lab/train/${j.id}/publish`, { body: { repo, private: true } });
      toast(`Published: ${r.url}`, 'ok');
      load();
    } catch {}
  };
  const cancel = async (id: string) => {
    if (!confirm('Stop making this model? The work so far is lost.')) return;
    await api(`/api/lab/train/${id}/cancel`, { method: 'POST' }).catch(() => {});
    load();
  };
  const remove = async (j: TrainJob, withModel: boolean) => {
    const question = withModel
      ? `Delete ${j.name} from Ollama too?\n\nWorkflows that use ${j.name} stop working. The job and its files go as well.`
      : `Delete the job "${j.name}" and its files (dataset copy, checkpoints, GGUF)?${j.state === 'done' && j.kind !== 'image' ? `\n\nThe model ${j.name} stays in Ollama.` : ''}`;
    if (!confirm(question)) return;
    try {
      await api(`/api/lab/train/${j.id}${withModel ? '?model=1' : ''}`, { method: 'DELETE' });
      toast(withModel ? `${j.name} deleted, from Ollama too` : 'Job deleted', 'ok');
      load();
    } catch {}
  };

  if (!info) return <div className="card text-sm text-slate-400">Loading…</div>;
  const chosen: TrainBase | undefined = info.bases.find((b) => b.id === base);
  const dataset = datasets.find((d) => d.id === datasetId) ?? datasets.find((d) => d.items > 0) ?? datasets[0];
  const shownName = named ? name : `${(dataset?.name ?? 'my-model').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-model'}:${today()}`;
  const rows = dataset?.items ?? 0;
  const steps = Math.ceil(rows / 4) * epochs;
  const timeFor = (b?: TrainBase) => (b && rows ? steps * b.secPerStep + 600 : undefined);
  const enough = rows >= info.minRows;
  const image = dataset?.kind === 'image';
  // A test run with only a few examples: it checks that training works, the model learns next to nothing.
  const canStart = enough || (testRun && rows >= 1 && !cloud);
  const autoSteps = Math.max(300, Math.min(3000, rows * 100));
  const gpu = info.trainer.gpu;
  const gpuGb = gpu ? gpu.totalMb / 1024 : undefined;
  const fits = (b?: TrainBase) => !b?.vramGb || gpuGb === undefined || gpuGb + 0.5 >= b.vramGb;

  // Why Start is grey, in plain words (the button says it).
  const blocked = !dataset
    ? 'Make a dataset first (step 1)'
    : !canStart
      ? rows === 0
        ? `"${dataset.name}" has no examples yet`
        : `Needs ${info.minRows - rows} more example${info.minRows - rows === 1 ? '' : 's'} (or tick "Test run anyway")`
      : !targetId
        ? 'Add an Ollama server first (Settings → Providers)'
        : cloud
          ? !estimate
            ? 'Working out the price…'
            : 'error' in estimate
              ? `Can't price it: ${estimate.error}`
              : undefined
          : !info.trainer.ok
            ? 'The trainer is not ready (see Advanced)'
            : undefined;
  const startLabel = busy
    ? 'Starting…'
    : blocked ??
      (cloud
        ? `Train ${shownName} on Hugging Face (about $${estimate && !('error' in estimate) ? estimate.usd.toFixed(2) : '?'})`
        : nightly && !info.window.open
          ? `Make ${shownName} tonight (${info.window.start}–${info.window.end})`
          : running
            ? `Queue ${shownName}`
            : `Make ${shownName}`);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <div className="card space-y-5">
        <div>
          <h3 className="font-semibold">Make a new model</h3>
          <p className="text-xs text-slate-400">It learns from your examples and shows up in Ollama under its own name. Your other models stay as they are.</p>
        </div>

        <Step n={1} title="Your data">
          <select className="input py-1 text-sm" value={dataset?.id ?? ''} onChange={(e) => setDatasetId(e.target.value)}>
            {datasets.length === 0 && <option value="">No datasets yet</option>}
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.items} example{d.items === 1 ? '' : 's'} ready{d.pending ? `, ${d.pending} to review` : ''}
                {d.kind === 'decision' ? ' · decisions' : d.kind === 'image' ? ' · pictures' : ''}
              </option>
            ))}
          </select>
          {!dataset && (
            <p className="text-xs text-amber-300">
              A model learns from examples. <button className="underline hover:text-amber-100" onClick={onDatasets}>Make a dataset →</button>
            </p>
          )}
          {dataset && !image && !enough && (
            <div className="space-y-1 rounded-md border border-amber-800/60 bg-amber-950/20 p-2 text-xs">
              <p className="text-amber-200">
                {rows === 0 ? 'No examples ready yet.' : `Only ${rows} example${rows === 1 ? '' : 's'} ready.`} Training needs at least {info.minRows}; a few hundred is what makes a
                real difference.
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-slate-300">
                <li>
                  <button className="text-indigo-300 hover:text-indigo-200" onClick={onDatasets}>
                    Upload or type examples in Datasets →
                  </button>
                </li>
                {dataset.pending > 0 && (
                  <li>
                    <button className="text-indigo-300 hover:text-indigo-200" onClick={onDatasets}>
                      Review the {dataset.pending} waiting example{dataset.pending === 1 ? '' : 's'} →
                    </button>
                  </li>
                )}
                <li>👍 good answers in Chat or a workflow, or let a workflow write them (Workflow → New ▾ → Train).</li>
              </ul>
              {rows >= 1 && !cloud && (
                <label className="flex items-center gap-2 pt-1 text-slate-300">
                  <input type="checkbox" checked={testRun} onChange={(e) => setTestRun(e.target.checked)} /> Test run anyway with {rows} example{rows === 1 ? '' : 's'} (checks that training
                  works; the model learns next to nothing)
                </label>
              )}
            </div>
          )}
          <button className="text-xs text-indigo-300 hover:text-indigo-200" onClick={onDatasets}>
            + Make a new dataset (text / chat, decisions or pictures) →
          </button>
        </Step>

        {image ? (
          <Step n={2} title="Picture model (LoRA)" dim={!dataset}>
            <div className="space-y-2 text-xs">
              <p className="text-slate-400">
                An image LoRA is trained by your ComfyUI, after the work already in its queue. The result goes into ComfyUI&apos;s models/loras/hivemind, ready for Image blocks.
              </p>
              {!info.images.ready && <p className="text-amber-300">ComfyUI&apos;s folder is not mounted in HiveMind yet: add a path to the container (the ComfyUI folder, mounted at /comfyui).</p>}
              <label className="block space-y-1">
                <span className="text-slate-300">Checkpoint to train on (SDXL fits a 16 GB GPU at 512 px)</span>
                <select className="input py-1 text-xs" value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)}>
                  {checkpoints.length === 0 && <option value="">No ComfyUI checkpoints — add ComfyUI under Settings → Providers</option>}
                  {checkpoints.map((c) => (
                    <option key={`${c.providerId}|${c.model}`} value={`${c.providerId}|${c.model}`}>
                      {c.model}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-400">Trigger word (optional)</span>
                  <input className="input py-1 text-xs" placeholder="e.g. grim man" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">Steps (empty = {autoSteps})</span>
                  <input className="input py-1 text-xs" type="number" min={10} max={5000} value={imageSteps} onChange={(e) => setImageSteps(e.target.value ? Number(e.target.value) : '')} />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-slate-400">LoRA name</span>
                <input className="input py-1 text-xs" value={shownName} onChange={(e) => (setNamed(true), setName(e.target.value.toLowerCase().replace(/\s+/g, '-')))} />
              </label>
              <div className="text-slate-400">
                {rows} pictures · about {dur((imageSteps || autoSteps) * info.images.secPerStep + 120)} on a Tesla T4.
              </div>
              <button
                className="btn w-full"
                disabled={busy || rows < 5 || !info.images.ready || !checkpoints.length}
                onClick={startImage}
              >
                {busy
                  ? 'Starting…'
                  : rows < 5
                    ? `Needs ${5 - rows} more picture${5 - rows === 1 ? '' : 's'}`
                    : !info.images.ready
                      ? "ComfyUI's folder is not mounted"
                      : !checkpoints.length
                        ? 'Add ComfyUI first (Settings → Providers)'
                        : `Train the LoRA ${shownName}`}
              </button>
            </div>
          </Step>
        ) : (
          <>
            <Step n={2} title="Pick a brain" dim={!dataset}>
              <div className="grid gap-2 sm:grid-cols-3">
                {BRAINS.map((b) => {
                  const bb = info.bases.find((x) => x.id === b.id);
                  const ok = fits(bb);
                  return (
                    <button
                      key={b.id}
                      onClick={() => setBase(b.id)}
                      className={`rounded-lg border p-2 text-left ${base === b.id ? 'border-indigo-500 bg-indigo-500/15' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
                    >
                      <div className="text-sm font-semibold">{b.title}</div>
                      <div className="text-[11px] text-slate-500">{bb?.name ?? b.id}</div>
                      <div className="mt-1 text-[11px] text-slate-400">{b.blurb}</div>
                      <div className={`mt-1 text-[11px] ${!gpu ? 'text-slate-500' : ok ? 'text-emerald-300' : 'text-amber-300'}`}>
                        {!gpu ? 'No GPU found yet' : ok ? `Fits your ${gpu.name}` : `Needs ~${bb?.vramGb} GB; your GPU has ${Math.round(gpuGb!)} GB — use Hugging Face (Advanced)`}
                      </div>
                      <div className="text-[11px] text-slate-400">{rows ? `about ${dur(timeFor(bb))}` : 'time: add examples first'}</div>
                    </button>
                  );
                })}
              </div>
              {!BRAINS.some((b) => b.id === base) && <p className="text-xs text-slate-400">Using {chosen?.name ?? base} (chosen under Advanced).</p>}
              <p className="text-[11px] text-slate-500">Times are rough estimates for a 16 GB GPU, plus downloading the base model the first time.</p>

              <details className="rounded-md border border-[#30363d] p-2 text-xs">
                <summary className="cursor-pointer text-slate-400">Advanced</summary>
                <div className="mt-2 space-y-3">
                  <div className="space-y-1">
                    <div className="font-semibold text-slate-300">Every base model</div>
                    <div className="grid gap-1">
                      {info.bases.map((b) => (
                        <button
                          key={b.id}
                          onClick={() => setBase(b.id)}
                          className={`rounded-md border px-2 py-1 text-left ${base === b.id ? 'border-indigo-500 bg-indigo-500/15' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
                        >
                          <span className="font-medium">{b.name}</span> <span className="text-slate-500">{b.id}</span>
                          {!fits(b) && <span className="ml-1 text-amber-300">· too big for this GPU</span>}
                          <div className="text-[11px] text-slate-400">{b.note}</div>
                        </button>
                      ))}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-slate-400">Or any Hugging Face model Unsloth can train (Apache-2.0 / MIT if you want to share it)</span>
                      <input className="input py-1 text-xs" placeholder="unsloth/…" value={base} onChange={(e) => setBase(e.target.value.trim())} />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-slate-400">New model name</span>
                      <input className="input py-1 text-xs" value={shownName} onChange={(e) => (setNamed(true), setName(e.target.value.toLowerCase().replace(/\s+/g, '-')))} />
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

                  <label className="block space-y-1">
                    <span className="font-semibold text-slate-300">Train on</span>
                    <select className="input py-1 text-xs" value={cloud ? cloud.name : 'local'} onChange={(e) => setWhere(e.target.value)}>
                      <option value="local">This server&apos;s GPU (free){gpu ? ` · ${gpu.name}` : ''}</option>
                      {hardware.map((h) => (
                        <option key={h.name} value={h.name}>
                          Hugging Face · {h.label} ({h.vramGb} GB) · ${h.usdPerHour.toFixed(2)}/h
                        </option>
                      ))}
                    </select>
                    {!info.hf.hasToken && <span className="text-[11px] text-slate-500">Connect Hugging Face (Settings → Hugging Face) to rent a bigger GPU for one job, or to publish models.</span>}
                    {cloud && estimate && (
                      <span className={`block ${'error' in estimate ? 'text-red-300' : 'text-slate-300'}`}>
                        {'error' in estimate
                          ? estimate.error
                          : `About ${estimate.hours} h on ${estimate.label}: about $${estimate.usd.toFixed(2)} (today $${info.hf.spentTodayUsd.toFixed(2)} of $${info.hf.dailyBudgetUsd.toFixed(2)} used).`}
                      </span>
                    )}
                  </label>

                  <div className={`rounded-md border p-2 ${info.trainer.ok ? 'border-emerald-800/60 bg-emerald-950/20' : 'border-amber-800/60 bg-amber-950/20'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${info.trainer.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                      <span className="font-semibold">Trainer</span>
                      <span className="text-slate-400">
                        {info.trainer.ok ? `ready${gpu ? ` · ${gpu.name}, ${(gpu.usedMb / 1024).toFixed(1)} / ${(gpu.totalMb / 1024).toFixed(0)} GB in use` : ''}` : info.trainer.error}
                      </span>
                    </div>
                    <p className="mt-1 text-slate-500">Built into HiveMind. Only fill this in to train on another computer&apos;s GPU; leave it empty for the built-in one.</p>
                    <div className="mt-1 flex gap-2">
                      <input className="input py-1 text-xs" placeholder="trainer address (empty = built in)" value={url} onChange={(e) => setUrl(e.target.value)} />
                      <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={saveUrl}>
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              </details>
            </Step>

            <Step n={3} title="Start" dim={!!blocked && blocked !== 'Working out the price…'}>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={nightly} onChange={(e) => setNightly(e.target.checked)} /> Only in the training window ({info.window.start}–{info.window.end}
                {info.window.open ? ', open now' : ''}) — it waits until then and pauses when the window closes
              </label>
              <button className="btn w-full" disabled={busy || !!blocked} onClick={start}>
                {startLabel}
              </button>
              {!blocked && !cloud && chosen && !fits(chosen) && (
                <p className="text-[11px] text-amber-300">
                  {chosen.name} probably doesn&apos;t fit your GPU: it may run out of memory. Pick a smaller brain, or Hugging Face under Advanced.
                </p>
              )}
              <p className="text-[11px] text-slate-500">
                Called <span className="font-mono">{shownName}</span> in Ollama. While it trains, Ollama and ComfyUI on this GPU wait; runs started meanwhile are queued, not lost.
              </p>
            </Step>
          </>
        )}
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
                <span className={`h-2.5 w-2.5 rounded-full ${live && j.state !== 'queued' ? 'hm-breathe bg-indigo-400 shadow-[0_0_10px_#818cf8]' : j.state === 'done' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="font-mono text-sm font-semibold">{j.name}</span>
                <span className={`text-xs ${s.tone}`}>{s.label}</span>
                <span className="ml-auto flex gap-3 text-xs">
                  {live && !['waiting', 'queued'].includes(j.state) && j.backend !== 'hf-jobs' && j.backend !== 'comfyui' && (
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
                  {!live && (
                    <button className="text-slate-500 hover:text-red-400" title="Delete this job and its files" onClick={() => remove(j, false)}>
                      Delete
                    </button>
                  )}
                  {j.state === 'done' && j.kind !== 'image' && (
                    <button className="text-slate-500 hover:text-red-400" title={`Also delete ${j.name} from Ollama`} onClick={() => remove(j, true)}>
                      Delete with model
                    </button>
                  )}
                </span>
              </div>
              <div className="text-[11px] text-slate-500">
                from {j.base} · {j.kind === 'decision' ? 'decision model · ' : ''}
                {j.rows} examples · started {j.startedAt} UTC{j.nightly ? ' · in the training window' : ''}
                {j.backend === 'hf-jobs' && (
                  <>
                    {' '}
                    · ☁ Hugging Face {j.flavor}
                    {j.estimateUsd !== undefined && ` · about $${j.estimateUsd.toFixed(2)}`}
                    {j.jobUrl && (
                      <a className="ml-1 text-indigo-300 hover:text-indigo-200" href={j.jobUrl} target="_blank" rel="noreferrer">
                        job ↗
                      </a>
                    )}
                  </>
                )}
              </div>
              {(live || j.state === 'done') && j.state !== 'queued' && (
                <div className="h-2 overflow-hidden rounded bg-[#21262d]">
                  <div
                    className={`h-full rounded transition-all duration-700 ${j.state === 'done' ? 'bg-emerald-500' : 'bg-gradient-to-r from-indigo-500 to-fuchsia-500'} ${live && !j.totalSteps ? 'hm-flow w-full opacity-60' : ''}`}
                    style={j.totalSteps || j.state === 'done' ? { width: `${pct}%` } : undefined}
                  />
                </div>
              )}
              {(live || j.state === 'paused') && (
                <div className="flex flex-wrap gap-x-4 text-xs text-slate-400">
                  {j.totalSteps ? (
                    <span>
                      step {j.step ?? 0} / {j.totalSteps}
                    </span>
                  ) : null}
                  {j.loss !== undefined && j.loss !== null && <span>loss {Number(j.loss).toFixed(3)}</span>}
                  {j.etaS ? <span>about {dur(j.etaS)} left</span> : null}
                  {j.note && <span className="text-slate-500">{j.note}</span>}
                </div>
              )}
              {j.losses && j.losses.length > 1 && (live || j.state === 'done') && <LossLine losses={j.losses} />}
              {j.sample && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-400">Try-out: what it answered to one example</summary>
                  <div className="mt-1 space-y-1 rounded bg-[#161b22] p-2">
                    <div className="text-slate-500">Input</div>
                    <div className="whitespace-pre-wrap text-slate-300">{j.sample.prompt.slice(0, 600)}</div>
                    <div className="text-slate-500">New model</div>
                    <div className="whitespace-pre-wrap text-emerald-200/90">{j.sample.answer.slice(0, 600)}</div>
                    {j.sample.expected && (
                      <>
                        <div className="text-slate-500">Expected</div>
                        <div className="whitespace-pre-wrap text-slate-400">{j.sample.expected.slice(0, 600)}</div>
                      </>
                    )}
                  </div>
                </details>
              )}
              {j.state === 'done' && (
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-emerald-300/90">
                    {j.kind === 'image'
                      ? `In ComfyUI as ${j.lora ?? j.name}: pick it as the LoRA in an Image block.`
                      : j.kind === 'decision'
                        ? `In Ollama as ${j.name}: pick it under "Ollama decision models" in a Decide block.`
                        : `In Ollama as ${j.name}: pick it as the model of any block, like your other Ollama models.`}
                  </span>
                  {j.publishedUrl ? (
                    <a className="text-indigo-300 hover:text-indigo-200" href={j.publishedUrl} target="_blank" rel="noreferrer">
                      On Hugging Face ↗
                    </a>
                  ) : (
                    info.hf.hasToken &&
                    j.kind !== 'image' && (
                      <button className="text-indigo-300 hover:text-indigo-200" onClick={() => publish(j)}>
                        ⬆ Publish to Hugging Face
                      </button>
                    )
                  )}
                </div>
              )}
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
