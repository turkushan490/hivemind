// Types shared by the server, the web UI and (later) the Android app.
// The canvas format and run events are the contract between them.

export const NODE_TYPES = ['input', 'llm', 'review', 'judge', 'output', 'router', 'debate', 'vote', 'template', 'file', 'search', 'memory', 'save', 'image', 'homeassistant', 'webhook', 'discord'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Which model a node uses: a configured provider plus a model id on it. */
export interface ModelRef {
  providerId: string;
  model: string;
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  label?: string;
  position: { x: number; y: number };
  config: NodeConfig;
}

export interface NodeConfig {
  model?: ModelRef;
  /** System prompt for llm/review/judge nodes. */
  system?: string;
  /** Prompt template; {{question}} and {{inputs}} are filled in. */
  prompt?: string;
  temperature?: number;
  /** Debate and Vote: the models that take part. */
  models?: ModelRef[];
  /** Debate: how many rounds (1-4). */
  rounds?: number;
  /** File: the file's text, and its name. */
  text?: string;
  fileName?: string;
  /** Web search: where to search, and how many results. */
  source?: SearchSource;
  count?: number;
  /** Memory: what to remember under (may use {{vars.name}}, e.g. "dnd:{{vars.tableId}}"), recall or save, how many to recall. */
  key?: string;
  mode?: 'recall' | 'save';
  limit?: number;
  /** Save file: the name (may use {{date}} and {{question}}) and the format. */
  format?: SaveFormat;
  /** Image: size, steps, guidance, LoRA (ComfyUI), and what not to draw. */
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  lora?: string;
  loraStrength?: number;
  negative?: string;
  /** Home Assistant: read entity states, or call a service. */
  haOp?: 'state' | 'service';
  /** Home Assistant: entity ids to read (comma or newline separated; templates allowed). */
  entities?: string;
  /** Home Assistant: the service to call, e.g. "light.turn_on". */
  service?: string;
  /** Webhook: where to send it, and how. Discord: the channel's webhook URL. */
  url?: string;
  method?: HttpMethod;
  /** Webhook: one "Name: value" per line. */
  headers?: string;
  /**
   * Webhook body, Home Assistant service data (JSON) or Discord message.
   * {{input}}, {{question}} and {{inputs}} are filled in (JSON-escaped when the template is JSON).
   */
  body?: string;
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Voice settings (GET/PUT /api/settings/voice); keys are never sent back. */
export interface VoiceSettings {
  /** Speech to text: an OpenAI-compatible server with /audio/transcriptions (Groq, OpenAI, speaches / faster-whisper). */
  sttUrl?: string;
  sttModel?: string;
  /** e.g. "en", "nl"; empty = detect. */
  sttLanguage?: string;
  hasSttKey: boolean;
  /** Ready to transcribe (an address is set). */
  sttReady: boolean;
  /** Text to speech: the browser's own voices, or an OpenAI-compatible /audio/speech server (OpenAI, Kokoro, Piper). */
  ttsMode: 'browser' | 'server';
  ttsUrl?: string;
  ttsModel?: string;
  ttsVoice?: string;
  hasTtsKey: boolean;
}

/** Home Assistant connection (GET/PUT /api/settings/homeassistant); the token is never sent back. */
export interface HomeAssistantSettings {
  url?: string;
  hasToken: boolean;
}

export const SAVE_FORMATS = ['auto', 'md', 'txt', 'html', 'json', 'csv', 'code'] as const;
export type SaveFormat = (typeof SAVE_FORMATS)[number];

/** A file a block wrote to the files folder (outputs/…). */
export interface OutputFile {
  path: string;
  kind: 'image' | 'text' | 'html' | 'pdf' | 'other';
}

export const SEARCH_SOURCES = ['wikipedia', 'brave', 'tavily', 'searxng'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/** Web search settings (GET/PUT /api/settings/search); keys are never sent back, only whether they exist. */
export interface SearchSettings {
  source: SearchSource;
  wikiLang: string;
  searxngUrl?: string;
  hasBraveKey: boolean;
  hasTavilyKey: boolean;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface Canvas extends CanvasGraph {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;
  /** Everyone (also viewers) can use it in Use mode and through the API. */
  shared?: boolean;
  /** Yours to edit; false for a canvas someone else shared. */
  mine?: boolean;
  /** Who shared it (only for canvases of others). */
  ownerName?: string;
}

// ---- Providers ----

export const PROVIDER_KINDS = ['ollama', 'openai', 'anthropic', 'comfyui'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Presets fill in base URL and defaults; "openai" kind covers every OpenAI-compatible API. */
export interface ProviderPreset {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  needsKey: boolean;
  /** Has a free tier or free models. */
  free: boolean;
  /** Runs on local hardware: jobs are queued one at a time per host. */
  local: boolean;
  keyUrl?: string;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'ollama', kind: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', needsKey: false, free: true, local: true, note: 'Local models on your own GPU.' },
  { id: 'openrouter', kind: 'openai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, free: true, local: false, keyUrl: 'https://openrouter.ai/keys', note: 'Free key gives the ":free" models (20 requests/min, 50/day).' },
  { id: 'groq', kind: 'openai', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, free: true, local: false, keyUrl: 'https://console.groq.com/keys', note: 'Free tier, very fast.' },
  { id: 'gemini', kind: 'openai', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, free: true, local: false, keyUrl: 'https://aistudio.google.com/apikey', note: 'Free tier via Google AI Studio.' },
  { id: 'openai', kind: 'openai', name: 'OpenAI (ChatGPT)', baseUrl: 'https://api.openai.com/v1', needsKey: true, free: false, local: false, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', needsKey: true, free: false, local: false, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'opencode-zen', kind: 'openai', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/openai/v1', needsKey: true, free: false, local: false, keyUrl: 'https://opencode.ai/auth', note: 'Paid models only; Zen free models only work inside the OpenCode app.' },
  { id: 'comfyui', kind: 'comfyui', name: 'ComfyUI (images)', baseUrl: 'http://localhost:8188', needsKey: false, free: true, local: true, note: 'Your own ComfyUI: its checkpoints become local image models for Image blocks.' },
  { id: 'custom', kind: 'openai', name: 'Custom (OpenAI-compatible)', baseUrl: '', needsKey: false, free: false, local: false },
];

/** A provider as the API returns it (never includes the key). */
export interface ProviderInfo {
  id: string;
  preset: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  enabled: boolean;
  local: boolean;
  /** Local only: run this server's models at the same time instead of one by one. */
  parallel: boolean;
  shared: boolean;
}

export interface ModelInfo {
  providerId: string;
  model: string;
  name: string;
  free: boolean;
  contextLength?: number;
  /** USD per 1M tokens, when the provider tells us. */
  price?: { input: number; output: number };
  /** "image" for models that make pictures (Image blocks); text models leave it out. */
  kind?: 'image';
  /** Local models: size on disk and quantization. */
  sizeBytes?: number;
  quant?: string;
  modifiedAt?: string;
}

/** A model currently held in memory by a local provider. */
export interface LoadedModel {
  model: string;
  /** Total memory in bytes, and the part in GPU VRAM. */
  sizeBytes: number;
  vramBytes: number;
  /** When the provider unloads it by itself (ISO time). */
  expiresAt?: string;
}

/** GET /api/memory: one entry per local provider. */
export interface ProviderMemory {
  providerId: string;
  name: string;
  canUnload: boolean;
  models: LoadedModel[];
  error?: string;
}

/** A model download into Ollama (GET /api/ollama/pulls). */
export interface PullJob {
  id: string;
  providerId: string;
  model: string;
  status: string;
  totalBytes?: number;
  doneBytes?: number;
  state: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  startedAt: number;
}

export interface HfRepo {
  id: string;
  downloads: number;
  likes: number;
  updatedAt?: string;
}

export interface HfFile {
  file: string;
  /** Quant tag Ollama understands, e.g. Q4_K_M. */
  quant: string;
  sizeBytes?: number;
  /** What to pull in Ollama: hf.co/<repo>:<quant> */
  pullName: string;
  /** Split GGUF files can't be pulled by Ollama. */
  split: boolean;
}

/** A model family in the ollama.com library (GET /api/ollama/library). */
export interface OllamaLibraryModel {
  name: string;
  description: string;
  /** e.g. vision, tools, thinking, embedding, cloud */
  capabilities: string[];
  /** Parameter sizes it comes in, e.g. 4b, 27b */
  sizes: string[];
  downloads: number;
  /** Only runs on ollama.com's cloud, nothing to download. */
  cloudOnly: boolean;
  /** Last update on ollama.com (library list only). */
  updatedAt?: string;
}

/** One downloadable version of a library model. */
export interface OllamaTag {
  tag: string;
  sizeBytes: number;
  context?: string;
  input?: string;
}

/** A suggested download: model:size with its (estimated) size. */
export interface OllamaPick {
  pullName: string;
  name: string;
  size: string;
  description: string;
  capabilities: string[];
  downloads: number;
  /** Popularity weighted by how recent the model is; higher = recommend first. */
  score: number;
  estBytes: number;
}

/** An entry of the Problems tab. */
export interface Problem {
  id: number;
  at: string;
  source: 'server' | 'crash' | 'run' | 'provider' | 'web' | 'voice';
  message: string;
  detail?: string;
  runId?: string;
  seen: boolean;
}

// ---- Run events ----
// Every UI animation is driven by these; replay = feeding stored events again.

export type RunEventType =
  | 'run_start'
  | 'node_queued'
  | 'model_loading'
  /** The model produced its first output: loading (if any) is over. */
  | 'model_ready'
  | 'node_start'
  | 'token'
  /** Reasoning text of thinking models, streamed separately from the answer. */
  | 'thinking'
  | 'node_done'
  /** A short status line from inside a block, e.g. "Round 2 of 3" or "Searching Wikipedia". */
  | 'node_progress'
  /** The block did not run: a Router chose another branch. */
  | 'node_skipped'
  | 'run_done'
  | 'error';

export interface RunEvent {
  type: RunEventType;
  runId: string;
  seq: number;
  ts: number;
  nodeId?: string;
  nodeType?: NodeType;
  model?: string;
  /** token: the new text piece. node_done: the full output. */
  text?: string;
  /** Output tokens so far (token) or total (node_done). */
  tokens?: number;
  inputTokens?: number;
  tokensPerSec?: number;
  /** USD, when known. */
  cost?: number;
  elapsedMs?: number;
  error?: string;
  /** run_start: the graph that runs. */
  graph?: CanvasGraph;
  question?: string;
  /** run_done: final answer text. */
  final?: string;
  /** node_start: the model runs on local hardware (Ollama). */
  local?: boolean;
  /** model_loading: how long loading should take (from this model's last real load, or estimated from its size). */
  expectedMs?: number;
  estimated?: boolean;
  /** model_loading / node_done: model size in memory. */
  sizeBytes?: number;
  /** model_ready: the model was already in memory, no loading needed. */
  warm?: boolean;
  /** node_done: real load time reported by the provider. */
  loadMs?: number;
  /** node_progress: what the block is doing right now. */
  note?: string;
  /** node_done / run_done: files the block (or the whole run) wrote. */
  files?: OutputFile[];
  status?: RunStatus;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** POST /api/runs body. */
export interface RunRequest {
  question?: string;
  /** Run a saved canvas (yours or a shared one). */
  canvasId?: string;
  /** Run this graph (your own canvas as on screen, or an ad-hoc one). */
  graph?: CanvasGraph;
  /** Named values for {{vars.name}} in prompts, memory keys, file names and webhooks: at most 64 keys ([a-zA-Z0-9_]{1,40}), 1 MB in total. */
  vars?: Record<string, string>;
}

export interface RunSummary {
  id: string;
  canvasId?: string;
  canvasName?: string;
  question: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  final?: string;
  cost?: number;
}

// ---- Templates ----

export const JUDGE_SYSTEM =
  'You are the judge. Below are answers from several AI models to the same question. ' +
  'Compare them, keep the correct and best parts, fix mistakes, and write one final clear answer. ' +
  'Briefly mention where models disagreed.';

export const REVIEW_SYSTEM =
  'You review anonymous answers from other AI models to the same question. ' +
  'For each answer, point out mistakes and strong points in a few lines, then give a ranking from best to worst.';

/** The classic council: question → N models → judge → output. */
export function councilGraph(models: ModelRef[], judge: ModelRef, withReview = false): CanvasGraph {
  const nodes: CanvasNode[] = [
    { id: 'q', type: 'input', label: 'Question', position: { x: 0, y: 200 }, config: {} },
  ];
  const edges: CanvasEdge[] = [];
  models.forEach((m, i) => {
    const id = `m${i + 1}`;
    nodes.push({ id, type: 'llm', label: m.model, position: { x: 300, y: i * 160 }, config: { model: m } });
    edges.push({ id: `q-${id}`, source: 'q', target: id });
  });
  let judgeInputs = models.map((_, i) => `m${i + 1}`);
  if (withReview) {
    nodes.push({ id: 'r', type: 'review', label: 'Review', position: { x: 600, y: 200 }, config: { model: judge } });
    judgeInputs.forEach((id) => edges.push({ id: `${id}-r`, source: id, target: 'r' }));
    judgeInputs = [...judgeInputs, 'r'];
  }
  nodes.push({ id: 'j', type: 'judge', label: 'Judge', position: { x: 900, y: 200 }, config: { model: judge } });
  judgeInputs.forEach((id) => edges.push({ id: `${id}-j`, source: id, target: 'j' }));
  nodes.push({ id: 'out', type: 'output', label: 'Final answer', position: { x: 1200, y: 200 }, config: {} });
  edges.push({ id: 'j-out', source: 'j', target: 'out' });
  return { nodes, edges };
}

// ---- Stats (GET /api/stats) ----

export interface StatsReport {
  days: number;
  totals: { cost: number; inputTokens: number; outputTokens: number; runs: number; calls: number; unpricedCalls: number };
  byDay: { day: string; cost: number; tokens: number; runs: number }[];
  byProvider: { providerId: string; name: string; cost: number; inputTokens: number; outputTokens: number; calls: number }[];
  byModel: {
    providerId: string;
    model: string;
    cost: number;
    /** False when some calls had no known price (counted as 0). */
    priced: boolean;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    tokensPerSec?: number;
  }[];
  /** Judge / Vote picks: how often each model's answer was chosen as best. */
  leaderboard: { model: string; wins: number; contests: number; winRate: number }[];
}
