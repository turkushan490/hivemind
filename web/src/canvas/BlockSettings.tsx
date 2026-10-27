import { HTTP_METHODS, SEARCH_SOURCES, type ModelInfo, type ModelRef, type NodeConfig, type NodeType, type ProviderInfo } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
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
    case 'save':
      return (
        <div className="space-y-2">
          <label className="block space-y-1">
            <Label>File name</Label>
            <input
              className="input"
              placeholder="answer-{{date}}"
              value={p.config.fileName ?? ''}
              onChange={(e) => p.onChange({ fileName: e.target.value || undefined })}
            />
            <span className="text-xs text-slate-500">
              <code>{'{{date}}'}</code> and <code>{'{{question}}'}</code> are filled in. Saved in the files folder under <code>outputs/</code>, never overwriting.
            </span>
          </label>
          <label className="block space-y-1">
            <Label>Format</Label>
            <select className="input" value={p.config.format ?? 'auto'} onChange={(e) => p.onChange({ format: e.target.value as NodeConfig['format'] })}>
              <option value="auto">Auto — a website when the answer has HTML, otherwise Markdown</option>
              <option value="md">Markdown (.md)</option>
              <option value="txt">Text (.txt)</option>
              <option value="html">Website (.html) — previewable</option>
              <option value="json">JSON (.json)</option>
              <option value="csv">Spreadsheet (.csv)</option>
              <option value="code">Code — the code from the answer, right file type</option>
            </select>
          </label>
        </div>
      );
    case 'image':
      return <ImageSettings {...p} />;
    case 'homeassistant':
      return <HomeAssistantSettings {...p} />;
    case 'webhook':
      return <WebhookSettings {...p} />;
    case 'discord':
      return (
        <div className="space-y-2">
          <label className="block space-y-1">
            <Label>Webhook URL</Label>
            <input className="input text-xs" placeholder="https://discord.com/api/webhooks/…" value={p.config.url ?? ''} onChange={(e) => p.onChange({ url: e.target.value || undefined })} />
            <span className="text-xs text-slate-500">Discord channel → Edit channel → Integrations → Webhooks → Copy URL. Anyone with this URL can post, so keep the canvas private.</span>
          </label>
          <label className="block space-y-1">
            <Label>Message</Label>
            <textarea className="input min-h-20 text-xs" placeholder="{{input}}" value={p.config.body ?? ''} onChange={(e) => p.onChange({ body: e.target.value || undefined })} />
            <TemplateHelp />
          </label>
        </div>
      );
    default:
      return null;
  }
}

const SIZES: [string, number, number][] = [
  ['Square', 1024, 1024],
  ['Portrait', 832, 1216],
  ['Landscape', 1216, 832],
  ['Small (fast)', 768, 768],
];

/** Image models need sizes in multiples of 8; very small or huge sizes give bad pictures or run out of memory. */
const fitSize = (v: number) => Math.min(2048, Math.max(256, Math.round((Number.isFinite(v) ? v : 1024) / 8) * 8));

/** Any width × height, applied when you leave the field or press Enter; ⇄ swaps them. */
function CustomSize({ width, height, onChange }: { width: number; height: number; onChange: (w: number, h: number) => void }) {
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  useEffect(() => {
    setW(String(width));
    setH(String(height));
  }, [width, height]);
  const apply = () => {
    const nw = fitSize(Number(w));
    const nh = fitSize(Number(h));
    setW(String(nw));
    setH(String(nh));
    if (nw !== width || nh !== height) onChange(nw, nh);
  };
  const preset = SIZES.some(([, a, b]) => a === width && b === height);
  const mp = ((width * height) / 1e6).toFixed(2);
  return (
    <div className={`mt-1 flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs ${preset ? 'border-[#30363d]' : 'border-fuchsia-500 bg-fuchsia-500/10'}`}>
      <span className="text-slate-400">Custom</span>
      <input
        className="input w-20 px-2 py-0.5 text-xs"
        inputMode="numeric"
        aria-label="Width"
        value={w}
        onChange={(e) => setW(e.target.value.replace(/\D/g, ''))}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
      />
      <span className="text-slate-500">×</span>
      <input
        className="input w-20 px-2 py-0.5 text-xs"
        inputMode="numeric"
        aria-label="Height"
        value={h}
        onChange={(e) => setH(e.target.value.replace(/\D/g, ''))}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
      />
      <button className="rounded px-1.5 text-slate-400 hover:bg-[#21262d] hover:text-slate-200" title="Swap width and height" aria-label="Swap width and height" onClick={() => onChange(height, width)}>
        ⇄
      </button>
      <span className={`ml-auto ${width * height > 1.6e6 ? 'text-amber-300' : 'text-slate-500'}`} title="Bigger pictures take longer and need more GPU memory">
        {mp} MP
      </span>
    </div>
  );
}

/** Image block: size, quality, LoRA (ComfyUI), what not to draw, and an optional fixed prompt. */
function ImageSettings(p: Props) {
  const c = p.config;
  const [loras, setLoras] = useState<string[] | null>(null);
  const [loraQ, setLoraQ] = useState('');
  const providerId = c.model?.providerId;
  const isComfy = p.providers.find((x) => x.id === providerId)?.preset === 'comfyui';
  useEffect(() => {
    if (!providerId || !isComfy) return setLoras(null);
    api<string[]>(`/api/providers/${providerId}/loras`, { quiet: true }).then(setLoras).catch(() => setLoras([]));
  }, [providerId, isComfy]);
  const shownLoras = (loras ?? []).filter((l) => l.toLowerCase().includes(loraQ.toLowerCase())).slice(0, 60);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Size</Label>
        <div className="grid grid-cols-2 gap-1">
          {SIZES.map(([name, w, h]) => (
            <button
              key={name}
              className={`rounded-md border px-2 py-1 text-xs ${(c.width ?? 1024) === w && (c.height ?? 1024) === h ? 'border-fuchsia-500 bg-fuchsia-500/15 text-fuchsia-100' : 'border-[#30363d] text-slate-400'}`}
              onClick={() => p.onChange({ width: w, height: h })}
            >
              {name} · {w}×{h}
            </button>
          ))}
        </div>
        <CustomSize width={c.width ?? 1024} height={c.height ?? 1024} onChange={(width, height) => p.onChange({ width, height })} />
      </div>
      {isComfy && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Steps: {c.steps ?? 'auto'}</span>
            <input type="range" className="w-full" min={4} max={50} value={c.steps ?? 25} onChange={(e) => p.onChange({ steps: Number(e.target.value) })} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-400">Guidance: {c.cfg ?? 'auto'}</span>
            <input type="range" className="w-full" min={1} max={12} step={0.5} value={c.cfg ?? 6} onChange={(e) => p.onChange({ cfg: Number(e.target.value) })} />
          </label>
          {(c.steps !== undefined || c.cfg !== undefined) && (
            <button className="col-span-2 text-left text-xs text-indigo-400 hover:underline" onClick={() => p.onChange({ steps: undefined, cfg: undefined })}>
              Back to automatic (fast models get few steps automatically)
            </button>
          )}
        </div>
      )}
      {isComfy && loras && (
        <div className="space-y-1">
          <Label>LoRA {c.lora && <span className="font-normal text-fuchsia-300">· {c.lora.split('/').pop()}</span>}</Label>
          <input className="input py-1 text-xs" placeholder={`Search ${loras.length} LoRAs…`} value={loraQ} onChange={(e) => setLoraQ(e.target.value)} />
          {loraQ && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-[#30363d]">
              {shownLoras.map((l) => (
                <button key={l} className="block w-full truncate px-2 py-1 text-left text-xs hover:bg-[#21262d]" onClick={() => (p.onChange({ lora: l }), setLoraQ(''))}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {c.lora && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">Strength {c.loraStrength ?? 1}</span>
              <input type="range" className="flex-1" min={0} max={1.5} step={0.05} value={c.loraStrength ?? 1} onChange={(e) => p.onChange({ loraStrength: Number(e.target.value) })} />
              <button className="text-red-400" onClick={() => p.onChange({ lora: undefined, loraStrength: undefined })}>
                remove
              </button>
            </div>
          )}
        </div>
      )}
      <label className="block space-y-1">
        <Label>Prompt (optional)</Label>
        <textarea
          className="input min-h-16 text-xs"
          placeholder="Empty = draw what the block before wrote. Or e.g. watercolor of {{question}}"
          value={c.prompt ?? ''}
          onChange={(e) => p.onChange({ prompt: e.target.value || undefined })}
        />
      </label>
      <label className="block space-y-1">
        <Label>Don’t draw</Label>
        <input className="input text-xs" placeholder="lowres, blurry, watermark, text" value={c.negative ?? ''} onChange={(e) => p.onChange({ negative: e.target.value || undefined })} />
      </label>
    </div>
  );
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
  const [folder, setFolder] = useState<{ path: string; kind: string }[]>([]);
  useEffect(() => {
    api<{ path: string; kind: string }[]>('/api/files', { quiet: true })
      .then((l) => setFolder(l.filter((f) => f.kind === 'text' || f.kind === 'pdf' || f.kind === 'html')))
      .catch(() => {});
  }, []);
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
      {folder.length > 0 && (
        <select
          className="input text-xs"
          value=""
          onChange={async (e) => {
            const path = e.target.value;
            if (!path) return;
            const blob = await (await fetch(`/api/files/raw?path=${encodeURIComponent(path)}`)).blob();
            load(new File([blob], path.split('/').pop()!));
          }}
        >
          <option value="">Take a file from the files folder…</option>
          {folder.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
        </select>
      )}
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

const TemplateHelp = () => (
  <span className="text-xs text-slate-500">
    <code>{'{{input}}'}</code> = what is wired in (or the question), <code>{'{{question}}'}</code>, <code>{'{{inputs}}'}</code> = all wired-in answers. In JSON
    they are escaped for you.
  </span>
);

/** Shows whether a JSON template is valid (with the placeholders filled by sample text). */
function JsonHint({ text }: { text?: string }) {
  if (!text?.trim() || !/^\s*(\[|\{(?!\{))/.test(text)) return null;
  try {
    JSON.parse(text.replace(/\{\{\s*(input|question|inputs)\s*\}\}/g, 'x'));
    return <span className="text-xs text-emerald-400">Valid JSON</span>;
  } catch (err) {
    return <span className="text-xs text-red-400">Not valid JSON: {(err as Error).message}</span>;
  }
}

/** Home Assistant block: read entity states or call a service. Entities come from your Home Assistant. */
function HomeAssistantSettings(p: Props) {
  const c = p.config;
  const op = c.haOp ?? 'state';
  const [entities, setEntities] = useState<{ id: string; name: string; state: string }[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ id: string; name: string; state: string }[]>('/api/homeassistant/entities', { quiet: true })
      .then(setEntities)
      .catch((err) => setError((err as Error).message));
  }, []);
  const services = [...new Set((entities ?? []).map((e) => e.id.split('.')[0]))].sort();
  return (
    <div className="space-y-2">
      {error && <p className="rounded-md bg-red-950/40 p-2 text-xs text-red-300">{error}</p>}
      <div className="flex gap-1">
        {(['state', 'service'] as const).map((m) => (
          <button
            key={m}
            className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${op === m ? 'border-sky-400 bg-sky-400/15 text-sky-100' : 'border-[#30363d] text-slate-400'}`}
            onClick={() => p.onChange({ haOp: m })}
          >
            {m === 'state' ? 'Read states' : 'Call a service'}
          </button>
        ))}
      </div>
      <datalist id={`ha-entities-${p.nodeId}`}>
        {(entities ?? []).map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({e.state})
          </option>
        ))}
      </datalist>
      {op === 'state' ? (
        <>
          <label className="block space-y-1">
            <Label>Entities</Label>
            <textarea
              className="input min-h-16 text-xs"
              placeholder={'sensor.living_room_temperature\nweather.home'}
              value={c.entities ?? ''}
              onChange={(e) => p.onChange({ entities: e.target.value || undefined })}
            />
          </label>
          <input
            className="input py-1 text-xs"
            list={`ha-entities-${p.nodeId}`}
            placeholder={entities ? `Add one of ${entities.length} entities…` : 'Add an entity…'}
            onChange={(e) => {
              if (!entities?.some((x) => x.id === e.target.value)) return;
              p.onChange({ entities: [c.entities?.trim(), e.target.value].filter(Boolean).join('\n') });
              e.target.value = '';
            }}
          />
          <p className="text-xs text-slate-500">Passes the states on as text, e.g. to a model that answers “Is it warm inside?”.</p>
        </>
      ) : (
        <>
          <label className="block space-y-1">
            <Label>Service</Label>
            <input className="input text-xs" list={`ha-services-${p.nodeId}`} placeholder="light.turn_on" value={c.service ?? ''} onChange={(e) => p.onChange({ service: e.target.value || undefined })} />
            <datalist id={`ha-services-${p.nodeId}`}>
              {services.flatMap((d) => ['turn_on', 'turn_off', 'toggle'].map((a) => <option key={`${d}.${a}`} value={`${d}.${a}`} />))}
            </datalist>
          </label>
          <label className="block space-y-1">
            <Label>Data (JSON)</Label>
            <textarea
              className="input min-h-24 font-mono text-xs"
              placeholder={'{"entity_id": "light.kitchen", "brightness_pct": 60}\nor for a message: {"message": "{{input}}"}'}
              value={c.body ?? ''}
              onChange={(e) => p.onChange({ body: e.target.value || undefined })}
            />
            <JsonHint text={c.body} />
          </label>
          <TemplateHelp />
        </>
      )}
    </div>
  );
}

/** Webhook / HTTP block: method, URL, headers and a body template. */
function WebhookSettings(p: Props) {
  const c = p.config;
  const method = c.method ?? 'POST';
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <select className="input w-28 shrink-0 text-xs" value={method} onChange={(e) => p.onChange({ method: e.target.value as NodeConfig['method'] })}>
          {HTTP_METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input className="input text-xs" placeholder="https://example.com/hook?q={{question}}" value={c.url ?? ''} onChange={(e) => p.onChange({ url: e.target.value || undefined })} />
      </div>
      <label className="block space-y-1">
        <Label>Headers</Label>
        <textarea
          className="input min-h-12 font-mono text-xs"
          placeholder={'Authorization: Bearer …\nX-Source: HiveMind'}
          value={c.headers ?? ''}
          onChange={(e) => p.onChange({ headers: e.target.value || undefined })}
        />
        <span className="text-xs text-slate-500">One per line. Headers are saved in the canvas (and its exports).</span>
      </label>
      {method !== 'GET' && (
        <label className="block space-y-1">
          <Label>Body</Label>
          <textarea
            className="input min-h-20 font-mono text-xs"
            placeholder={'{"text": "{{input}}", "question": "{{question}}"}'}
            value={c.body ?? ''}
            onChange={(e) => p.onChange({ body: e.target.value || undefined })}
          />
          <JsonHint text={c.body} />
        </label>
      )}
      <TemplateHelp />
      <p className="text-xs text-slate-500">The response is passed on (JSON pretty-printed). An error status stops the block and shows up in Problems.</p>
    </div>
  );
}
