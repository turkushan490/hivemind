// Types shared by the server, the web UI and (later) the Android app.
// The canvas format and run events are the contract between them.

export const NODE_TYPES = ['input', 'llm', 'review', 'judge', 'output'] as const;
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
}

// ---- Providers ----

export const PROVIDER_KINDS = ['ollama', 'openai', 'anthropic'] as const;
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
  { id: 'openai', kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, free: false, local: false, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', needsKey: true, free: false, local: false, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'opencode-zen', kind: 'openai', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/openai/v1', needsKey: true, free: false, local: false, keyUrl: 'https://opencode.ai/auth', note: 'Paid models only; Zen free models only work inside the OpenCode app.' },
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

/** An entry of the Problems tab. */
export interface Problem {
  id: number;
  at: string;
  source: 'server' | 'crash' | 'run' | 'provider' | 'web';
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
  | 'node_start'
  | 'token'
  /** Reasoning text of thinking models, streamed separately from the answer. */
  | 'thinking'
  | 'node_done'
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
  status?: RunStatus;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface RunSummary {
  id: string;
  canvasId?: string;
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
