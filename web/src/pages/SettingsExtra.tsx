import { SEARCH_SOURCES, type HfSettings, type HomeAssistantSettings, type ModelInfo, type VoiceSettings, type ModelRef, type ProviderInfo, type SearchSettings, type SearchSource, type TrainWindow, type RunLimits } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { BuilderModelChooser } from '../canvas/BuilderModelChooser';
import { toast } from '../notify';
import { loadVoice, MicButton, SpeakButton } from '../voice';
import { ModelPicker } from '../canvas/ModelPicker';

/** Settings → Builder AI: the model that turns requests into canvases, and the setup wizard. */
export function BuilderSettings({ active, onWizard }: { active: boolean; onWizard: () => void }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [model, setModel] = useState<ModelRef | undefined>();
  useEffect(() => {
    if (!active) return;
    api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).then((r) => setModels(r.models)).catch(() => {});
    api<ProviderInfo[]>('/api/providers', { quiet: true }).then(setProviders).catch(() => {});
    api<{ builderModel?: ModelRef }>('/api/me/prefs', { quiet: true }).then((p) => setModel(p.builderModel)).catch(() => {});
  }, [active]);
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Builder AI</h2>
      <p className="text-sm text-slate-400">
        The Builder (✨ on the Workflow) turns what you ask into a workflow. It writes a small plan, so mid-size models (4–9B local, or a cloud model)
        work best. Now: <span className="text-slate-200">{model?.model ?? 'not chosen'}</span>
      </p>
      <BuilderModelChooser
        models={models}
        providers={providers}
        value={model}
        onPick={async (m) => {
          await api('/api/me/prefs', { method: 'PUT', body: { builderModel: m } });
          setModel(m);
          toast(`The Builder now uses ${m.model}`, 'ok');
        }}
      />
      <button className="btn-ghost" onClick={onWizard}>
        Show the setup wizard again
      </button>
    </div>
  );
}

const SOURCE_INFO: Record<SearchSource, string> = {
  wikipedia: 'Free, no key. Great for facts; not for news or shopping.',
  duckduckgo: 'Free, no key: the whole web (docs, Stack Overflow, GitHub). Good for code and how-tos; may refuse when asked very often.',
  brave: 'Real web search. Free plan with a key from brave.com/search/api.',
  tavily: 'Search made for AI. Free monthly credits with a key from tavily.com.',
  searxng: 'Your own self-hosted meta search (e.g. a SearXNG container on Unraid). JSON output must be enabled.',
};

/** Settings → Web search: the default source for Web search blocks, keys, and a test. */
export function SearchSettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [s, setS] = useState<SearchSettings | null>(null);
  const [brave, setBrave] = useState('');
  const [tavily, setTavily] = useState('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<{ title: string; url: string }[] | null>(null);

  useEffect(() => {
    api<SearchSettings>('/api/settings/search', { quiet: true }).then(setS).catch(() => {});
  }, []);
  if (!s) return null;

  const save = async (patch: Partial<SearchSettings> & { braveKey?: string; tavilyKey?: string }) => {
    setS(await api<SearchSettings>('/api/settings/search', { method: 'PUT', body: patch }));
    toast('Web search settings saved', 'ok');
  };

  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Web search</h2>
      <p className="text-sm text-slate-400">Used by Web search blocks that don’t pick their own source.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {SEARCH_SOURCES.map((src) => (
          <button
            key={src}
            disabled={!isAdmin}
            className={`rounded-lg border px-3 py-2 text-left ${s.source === src ? 'border-blue-500 bg-blue-500/10' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
            onClick={() => save({ source: src })}
          >
            <div className="text-sm font-medium capitalize">{src === 'searxng' ? 'SearXNG' : src}</div>
            <div className="text-xs text-slate-400">{SOURCE_INFO[src]}</div>
          </button>
        ))}
      </div>
      {isAdmin && (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Wikipedia language</span>
            <input className="input w-24 py-1" defaultValue={s.wikiLang} onBlur={(e) => e.target.value !== s.wikiLang && save({ wikiLang: e.target.value })} />
            <span className="text-xs text-slate-500">en, nl, de, …</span>
          </label>
          <div className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Brave key</span>
            <input className="input py-1" type="password" placeholder={s.hasBraveKey ? 'saved — type to replace' : 'API key'} value={brave} onChange={(e) => setBrave(e.target.value)} />
            <button className="btn-ghost" disabled={!brave} onClick={() => save({ braveKey: brave }).then(() => setBrave(''))}>
              Save
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Tavily key</span>
            <input className="input py-1" type="password" placeholder={s.hasTavilyKey ? 'saved — type to replace' : 'API key'} value={tavily} onChange={(e) => setTavily(e.target.value)} />
            <button className="btn-ghost" disabled={!tavily} onClick={() => save({ tavilyKey: tavily }).then(() => setTavily(''))}>
              Save
            </button>
          </div>
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">SearXNG address</span>
            <input
              className="input py-1"
              placeholder="http://192.168.1.10:8888"
              defaultValue={s.searxngUrl ?? ''}
              onBlur={(e) => e.target.value !== (s.searxngUrl ?? '') && save({ searxngUrl: e.target.value })}
            />
          </label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          className="btn-ghost"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setResults(null);
            try {
              setResults(await api<{ title: string; url: string }[]>('/api/settings/search/test', { body: { q: 'Eiffel Tower' } }));
            } catch {
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? 'Searching…' : 'Test search'}
        </button>
        {results && <span className="text-xs text-emerald-400">{results.length} results</span>}
      </div>
      {results?.map((r) => (
        <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-indigo-400 hover:underline">
          {r.title}
        </a>
      ))}
    </div>
  );
}

/** Settings → Memory: what Memory blocks have saved, per name. */
export function MemorySettings({ active }: { active: boolean }) {
  const [keys, setKeys] = useState<{ key: string; count: number; last: string }[]>([]);
  const load = () => api<typeof keys>('/api/memory/keys', { quiet: true }).then(setKeys).catch(() => {});
  useEffect(() => {
    if (active) load();
  }, [active]);
  return (
    <div className="card max-w-2xl space-y-2">
      <h2 className="font-semibold">Memory</h2>
      <p className="text-sm text-slate-400">What your Memory blocks remembered. Clearing a name makes those blocks start fresh.</p>
      {keys.length === 0 && <p className="text-sm text-slate-500">Nothing remembered yet.</p>}
      {keys.map((k) => (
        <div key={k.key} className="flex items-center gap-2 border-t border-[#30363d] pt-2 text-sm">
          <span className="font-medium">{k.key}</span>
          <span className="text-xs text-slate-500">
            {k.count} saved · last {new Date(k.last.replace(' ', 'T') + 'Z').toLocaleString()}
          </span>
          <button
            className="btn-ghost ml-auto text-red-400"
            onClick={async () => {
              if (!confirm(`Forget everything saved under "${k.key}"?`)) return;
              await api(`/api/memory/keys/${encodeURIComponent(k.key)}`, { method: 'DELETE' });
              load();
            }}
          >
            Clear
          </button>
        </div>
      ))}
    </div>
  );
}

/** A code block with a Copy button. */
export function CopyBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-[#30363d] bg-[#0d1117] p-3 pr-16 text-xs text-slate-300">{text}</pre>
      <button
        className="btn-ghost absolute top-1.5 right-1.5 px-2 py-0.5 text-xs"
        onClick={() =>
          navigator.clipboard
            .writeText(text)
            .then(() => toast('Copied', 'ok'))
            .catch(() => toast('Copy failed: the browser only allows copying on HTTPS or localhost. Select the text instead.'))
        }
      >
        Copy
      </button>
    </div>
  );
}

/** Settings → OpenAI API: every saved canvas is a model for any OpenAI-compatible app. */
export function OpenAIApiSettings({ active, onTokens }: { active: boolean; onTokens: () => void }) {
  const [models, setModels] = useState<{ id: string; name: string; slug: string }[]>([]);
  useEffect(() => {
    if (!active) return;
    fetch('/v1/models')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setModels(d.data))
      .catch((err) => toast(`Could not list the workflows: ${(err as Error).message}`));
  }, [active]);
  const base = `${location.origin}/v1`;
  const model = models[0]?.id ?? '<canvas id>';
  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer hm_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello!"}]}'`;
  const python = `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="hm_YOUR_TOKEN")
reply = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`;
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">OpenAI-compatible API</h2>
      <p className="text-sm text-slate-400">
        Every saved workflow works as a “model” for apps that speak the OpenAI API (Home Assistant, Open WebUI, scripts). The last user message is the
        question, the Final answer is the reply. Streaming works too. Log in with an{' '}
        <button className="text-indigo-400 hover:underline" onClick={onTokens}>
          API token
        </button>
        .
      </p>
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-300">Base URL</div>
        <CopyBlock text={base} />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-300">Your workflows (model ids)</div>
        {models.length === 0 && <p className="text-sm text-slate-500">No saved workflows yet.</p>}
        {models.map((m) => (
          <div key={m.id} className="flex items-center gap-2 border-t border-[#30363d] pt-1 text-sm">
            <span className="font-medium">{m.name}</span>
            <code className="ml-auto text-xs text-slate-400">{m.id}</code>
          </div>
        ))}
        {models.length > 0 && <p className="text-xs text-slate-500">The name as a slug works too, e.g. “{models[0].slug}”.</p>}
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-300">Example (curl)</div>
        <CopyBlock text={curl} />
      </div>
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-300">Example (Python, openai package)</div>
        <CopyBlock text={python} />
      </div>
    </div>
  );
}

/** Settings → Home Assistant: the address and long-lived token used by Home Assistant blocks. */
export function HomeAssistantPanel({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
  const [s, setS] = useState<HomeAssistantSettings | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (!active) return;
    api<HomeAssistantSettings>('/api/settings/homeassistant', { quiet: true })
      .then((r) => {
        setS(r);
        setUrl(r.url ?? '');
      })
      .catch(() => {});
  }, [active]);
  if (!s) return null;
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const list = await api<unknown[]>('/api/homeassistant/entities', { quiet: true });
      setTest({ ok: true, text: `Connected — ${list.length} entities` });
    } catch (err) {
      setTest({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    const next = await api<HomeAssistantSettings>('/api/settings/homeassistant', { method: 'PUT', body: { url, ...(token && { token }) } });
    setS(next);
    setToken('');
    toast('Home Assistant settings saved', 'ok');
    if (next.url && next.hasToken) runTest();
  };
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Home Assistant</h2>
      <p className="text-sm text-slate-400">
        For Home Assistant blocks (read sensors, switch lights, send notifications). In Home Assistant: your profile → Security → Long-lived access
        tokens → Create token. The token is stored encrypted. To use HiveMind <em>from</em> Home Assistant, install the HiveMind integration (see the
        README) with an API token from Settings → API tokens.
      </p>
      {isAdmin ? (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Address</span>
            <input className="input py-1" placeholder="http://192.168.1.20:8123" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Token</span>
            <input
              className="input py-1"
              type="password"
              placeholder={s.hasToken ? 'saved — type to replace' : 'long-lived access token'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => save().catch(() => {})}>
              Save
            </button>
            {s.hasToken && (
              <button
                className="btn-ghost text-red-400"
                onClick={async () => {
                  setS(await api<HomeAssistantSettings>('/api/settings/homeassistant', { method: 'PUT', body: { token: '' } }));
                  setTest(null);
                }}
              >
                Remove token
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400">{s.url ? `Connected to ${s.url}` : 'Not connected yet'} — only an admin can change this.</p>
      )}
      <div className="flex items-center gap-2">
        <button className="btn-ghost" disabled={testing || !s.url || !s.hasToken} onClick={runTest}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {test && <span className={`text-xs ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>{test.text}</span>}
      </div>
    </div>
  );
}

/** Settings → Hugging Face: one account for cloud training (HF Jobs, with a daily spending limit) and publishing models. */
export function HuggingFacePanel({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
  const [s, setS] = useState<HfSettings | null>(null);
  const [token, setToken] = useState('');
  const [budget, setBudget] = useState('');
  useEffect(() => {
    if (!active) return;
    api<{ settings: HfSettings }>('/api/hf', { quiet: true })
      .then((r) => {
        setS(r.settings);
        setBudget(String(r.settings.dailyBudgetUsd));
      })
      .catch(() => {});
  }, [active]);
  if (!s) return null;
  const save = async (body: { token?: string; dailyBudgetUsd?: number }) => {
    try {
      const next = await api<HfSettings>('/api/settings/huggingface', { method: 'PUT', body });
      setS(next);
      setToken('');
      toast(next.hasToken ? `Hugging Face connected as ${next.user}` : 'Hugging Face disconnected', 'ok');
    } catch {}
  };
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Hugging Face</h2>
      <p className="text-sm text-slate-400">
        Rent a bigger GPU for one training job (Hugging Face Jobs, paid per minute on your Hugging Face account), and publish models you made. Make an access
        token with <em>write</em> rights at huggingface.co → Settings → Access Tokens; it is stored encrypted. Every cloud job shows its price first and starts only
        after you confirm it. For teacher models (Generate examples), add the &quot;Hugging Face (Inference Providers)&quot; provider under AI providers.
      </p>
      <div className="text-sm">
        {s.hasToken ? (
          <span className="text-emerald-300">Connected as {s.user}</span>
        ) : (
          <span className="text-slate-400">Not connected</span>
        )}
        <span className="ml-3 text-xs text-slate-500">
          Cloud training today: ${s.spentTodayUsd.toFixed(2)} of ${s.dailyBudgetUsd.toFixed(2)}
        </span>
      </div>
      {isAdmin ? (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Access token</span>
            <input className="input py-1" type="password" placeholder={s.hasToken ? 'saved — type to replace' : 'hf_…'} value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-slate-400">Daily limit ($)</span>
            <input className="input w-28 py-1" type="number" min={0} step={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
            <span className="text-xs text-slate-500">0 = no cloud training</span>
          </label>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => save({ ...(token && { token }), dailyBudgetUsd: Number(budget) })}>
              Save
            </button>
            {s.hasToken && (
              <button className="btn-ghost text-red-400" onClick={() => save({ token: '' })}>
                Disconnect
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400">Only an admin can connect Hugging Face or change the limit.</p>
      )}
    </div>
  );
}

const STT_PRESETS = [
  { name: 'Groq Whisper (free)', url: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', note: 'Free with your Groq key — reused from the Groq provider if you added one.' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', note: 'Paid. Reuses the OpenAI provider key if you added one.' },
  { name: 'Local (speaches / faster-whisper)', url: 'http://192.168.1.10:8000/v1', model: 'Systran/faster-whisper-small', note: 'Runs on your own server, e.g. the speaches container. Change the address.' },
];
const TTS_PRESETS = [
  { name: 'OpenAI TTS', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', note: 'Paid, natural voices.' },
  { name: 'Kokoro (local)', url: 'http://192.168.1.10:8880/v1', model: 'kokoro', voice: 'af_bella', note: 'Kokoro-FastAPI container on your server. Change the address.' },
  { name: 'Piper / openedai-speech (local)', url: 'http://192.168.1.10:8000/v1', model: 'tts-1', voice: 'alloy', note: 'Any OpenAI-compatible speech server. Change the address.' },
];

/** Settings → Voice: speech to text for the mic buttons, text to speech for “Read aloud”. */
/** Settings → Voice: one voice agent for all canvases — a decision model picks the canvas per request. */
function CanvasRouterCard({ active }: { active: boolean }) {
  const [pref, setPref] = useState<ModelRef | undefined | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    api<{ canvasRouter?: ModelRef }>('/api/me/prefs', { quiet: true }).then((p) => setPref(p.canvasRouter)).catch(() => setPref(undefined));
    api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).then((r) => setModels(r.models)).catch(() => {});
    api<ProviderInfo[]>('/api/providers', { quiet: true }).then(setProviders).catch(() => {});
  }, [active]);
  if (pref === null) return null;
  const decisions = models.filter((m) => m.kind === 'decision');
  const save = async (canvasRouter: ModelRef | null) => {
    const p = await api<{ canvasRouter?: ModelRef }>('/api/me/prefs', { method: 'PUT', body: { canvasRouter } });
    setPref(p.canvasRouter);
    toast(p.canvasRouter ? 'Spoken questions now go to the workflow Jev picks' : 'Workflow router off', 'ok');
  };
  return (
    <div className="card max-w-2xl space-y-2">
      <h2 className="font-semibold">Workflow router ⚡ (optional)</h2>
      <p className="text-sm text-slate-400">
        A decision model reads each spoken question and picks the workflow it belongs to (by name and description), in about 0.1 s. Works for the mic in Use mode and for
        Home Assistant: use the model <code>auto</code> in the OpenAI-compatible API.
      </p>
      {decisions.length === 0 ? (
        <p className="text-xs text-amber-300">Add a decision provider first (Settings → Providers → Decisions).</p>
      ) : (
        <>
          <ModelPicker kind="decision" models={models} providers={providers} value={pref} onChange={(m) => save(m)} />
          {pref && (
            <button className="btn-ghost text-red-400" onClick={() => save(null)}>
              Turn off
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function VoicePanel(props: { isAdmin: boolean; active: boolean }) {
  return (
    <div className="space-y-4">
      <VoiceSettingsPanel {...props} />
      <CanvasRouterCard active={props.active} />
    </div>
  );
}

interface WhisperStatus {
  available: boolean;
  models: { id: string; name: string; sizeMb: number; note: string; downloaded: boolean; downloading?: { got: number; total: number }; selected: boolean }[];
}

/** The built-in Whisper model library: download any, delete, and pick the one to use (one at a time). */
function WhisperLibrary({ isAdmin, selected, onSelect }: { isAdmin: boolean; selected: string; onSelect: (id: string) => void }) {
  const [st, setSt] = useState<WhisperStatus | null>(null);
  const load = () => api<WhisperStatus>('/api/voice/whisper', { quiet: true }).then(setSt).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  // While anything downloads, poll for progress.
  useEffect(() => {
    if (!st?.models.some((m) => m.downloading)) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [st]);
  if (!st) return null;
  return (
    <div className="space-y-1">
      {st.models.map((m) => {
        const isSel = m.id === selected;
        const pct = m.downloading ? Math.min(99, Math.round((m.downloading.got / Math.max(1, m.downloading.total)) * 100)) : 0;
        return (
          <div key={m.id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${isSel && m.downloaded ? 'border-indigo-500 bg-indigo-500/10' : 'border-[#30363d]'}`}>
            <button
              className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
              disabled={!m.downloaded}
              title={m.downloaded ? 'Use this model' : 'Download it first'}
              onClick={() => m.downloaded && onSelect(m.id)}
            >
              <div className="text-sm font-medium">
                {m.name} <span className="text-xs font-normal text-slate-500">· ~{m.sizeMb >= 1024 ? `${(m.sizeMb / 1024).toFixed(1)} GB` : `${m.sizeMb} MB`}</span>
                {isSel && m.downloaded && <span className="ml-1 text-xs text-indigo-300">· in use</span>}
              </div>
              <div className="truncate text-xs text-slate-400">{m.note}</div>
            </button>
            {m.downloading ? (
              <div className="w-28 shrink-0">
                <div className="h-1.5 overflow-hidden rounded bg-[#0d1117]">
                  <div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-center text-[10px] text-slate-500">{pct}%</div>
              </div>
            ) : m.downloaded ? (
              isAdmin && (
                <button
                  className="btn-ghost shrink-0 px-2 py-0.5 text-xs text-red-300"
                  title="Delete this model"
                  onClick={async () => {
                    await api(`/api/voice/whisper/${m.id}`, { method: 'DELETE' }).catch(() => {});
                    load();
                  }}
                >
                  Delete
                </button>
              )
            ) : (
              isAdmin && (
                <button
                  className="btn shrink-0 px-2 py-0.5 text-xs"
                  onClick={async () => {
                    await api(`/api/voice/whisper/${m.id}/download`, { method: 'POST' }).catch(() => {});
                    load();
                  }}
                >
                  Download
                </button>
              )
            )}
          </div>
        );
      })}
      {!st.models.some((m) => m.downloaded) && <p className="text-xs text-amber-300">Download a model to use the built-in engine.</p>}
    </div>
  );
}

function VoiceSettingsPanel({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
  const [s, setS] = useState<VoiceSettings | null>(null);
  const [draft, setDraft] = useState<Partial<VoiceSettings> & { sttKey?: string; ttsKey?: string }>({});
  const [heard, setHeard] = useState('');
  /** Voices for apps as typed (lines), until saved. */
  const [voicesText, setVoicesText] = useState<string>();
  useEffect(() => {
    if (!active) return;
    loadVoice(true).then((v) => {
      setS(v);
      setDraft({});
      setVoicesText(undefined);
    });
  }, [active]);
  if (!s) return null;
  const v = { ...s, ...draft };
  const set = (patch: typeof draft) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    const next = await api<VoiceSettings>('/api/settings/voice', { method: 'PUT', body: draft });
    setS(next);
    setDraft({});
    setVoicesText(undefined);
    loadVoice(true);
    toast('Voice settings saved', 'ok');
  };
  const field = (label: string, key: 'sttUrl' | 'sttModel' | 'sttLanguage' | 'ttsUrl' | 'ttsModel' | 'ttsVoice', placeholder: string) => (
    <label className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-slate-400">{label}</span>
      <input className="input py-1" disabled={!isAdmin} placeholder={placeholder} value={v[key] ?? ''} onChange={(e) => set({ [key]: e.target.value })} />
    </label>
  );
  const keyField = (key: 'sttKey' | 'ttsKey', has: boolean) => (
    <label className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-slate-400">API key</span>
      <input
        className="input py-1"
        type="password"
        disabled={!isAdmin}
        placeholder={has ? 'saved — type to replace' : 'optional (local servers need none; a provider on the same address lends its key)'}
        value={draft[key] ?? ''}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="card max-w-2xl space-y-4">
      <div>
        <h2 className="font-semibold">Voice</h2>
        <p className="text-sm text-slate-400">
          The 🎤 buttons (Use mode and the Question block) record you and turn speech into the question; 🔊 Read aloud speaks answers. The microphone
          only works over https or on localhost — on plain http the button lets you pick or record an audio file instead.
        </p>
      </div>

      <section className="space-y-2 text-sm">
        <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Speech to text</div>
        {v.builtinStt && (
          <div className="flex gap-1">
            {(['builtin', 'server'] as const).map((m) => (
              <button
                key={m}
                disabled={!isAdmin}
                className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${(v.sttEngine ?? 'builtin') === m ? 'border-indigo-500 bg-indigo-500/15 text-indigo-100' : 'border-[#30363d] text-slate-400'}`}
                onClick={() => set({ sttEngine: m })}
              >
                {m === 'builtin' ? 'Built-in (local Whisper, inside HiveMind)' : 'Speech server (OpenAI-compatible)'}
              </button>
            ))}
          </div>
        )}
        {v.builtinStt && (v.sttEngine ?? 'builtin') === 'builtin' ? (
          <>
            <p className="text-xs text-slate-400">
              Whisper runs inside HiveMind on the processor — no server to set up. Download a model, then pick it. Bigger models are more accurate but slower and larger.
            </p>
            <WhisperLibrary isAdmin={isAdmin} selected={v.whisperModel ?? 'base'} onSelect={(id) => set({ sttEngine: 'builtin', whisperModel: id })} />
            {field('Language', 'sttLanguage', 'empty = detect; or en, nl, de…')}
          </>
        ) : (
          <>
            {isAdmin && (
              <div className="grid gap-2 sm:grid-cols-3">
                {STT_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    className={`rounded-lg border px-3 py-2 text-left ${v.sttUrl === p.url ? 'border-indigo-500 bg-indigo-500/10' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
                    onClick={() => set({ sttEngine: 'server', sttUrl: p.url, sttModel: p.model })}
                  >
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-slate-400">{p.note}</div>
                  </button>
                ))}
              </div>
            )}
            {field('Address', 'sttUrl', 'https://api.groq.com/openai/v1 (empty = off)')}
            {field('Model', 'sttModel', 'whisper-large-v3-turbo')}
            {field('Language', 'sttLanguage', 'empty = detect; or en, nl, de…')}
            {keyField('sttKey', s.hasSttKey)}
          </>
        )}
      </section>

      <section className="space-y-2 text-sm">
        <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Text to speech</div>
        <div className="flex gap-1">
          {(v.builtinTts ? (['browser', 'builtin', 'server'] as const) : (['browser', 'server'] as const)).map((m) => (
            <button
              key={m}
              disabled={!isAdmin}
              className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${v.ttsMode === m ? 'border-indigo-500 bg-indigo-500/15 text-indigo-100' : 'border-[#30363d] text-slate-400'}`}
              onClick={() => set({ ttsMode: m })}
            >
              {m === 'browser' ? 'Browser voice (free, built in)' : m === 'builtin' ? 'HiveMind voice (Kokoro, inside HiveMind)' : 'Speech server (OpenAI-compatible)'}
            </button>
          ))}
        </div>
        {v.ttsMode === 'builtin' && (
          <>
            <p className="text-xs text-slate-400">
              Kokoro runs inside HiveMind on the processor (about a second per sentence). The first time a voice is needed it downloads its model (350 MB), then it starts by
              itself when something speaks and stops after 30 minutes of quiet. Apps with an API token also get this voice when no speech server is set.
            </p>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">Voice</span>
              <select className="input" disabled={!isAdmin} value={v.ttsVoice && v.builtinVoices?.includes(v.ttsVoice) ? v.ttsVoice : 'af_heart'} onChange={(e) => set({ ttsVoice: e.target.value })}>
                {(v.builtinVoices ?? []).map((id) => (
                  <option key={id} value={id}>
                    {id} · {id[0] === 'a' ? 'American' : 'British'} {id[1] === 'f' ? 'woman' : 'man'}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {v.ttsMode === 'server' && (
          <>
            {isAdmin && (
              <div className="grid gap-2 sm:grid-cols-3">
                {TTS_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    className={`rounded-lg border px-3 py-2 text-left ${v.ttsUrl === p.url && v.ttsModel === p.model ? 'border-indigo-500 bg-indigo-500/10' : 'border-[#30363d] bg-[#0d1117] hover:border-slate-500'}`}
                    onClick={() => set({ ttsUrl: p.url, ttsModel: p.model, ttsVoice: p.voice })}
                  >
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-slate-400">{p.note}</div>
                  </button>
                ))}
              </div>
            )}
            {field('Address', 'ttsUrl', 'http://192.168.1.10:8880/v1')}
            {field('Model', 'ttsModel', 'tts-1')}
            {field('Voice', 'ttsVoice', 'alloy')}
            {keyField('ttsKey', s.hasTtsKey)}
          </>
        )}
      </section>

      <VoiceEngine isAdmin={isAdmin} />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Voices for apps</h3>
        <p className="text-xs text-slate-400">
          Apps like HiveBot ask for a voice by name (<code>{'{"voice": "jarvis"}'}</code> on <code>/api/voice/speak</code>). One per line: <code>name = voice of the speech server</code>. Apps with an API
          token use the speech server above even when the screen uses the browser voice.
        </p>
        <textarea
          className="input min-h-20 font-mono text-xs"
          disabled={!isAdmin}
          placeholder={'jev = af_heart\njarvis = bm_george\nultron = am_onyx\nvision = bf_emma'}
          value={voicesText ?? Object.entries(v.appVoices ?? {}).map(([n, id]) => `${n} = ${id}`).join('\n')}
          onChange={(e) => {
            setVoicesText(e.target.value);
            const map: Record<string, string> = {};
            for (const line of e.target.value.split('\n')) {
              const m = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);
              if (m) map[m[1].toLowerCase()] = m[2];
            }
            set({ appVoices: map });
          }}
        />
      </section>

      {isAdmin && (
        <div className="flex items-center gap-2">
          <button className="btn" disabled={!dirty} onClick={() => save().catch(() => {})}>
            Save
          </button>
          {dirty && (
            <button className="btn-ghost" onClick={() => setDraft({})}>
              Undo changes
            </button>
          )}
          {dirty && <span className="text-xs text-amber-300">Save before testing</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-[#30363d] pt-3">
        <MicButton size="sm" onText={setHeard} disabled={dirty} />
        <span className="text-xs text-slate-400">Test the microphone</span>
        <SpeakButton text="Hello! This is how HiveMind sounds when it reads an answer aloud." />
        {heard && <span className="w-full text-sm text-emerald-300">Heard: “{heard}”</span>}
      </div>
    </div>
  );
}

/** Settings → Training: the training window. Nightly jobs, and jobs a scheduled run starts, only train inside it. */
export function TrainingPanel({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
  const [w, setW] = useState<TrainWindow | null>(null);
  const [start, setStart] = useState('03:00');
  const [end, setEnd] = useState('08:00');
  useEffect(() => {
    if (!active) return;
    api<TrainWindow>('/api/lab/window', { quiet: true })
      .then((x) => {
        setW(x);
        setStart(x.start);
        setEnd(x.end);
      })
      .catch(() => {});
  }, [active]);
  if (!w) return null;
  const save = async () => {
    try {
      const next = await api<TrainWindow>('/api/settings/training', { method: 'PUT', body: { start, end } });
      setW(next);
      toast(`Training window: ${next.start}–${next.end}`, 'ok');
    } catch {}
  };
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Training</h2>
      <p className="text-sm text-slate-400">
        The training window: jobs marked &quot;only in the training window&quot; (and every job a scheduled workflow starts) wait as <em>queued</em> until it opens, and
        pause with a checkpoint when it closes — they go on in the next window. Training takes the GPU, so pick hours nobody uses it. Server time; a window may
        cross midnight (22:00–06:00).
      </p>
      <div className="text-sm">
        {w.open ? <span className="text-emerald-300">Open now</span> : <span className="text-slate-400">Closed now</span>}
        <span className="ml-2 text-xs text-slate-500">
          {w.start}–{w.end}
        </span>
      </div>
      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-400">From</span>
          <input className="input w-28 py-1" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <span className="text-slate-400">to</span>
          <input className="input w-28 py-1" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          <button className="btn" disabled={start === w.start && end === w.end} onClick={save}>
            Save
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">Only an admin can change it.</p>
      )}
    </div>
  );
}

/** Settings → Run limits: how long one model call may take, and what local models get when a block sets nothing. */
export function RunLimitsPanel({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
  const [saved, setSaved] = useState<RunLimits | null>(null);
  const [form, setForm] = useState<RunLimits | null>(null);
  useEffect(() => {
    if (!active) return;
    api<RunLimits>('/api/settings/run-limits', { quiet: true })
      .then((x) => {
        setSaved(x);
        setForm(x);
      })
      .catch(() => {});
  }, [active]);
  if (!saved || !form) return null;
  const changed = (Object.keys(form) as (keyof RunLimits)[]).some((k) => form[k] !== saved[k]);
  const save = async () => {
    try {
      const next = await api<RunLimits>('/api/settings/run-limits', { method: 'PUT', body: form });
      setSaved(next);
      setForm(next);
      toast('Run limits saved', 'ok');
    } catch {}
  };
  const field = (k: keyof RunLimits, label: string, help: string, min: number, max: number) => (
    <label className="block space-y-1">
      <span className="block text-sm font-medium">{label}</span>
      <input
        className="input w-40 py-1"
        type="number"
        min={min}
        max={max}
        disabled={!isAdmin}
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
      />
      <span className="block text-xs text-slate-500">{help}</span>
    </label>
  );
  return (
    <div className="card max-w-2xl space-y-3">
      <h2 className="font-semibold">Run limits</h2>
      <p className="text-sm text-slate-400">
        A local model that loops can hold the GPU for a long time, and every other run waits behind it. These limits stop it. Time spent waiting for the GPU does not
        count; loading a cold model does. A block&apos;s own setting always wins.
      </p>
      {field('maxSeconds', 'Time limit per model call (seconds)', 'Every model call, local and cloud. 10 to 86400; default 600.', 10, 86400)}
      {field('maxTokens', 'Token ceiling for local models', 'For blocks without their own "Max tokens". Thinking counts too. 16 to 32768; default 4096.', 16, 32768)}
      {field('numCtx', 'Context size for local models', 'For blocks without their own context size. 2048 to 131072; default 16384.', 2048, 131072)}
      {isAdmin ? (
        <button className="btn" disabled={!changed} onClick={save}>
          Save
        </button>
      ) : (
        <p className="text-xs text-slate-500">Only an admin can change them.</p>
      )}
    </div>
  );
}

interface ClonedVoice {
  id: string;
  name: string;
  created: string;
  minutes: number;
  versions: number;
}

/**
 * Settings → Voice → Voice engine: cloned voices (HiveBot · Voice trainer) made inside HiveMind with Qwen3-TTS.
 * On/off, CPU or the GPU when it has room, how long it stays loaded, and the voices built so far.
 */
function VoiceEngine({ isAdmin }: { isAdmin: boolean }) {
  const [eng, setEng] = useState<{ available: boolean; enabled: boolean; device: 'auto' | 'cpu'; keepMin: number } | null>(null);
  const [voices, setVoices] = useState<ClonedVoice[]>([]);
  const load = async () => {
    const v = await api<{ voiceEngine?: { available: boolean; enabled: boolean; device: 'auto' | 'cpu'; keepMin: number } }>('/api/settings/voice', { quiet: true }).catch(() => ({}) as { voiceEngine?: undefined });
    setEng(v.voiceEngine ?? null);
    setVoices((await api<{ cloned: ClonedVoice[] }>('/api/voice/voices', { quiet: true }).catch(() => ({ cloned: [] }))).cloned);
  };
  useEffect(() => {
    void load();
  }, []);
  if (!eng?.available) return null;
  const save = async (p: Partial<typeof eng>) => {
    await api('/api/settings/voice-engine', { method: 'PUT', body: p }).catch(() => {});
    await load();
  };
  return (
    <section className="space-y-2 text-sm">
      <div className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Voice engine (cloned voices)</div>
      <p className="text-xs text-slate-400">
        Voices built from recordings with the <b>HiveBot · Voice trainer</b> workflow (Audio prep → Voice dataset → Voice clone), made inside HiveMind with Qwen3-TTS. Apps ask for them as{' '}
        <code>clone:jarvis</code>, or by name through Voices for apps (<code>jarvis = clone:jarvis</code>). When a cloned voice can&apos;t speak, the built-in voice says it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!isAdmin} checked={eng.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          On
        </label>
        <select className="input w-auto py-1" disabled={!isAdmin} value={eng.device} onChange={(e) => save({ device: e.target.value as 'auto' | 'cpu' })}>
          <option value="auto">GPU when it has 4 GB free, else the CPU</option>
          <option value="cpu">CPU only (never touches the GPU)</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          keep loaded
          <input className="input w-16 py-1" type="number" min={1} disabled={!isAdmin} value={eng.keepMin} onChange={(e) => save({ keepMin: Number(e.target.value) })} />
          min
        </label>
      </div>
      {voices.length === 0 && <p className="text-xs text-slate-500">No cloned voices yet.</p>}
      {voices.map((v) => (
        <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border border-[#30363d] px-2 py-1 text-xs">
          <b>{v.id}</b>
          <span className="text-slate-500">
            {v.minutes} min of recordings · built {v.created.slice(0, 16).replace('T', ' ')}
          </span>
          {isAdmin && v.versions > 0 && (
            <button
              className="btn-ghost ml-auto px-2 py-0.5"
              onClick={async () => {
                await api(`/api/voice/voices/${encodeURIComponent(v.name)}/previous`, { method: 'POST' }).catch(() => {});
                toast(`${v.id} is back to its previous version`, 'ok');
                await load();
              }}
            >
              Use previous voice
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
