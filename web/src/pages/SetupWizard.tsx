import type { ModelInfo, ModelRef, OllamaPick, ProviderInfo, PullJob } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { BuilderModelChooser, recommendBuilderModels } from '../canvas/BuilderModelChooser';
import { toast } from '../notify';

const STEPS = ['Welcome', 'Your AIs', 'Builder', 'Ready'] as const;

/** First-run tour: what HiveMind is, what is connected, and which model the Builder uses. */
export function SetupWizard({ onDone, onOpen }: { onDone: () => void; onOpen: (tab: 'canvas' | 'settings') => void }) {
  const [step, setStep] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [builder, setBuilder] = useState<ModelRef | undefined>();

  const loadModels = async () => {
    const [m, p, prefs] = await Promise.all([
      api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).catch(() => ({ models: [] })),
      api<ProviderInfo[]>('/api/providers', { quiet: true }).catch(() => []),
      api<{ builderModel?: ModelRef }>('/api/me/prefs', { quiet: true }).catch(() => ({}) as { builderModel?: ModelRef }),
    ]);
    setModels(m.models);
    setProviders(p);
    setBuilder(prefs.builderModel);
  };
  useEffect(() => {
    loadModels();
  }, []);

  const finish = async (tab?: 'canvas' | 'settings') => {
    await api('/api/me/prefs', { method: 'PUT', body: { setupDone: true } }).catch(() => {});
    onDone();
    if (tab) onOpen(tab);
  };

  const local = models.filter((m) => (m.sizeBytes ?? 0) > 50e6);
  const cloud = models.filter((m) => m.sizeBytes === undefined);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-[#30363d] bg-[#161b22] shadow-2xl">
        <div className="flex gap-1 px-6 pt-5">
          {STEPS.map((s, i) => (
            <div key={s} className={`h-1 flex-1 rounded ${i <= step ? 'bg-indigo-500' : 'bg-[#30363d]'}`} />
          ))}
        </div>
        <div className="space-y-4 p-6">
          {step === 0 && (
            <>
              <div className="flex items-center gap-3">
                <img src="/icon.svg" className="h-10 w-10" alt="" />
                <h2 className="text-xl font-semibold">Welcome to HiveMind</h2>
              </div>
              <p className="text-slate-300">
                HiveMind lets several AIs work on one question together: they answer, review each other, debate or vote, and a judge writes the
                final answer — and you watch it happen live.
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
                <li>
                  <b className="text-slate-200">Workflow</b>: wire AI blocks together, or let the <b className="text-slate-200">Builder</b> do it from a sentence.
                </li>
                <li>
                  <b className="text-slate-200">Use</b>: the simple screen — pick a canvas, ask, get the answer.
                </li>
                <li>
                  <b className="text-slate-200">Settings</b>: connect free and paid AIs, download local models.
                </li>
              </ul>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="text-xl font-semibold">Your AIs</h2>
              <div className="space-y-2">
                {providers.map((p) => {
                  const n = models.filter((m) => m.providerId === p.id && !((m.sizeBytes ?? 1e9) < 50e6)).length;
                  return (
                    <div key={p.id} className="flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 text-sm">
                      <span className={`h-2 w-2 rounded-full ${n ? 'bg-emerald-400' : 'bg-red-500'}`} />
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-auto text-xs text-slate-400">{n ? `${n} models` : 'not reachable'}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-sm text-slate-400">
                {local.length} local and {cloud.length} cloud models are ready. Free cloud AIs (OpenRouter, Groq, Gemini) only need a free key —
                add them any time in Settings → AI providers.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="text-xl font-semibold">Pick the Builder’s model</h2>
              <p className="text-sm text-slate-400">
                The Builder turns “I want three models and a judge” into a canvas. Mid-size models (4–9B) work well; you can change this later in
                Settings.
              </p>
              {recommendBuilderModels(models).length === 0 && <DownloadSuggestion onInstalled={loadModels} />}
              <BuilderModelChooser
                models={models}
                providers={providers}
                value={builder}
                onPick={async (m) => {
                  await api('/api/me/prefs', { method: 'PUT', body: { builderModel: m } });
                  setBuilder(m);
                  toast(`The Builder uses ${m.model}`, 'ok');
                }}
              />
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="text-xl font-semibold">You’re ready</h2>
              <p className="text-slate-300">
                Open the Workflow and click <b>✨ Builder</b> on the right. Try: <i>“Three local models answer, a judge merges the best parts”</i>.
              </p>
              {!builder && <p className="text-sm text-amber-300">No Builder model picked yet — you can do that in the Builder tab later.</p>}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[#30363d] px-6 py-4">
          <button className="text-sm text-slate-500 hover:text-slate-300" onClick={() => finish()}>
            Skip setup
          </button>
          {step > 0 && (
            <button className="btn-ghost ml-auto" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className={`btn ${step === 0 ? 'ml-auto' : ''}`} onClick={() => setStep(step + 1)}>
              {step === 2 && !builder ? 'Skip for now' : 'Next'}
            </button>
          ) : (
            <button className="btn" onClick={() => finish('canvas')}>
              Open the Workflow
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** No model fits the Builder yet: offer the most popular recent mid-size model for this GPU. */
function DownloadSuggestion({ onInstalled }: { onInstalled: () => void }) {
  const [pick, setPick] = useState<OllamaPick | null>(null);
  const [job, setJob] = useState<PullJob | null>(null);
  useEffect(() => {
    api<OllamaPick[]>('/api/ollama/picks', { quiet: true })
      .then((ps) => setPick(ps.filter((p) => p.estBytes > 2.5e9 && p.estBytes < 7e9 && p.capabilities.includes('tools')).sort((a, b) => b.score - a.score)[0] ?? null))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const t = setInterval(async () => {
      const j = (await api<PullJob[]>('/api/ollama/pulls', { quiet: true }).catch(() => [])).find((x) => x.id === job.id);
      if (j) setJob(j);
      if (j?.state === 'done') onInstalled();
    }, 1000);
    return () => clearInterval(t);
  }, [job?.id, job?.state]);
  if (!pick) return null;
  const pct = job?.totalBytes ? Math.round(((job.doneBytes ?? 0) / job.totalBytes) * 100) : 0;
  return (
    <div className="space-y-2 rounded-lg border border-indigo-800 bg-indigo-950/30 p-3 text-sm">
      <div>
        No local model of the right size yet. Recommended: <b>{pick.pullName}</b> (~{(pick.estBytes / 1e9).toFixed(1)} GB).
      </div>
      {job ? (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded bg-[#21262d]">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${job.state === 'done' ? 100 : pct}%` }} />
          </div>
          <div className="text-xs text-slate-400">{job.state === 'running' ? `${job.status} ${pct}%` : job.state === 'done' ? 'Installed' : job.error}</div>
        </div>
      ) : (
        <button className="btn" onClick={async () => setJob(await api<PullJob>('/api/ollama/ollama/pull', { body: { model: pick.pullName } }))}>
          Download it
        </button>
      )}
    </div>
  );
}
