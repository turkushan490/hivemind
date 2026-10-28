import type { LoadedModel, ModelInfo, ProviderKind } from '@hivemind/shared';

export type { LoadedModel };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object as the answer (where the provider supports forcing it). */
  json?: boolean;
  /** false: ask a thinking model to answer straight away (Ollama). */
  think?: boolean;
  /** Context size in tokens (Ollama num_ctx); other providers ignore it. */
  numCtx?: number;
}

export type StreamChunk =
  /** The model must be loaded into memory first. */
  | { type: 'loading' }
  /** The model is already in memory. */
  | { type: 'warm' }
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  /** genMs: pure generation time when the provider reports it (more exact tok/s). */
  | { type: 'done'; inputTokens?: number; outputTokens?: number; genMs?: number; loadMs?: number };

/** Runtime config of one provider, key already decrypted. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  preset: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ProviderAdapter {
  listModels(): Promise<ModelInfo[]>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
  /** Local providers only: what is loaded in RAM/VRAM, and unloading it. */
  loaded?(): Promise<LoadedModel[]>;
  unload?(model: string): Promise<void>;
  /** Local providers only: download and delete models. */
  pull?(model: string, signal: AbortSignal): AsyncIterable<PullProgress>;
  remove?(model: string): Promise<void>;
  /** Local only: give the GPU memory back (unload everything this server holds). */
  freeMemory?(): Promise<void>;
  /** Decision models (TypeSafe Jev, OpenAI Decisions, Ollama decision models). */
  decide?(req: import('./decisions.js').DecisionRequest, signal?: AbortSignal): Promise<import('./decisions.js').DecisionResult>;
  /** Image models (ComfyUI, OpenAI-compatible image APIs). */
  image?(req: ImageRequest, signal: AbortSignal, onProgress: (note: string) => void): Promise<GeneratedImage[]>;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  steps?: number;
  cfg?: number;
  lora?: string;
  loraStrength?: number;
  /** How many pictures in one job (1-8); default 1. */
  batch?: number;
}

export interface GeneratedImage {
  data: Buffer;
  /** File extension without the dot, e.g. png. */
  ext: string;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

/** Some model chat templates reject system messages; fold the system prompt into the first user message. */
export function foldSystem(messages: ChatMessage[]): ChatMessage[] {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (!system) return rest;
  const i = rest.findIndex((m) => m.role === 'user');
  if (i < 0) return [{ role: 'user', content: system }, ...rest];
  return rest.map((m, j) => (j === i ? { ...m, content: `${system}\n\n${m.content}` } : m));
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function checkResponse(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {}
  throw new ProviderError(`${what} failed: HTTP ${res.status} ${detail}`.trim(), res.status);
}
