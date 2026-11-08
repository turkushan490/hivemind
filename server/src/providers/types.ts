import type { LoadedModel, ModelInfo, ProviderKind } from '@hivemind/shared';

export type { LoadedModel };

/** A tool the model asked to use (OpenAI's tool_calls): arguments as a JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool the caller offers (OpenAI's format). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Pictures that go with this message (a question with an image attached), for models that can see. */
  images?: { data: Buffer; ext: string }[];
  /** assistant: the tools it asked for. */
  toolCalls?: ToolCall[];
  /** tool: which call this is the result of, and that tool's name. */
  toolCallId?: string;
  toolName?: string;
}

const mime = (ext: string) => `image/${ext.toLowerCase().replace('jpg', 'jpeg')}`;

const parseArgs = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { text: s };
  }
};

/** Ollama's /api/chat: pictures as base64 next to the text; tool calls with their arguments as objects. */
export const ollamaMessages = (messages: ChatMessage[]) =>
  messages.map(({ images, toolCalls, toolCallId, toolName, ...m }) => ({
    ...m,
    ...(images?.length && { images: images.map((i) => i.data.toString('base64')) }),
    ...(toolCalls?.length && { tool_calls: toolCalls.map((c) => ({ function: { name: c.name, arguments: parseArgs(c.arguments) } })) }),
    ...(m.role === 'tool' && toolName && { tool_name: toolName }),
  }));

/** OpenAI-compatible APIs: a message with pictures becomes text + image_url parts (data URLs); tool calls as they are. */
export const openaiMessages = (messages: ChatMessage[]) =>
  messages.map(({ images, toolCalls, toolCallId, toolName, ...m }) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: toolCallId ?? '', ...(toolName && { name: toolName }) };
    if (toolCalls?.length)
      return { role: m.role, content: m.content || null, tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) };
    return images?.length
      ? { role: m.role, content: [{ type: 'text', text: m.content }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${mime(i.ext)};base64,${i.data.toString('base64')}` } }))] }
      : m;
  });

/** Anthropic's Messages API: image blocks before the text; tool_use / tool_result blocks (results go in a user turn). */
export const anthropicMessages = (messages: ChatMessage[]) => {
  const out: { role: string; content: unknown }[] = [];
  for (const { images, toolCalls, toolCallId, ...m } of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: toolCallId ?? '', content: m.content };
      const last = out.at(-1);
      // Several results in a row share one user turn.
      if (last?.role === 'user' && Array.isArray(last.content) && (last.content as { type: string }[]).every((b) => b.type === 'tool_result')) (last.content as unknown[]).push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (toolCalls?.length) {
      out.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments) }))] });
      continue;
    }
    out.push(
      images?.length
        ? { role: m.role, content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: mime(i.ext), data: i.data.toString('base64') } })), { type: 'text', text: m.content }] }
        : { role: m.role, content: m.content },
    );
  }
  return out;
};

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
  /** Tools the model may call (/v1 for coding agents), and OpenAI's tool_choice. */
  tools?: ToolDef[];
  toolChoice?: unknown;
  stop?: string | string[];
  topP?: number;
}

export type StreamChunk =
  /** The model must be loaded into memory first. */
  | { type: 'loading' }
  /** The model is already in memory. */
  | { type: 'warm' }
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  /** A tool call, whole or in pieces: the first piece of a call has its id and name, later ones add to its arguments. */
  | { type: 'tool_call'; index: number; id?: string; name?: string; arguments?: string }
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
  /** numCtx: the context size later calls will ask for (Ollama loads the model again when it changes). */
  warm?(model: string, keepAlive: string, numCtx?: number): Promise<void>;
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
