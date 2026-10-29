// Types shared by the server, the web UI and (later) the Android app.
// The canvas format and run events are the contract between them.

export const NODE_TYPES = ['input', 'llm', 'review', 'judge', 'output', 'router', 'debate', 'vote', 'decide', 'template', 'file', 'search', 'memory', 'save', 'image', 'homeassistant', 'webhook', 'discord'] as const;
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
  /** LLM / Judge / Router: the model must answer with JSON (checked, repaired once); jsonSchema describes the shape. */
  json?: boolean;
  jsonSchema?: string;
  /** Context size in tokens for local (Ollama) models; default = the model's own. */
  numCtx?: number;
  /** At most this many tokens per answer (a thinking model can't go on forever); default = no limit. */
  maxTokens?: number;
  /** false: thinking models answer straight away, without thinking first. */
  think?: boolean;
  /** LLM: send the chat history from /v1 as real messages instead of one prompt. */
  useMessages?: boolean;
  /** Image: how many pictures per run (1-8). */
  batch?: number;
  /** Decide: what the decision model reads (template; default the text wired in, else the question). */
  state?: string;
  /** Decide: the typed questions. */
  questions?: DecideQuestion[];
  /** Decide / Auto / Jev router: how sure the model must be (default 0.6). Under it: no, the fallback, or one size up. */
  threshold?: number;
  /** LLM: "Auto (Jev router)": a decision model picks the size of model per question. */
  auto?: AutoModel;
  /** Router: who picks the route (default: the block's model). */
  decideWith?: 'llm' | 'jev';
  /** Router with Jev: the decision model. */
  decider?: ModelRef;
  /** Judge / Vote: a decision model scores every answer first (fast pre-ranking). */
  jevScore?: ModelRef;
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
  mode?: 'recall' | 'save' | 'search';
  limit?: number;
  /** Memory search: what to look up ({{vars.x}}, {{question}}, {{inputs}}); empty = the text wired in, else the question. */
  query?: string;
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

export const PROVIDER_KINDS = ['ollama', 'openai', 'anthropic', 'comfyui', 'decision'] as const;
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
  // Decision models: they don't chat, they answer typed questions with probabilities (Decide block, Auto model, Jev router).
  { id: 'typesafe', kind: 'decision', name: 'TypeSafe (Jev)', baseUrl: 'https://api.typesafe.ai', needsKey: true, free: false, local: false, keyUrl: 'https://console.typesafe.ai/keys', note: 'Jev decides in about 0.1 s for $0.042 per million input tokens; output is free.' },
  { id: 'openai-decisions', kind: 'decision', name: 'OpenAI Decisions', baseUrl: 'https://api.openai.com/v1', needsKey: true, free: false, local: false, keyUrl: 'https://platform.openai.com/api-keys', note: 'The Decisions API (gpt-6-luna): predicates, choices and scores.' },
  { id: 'ollama-decisions', kind: 'decision', name: 'Ollama decision models', baseUrl: 'http://localhost:11434', needsKey: false, free: true, local: true, note: 'Nimble, Tev1, Clef on your own GPU (Ollama 0.35+: ollama pull nimble).' },
  { id: 'clef-cloud', kind: 'decision', name: 'Clef (Ollama cloud)', baseUrl: 'https://ollama.com', needsKey: true, free: false, local: false, keyUrl: 'https://ollama.com/settings/keys', note: 'Clef and Clef Flash (open weights) on ollama.com; they can also judge images.' },
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
  /** "image" for models that make pictures (Image blocks), "decision" for decision models (Decide, Auto); text models leave it out. */
  kind?: 'image' | 'decision';
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

// ---- Decisions (Jev and friends) ----

export const DECISION_TYPES = ['noul', 'choice', 'score', 'box'] as const;
/** noul = yes/no (a probability), choice = pick one option, score = a level on a scale, box = where in an image. */
export type DecisionType = (typeof DECISION_TYPES)[number];

/** One question of a Decide block, as edited in the inspector. */
export interface DecideQuestion {
  /** Its name: the answer comes back under it ("spam", "wants"). */
  name: string;
  type: DecisionType;
  instructions: string;
  /** choice: the options (name → description; description may be empty). */
  options?: { name: string; description?: string }[];
  /** score: levels from lowest to highest. */
  levels?: string[];
  /** choice: the option to take when the model is unsure (under the threshold) and there is no "fallback" branch. */
  safe?: string;
}

/** LLM block "Auto (Jev router)": a decision model picks which of these models answers. */
export interface AutoModel {
  decider?: ModelRef;
  local?: ModelRef;
  small?: ModelRef;
  medium?: ModelRef;
  large?: ModelRef;
}

export const AUTO_TIERS = ['local', 'small', 'medium', 'large'] as const;
export type AutoTier = (typeof AUTO_TIERS)[number];

/** What each size means to the decision model (from the Jev guide's router, plus a local tier). */
export const AUTO_TIER_TEXT: Record<AutoTier, string> = {
  local: 'Private or simple: personal or home questions and quick lookups that should stay on this machine',
  small: 'Trivial: arithmetic, short facts, greetings, one-line rewrites',
  medium: 'Everyday: explanations, summaries, short creative writing, simple code',
  large: 'Hard: math proofs, multi-step reasoning, finding and fixing bugs in code, long or subtle analysis',
};

/** One answered question, as the block shows it (bars per option). */
export interface DecisionView {
  name: string;
  type: DecisionType | 'refusal';
  /** noul: probability of yes. */
  p?: number;
  /** choice: the pick; score: the most likely level. */
  pick?: string;
  /** Option or level → probability. */
  probabilities?: Record<string, number>;
  /** score: the probability-weighted level (0 = lowest). */
  score?: number;
  levels?: string[];
  /** box: edges as fractions of the image (0-1 from the top-left). */
  box?: { top: number; bottom: number; left: number; right: number };
  confidence?: number;
}

/** node_progress.decision: what a decision model answered (bars on the block, also in replay). */
export interface DecisionEvent {
  model: string;
  ms: number;
  answers: DecisionView[];
  threshold?: number;
  /** The branch / tier it led to ("yes", "promote", "medium: gemini-…"). */
  route?: string;
  /** box questions: the image that was judged (files folder path). */
  image?: string;
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
  /** node_done: the block's label, or its id when it has none. */
  label?: string;
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
  /** node_progress: a decision model's answer, for the probability bars. */
  decision?: DecisionEvent;
  /** node_done / run_done: files the block (or the whole run) wrote. */
  files?: OutputFile[];
  status?: RunStatus;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

/** One block's result in GET /api/runs/:id → outputs, keyed by label (or id; duplicates get "#2", "#3"). */
export interface NodeOutput {
  nodeId: string;
  type: NodeType;
  text: string;
}

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

// ---- Datasets (training data for every kind of model) ----

export const DATASET_KINDS = ['text', 'image', 'decision', 'voice'] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

/** Where an example came from. */
export type DatasetSource = 'lab' | 'thumbs' | 'upload' | 'generated' | 'block' | 'manual';

export interface Dataset {
  id: string;
  name: string;
  kind: DatasetKind;
  description?: string;
  /** System prompt every text example is trained with (e.g. the DM rules). */
  system?: string;
  createdAt: string;
  items: number;
  /** Examples waiting for review (they are not trained on until accepted). */
  pending: number;
}

export interface DatasetItem {
  id: number;
  input: string;
  output: string;
  system?: string;
  /** Pictures or audio in the files folder (image / voice datasets). */
  files?: string[];
  source: DatasetSource;
  /** null = ok; pending examples wait for review; rejected ones are never trained on. */
  review?: 'pending' | 'accepted' | 'rejected';
  at: string;
}

// ---- Lab: make a new model (GET /api/lab/train) ----

export type TrainState = 'starting' | 'waiting' | 'loading' | 'training' | 'exporting' | 'importing' | 'paused' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface TrainJob {
  id: string;
  base: string;
  /** The new model's name in Ollama, e.g. dungeonmind-dm:v1. */
  name: string;
  providerId: string;
  rows: number;
  state: TrainState;
  step?: number;
  totalSteps?: number;
  loss?: number;
  etaS?: number;
  note?: string;
  error?: string;
  /** The last lines the trainer printed. */
  log?: string;
  startedAt: string;
  finishedAt?: string;
}

/** A base model that fits a 16 GB GPU and may be fine-tuned and shared (Apache-2.0). */
export interface TrainBase {
  id: string;
  name: string;
  note: string;
  /** Rough seconds per training step on a Tesla T4 (for the estimate). */
  secPerStep: number;
}

export interface TrainOverview {
  trainer: { url?: string; ok: boolean; error?: string; gpu?: { name: string; usedMb: number; totalMb: number }; busy?: string | null };
  /** Training examples ready: clean turns plus accepted corrections. */
  rows: number;
  minRows: number;
  bases: TrainBase[];
  jobs: TrainJob[];
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
