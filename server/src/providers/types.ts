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
