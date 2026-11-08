import type { LoadedModel, ModelInfo, ProviderKind } from '@hivemind/shared';

export type { LoadedModel };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Pictures that go with this message (a question with an image attached), for models that can see. */
  images?: { data: Buffer; ext: string }[];
}

const mime = (ext: string) => `image/${ext.toLowerCase().replace('jpg', 'jpeg')}`;

/** Ollama's /api/chat: pictures as base64 next to the text. */
export const ollamaMessages = (messages: ChatMessage[]) =>
  messages.map(({ images, ...m }) => (images?.length ? { ...m, images: images.map((i) => i.data.toString('base64')) } : m));

/** OpenAI-compatible APIs: a message with pictures becomes text + image_url parts (data URLs). */
export const openaiMessages = (messages: ChatMessage[]) =>
  messages.map(({ images, ...m }) =>
    images?.length
      ? { role: m.role, content: [{ type: 'text', text: m.content }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${mime(i.ext)};base64,${i.data.toString('base64')}` } }))] }
      : m,
  );

/** Anthropic's Messages API: image blocks before the text. */
export const anthropicMessages = (messages: ChatMessage[]) =>
  messages.map(({ images, ...m }) =>
    images?.length
      ? { role: m.role, content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: mime(i.ext), data: i.data.toString('base64') } })), { type: 'text', text: m.content }] }
      : m,
  );

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
  /** Keep the model loaded this long after the call (Ollama keep_alive, e.g. "30m"); others ignore it. */
  keepAlive?: string;
}

export type StreamChunk =
  /** The model must be loaded into memory first. */
  | { type: 'loading' }
  /** The model is already in memory. */
  | { type: 'warm' }
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  /** genMs: pure generation time when the provider reports it (more exact tok/s). stopped: cut off at maxTokens. */
  | { type: 'done'; inputTokens?: number; outputTokens?: number; genMs?: number; loadMs?: number; stopped?: 'length' };

/** Runtime config of one provider, key already decrypted. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  preset: string;
  baseUrl: string;
  apiKey?: string;
  /** ComfyUI: save pictures in its output folder too (SaveImage); off, they only pass through its temp folder (PreviewImage). */
  keepImages?: boolean;
  /** Ollama: run on the CPU only (num_gpu 0). */
  cpuOnly?: boolean;
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
  /** Local only: load a model without answering, and keep it loaded keepAlive long (Ollama). */
  warm?(model: string, keepAlive: string): Promise<void>;
  /** Local only: how much GPU memory is free right now (bytes), when the server can tell (ComfyUI). */
  vramFree?(): Promise<number | undefined>;
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
