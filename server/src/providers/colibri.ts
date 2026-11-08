import type { LoadedModel, ModelInfo } from '@hivemind/shared';
import { acquire, cacheSlot, colibriAvailable, colibriBase, colibriSettings, installedModels, loadedModel, stopEngine, warmModel } from '../colibri/engine.js';
import { catalog, type CatalogModel } from '../colibri/models.js';
import { fromSystemOne, post } from './decisions.js';
import { readSSE } from './lines.js';
import { checkResponse, openaiMessages, ProviderError, type ChatRequest, type ProviderAdapter, type ProviderConfig, type StreamChunk } from './types.js';

/**
 * Colibri inside this container (src/colibri/engine.ts). Two providers share the one engine: "colibri" chats
 * (OpenAI-compatible) and "colibri-decisions" answers Decide blocks through its /v1/systemone, which has the same
 * request and reply as TypeSafe's Jev. Every installed model is offered; picking one that isn't loaded loads it.
 */

/** Names from the catalog when it was read recently; the folder name otherwise (an imported GGUF). */
let names = new Map<string, CatalogModel>();
let refreshing: Promise<void> | undefined;
function catalogNames() {
  refreshing ??= catalog()
    .then((c) => void (names = new Map(c.models.map((m) => [m.id, m]))))
    .catch(() => {})
    .finally(() => (refreshing = undefined));
  return refreshing;
}

// Read the names once at start, so the first model list doesn't wait for them.
if (colibriAvailable()) void catalogNames();

async function installedInfo(providerId: string, kind?: 'decision'): Promise<ModelInfo[]> {
  const list = installedModels();
  // The first list waits for the names; later ones use what is there and refresh behind.
  if (list.length && !names.size) await Promise.race([catalogNames(), new Promise((r) => setTimeout(r, 1500))]);
  else void catalogNames();
  return list.map((m) => {
    const c = names.get(m.model);
    // Giant models stream from the disk: well under a word per second, for overnight work.
    const name = c ? `${c.name}${c.size_class === 'large' ? ' (colibri, slow)' : ' (colibri)'}` : `${m.model} (colibri)`;
    return { providerId, model: m.model, name, free: true, sizeBytes: m.sizeBytes, ...(kind && { kind }) };
  });
}

function loaded(): LoadedModel[] {
  const l = loadedModel();
  if (!l) return [];
  const m = installedModels().find((x) => x.model === l.model);
  return [{ model: l.model, sizeBytes: m?.sizeBytes ?? 0, vramBytes: 0 }];
}

/** Shared by both providers: unloading one unloads the engine. */
const engineParts = {
  async loaded() {
    return loaded();
  },
  async unload() {
    await stopEngine();
  },
  // Only a model on the GPU has to make room; on the CPU it holds no VRAM.
  async freeMemory() {
    if (loadedModel()?.gpu) await stopEngine();
  },
  async warm(model: string, keep: string) {
    await warmModel(model, keep);
  },
};

export function colibriChatAdapter(cfg: ProviderConfig): ProviderAdapter {
  return {
    ...engineParts,
    listModels: () => installedInfo(cfg.id),

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      const t0 = Date.now();
      yield { type: loadedModel()?.model !== req.model ? 'loading' : 'warm' };
      const hold = await acquire(req.model, { keepAlive: req.keepAlive, signal });
      try {
        yield* chat(req, signal, hold.loaded ? Date.now() - t0 : undefined);
      } finally {
        hold.release();
      }
    },
  };
}

/** A conversation's slot: the same system prompt and first question land on the same cached prompt. */
const slotOf = (req: ChatRequest) => {
  const firstUser = req.messages.findIndex((m) => m.role === 'user');
  return cacheSlot('chat', JSON.stringify(req.messages.slice(0, firstUser + 1).map((m) => [m.role, m.role === 'user' && req.messages.length - 1 === firstUser ? '' : m.content])));
};

async function* chat(req: ChatRequest, signal: AbortSignal, loadMs: number | undefined): AsyncIterable<StreamChunk> {
  const res = await fetch(`${colibriBase()}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      messages: openaiMessages(req.messages),
      stream: true,
      ...(slotOf(req) !== undefined && { cache_slot: slotOf(req) }),
      stream_options: { include_usage: true },
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
      // think: false asks a thinking model (Qwen3.6, GLM) to answer straight away.
      ...(req.think === false && { enable_thinking: false, reasoning_effort: 'none' }),
      ...(req.think === true && { enable_thinking: true }),
    }),
  });
  if (res.status === 429) throw new ProviderError('Colibri is busy (its queue is full); try again in a moment', 429);
  await checkResponse(res, 'colibri chat');
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let stopped: 'length' | undefined;
  for await (const msg of readSSE(res.body!)) {
    if (msg.error) throw new Error(`colibri: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    const delta = msg.choices?.[0]?.delta;
    const thinking = delta?.reasoning_content ?? delta?.reasoning;
    if (thinking) yield { type: 'thinking', text: thinking };
    if (delta?.content) yield { type: 'token', text: delta.content };
    if (msg.usage) usage = msg.usage;
    if (msg.choices?.[0]?.finish_reason === 'length') stopped = 'length';
  }
  yield { type: 'done', inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, ...(loadMs !== undefined && { loadMs }), ...(stopped && { stopped }) };
}

export function colibriDecisionAdapter(cfg: ProviderConfig): ProviderAdapter {
  return {
    ...engineParts,
    listModels: () => installedInfo(cfg.id, 'decision'),

    // eslint-disable-next-line require-yield
    async *stream() {
      throw new ProviderError('This is the decisions side of colibri: use it in a Decide block, as the Auto model router, or pick the same model from "Colibri" to chat');
    },

    async decide(req, signal) {
      const t0 = Date.now();
      if (req.images?.length) throw new ProviderError('Colibri decisions read text only: no images');
      if (Object.values(req.questions).some((q) => q.type === 'box')) throw new ProviderError('Box questions need TypeSafe Jev 1.14');
      const hold = await acquire(req.model, { keepAlive: req.keepAlive, signal });
      const questions = Object.fromEntries(
        Object.entries(req.questions).map(([k, q]) => [k, { type: q.type, instructions: q.instructions, ...(q.criteria && { criteria: q.criteria }) }]),
      );
      // Any colibri model answers by scoring the options; a big one on the CPU takes its time.
      type Reply = { model?: string; answers?: Record<string, Record<string, unknown>>; usage?: { input_tokens?: number | null; output_tokens?: number | null } };
      let data: Reply;
      try {
        data = (await post(`${colibriBase()}/v1/systemone`, { model: req.model, state: req.state, questions, ...(cacheSlot('decide', '') !== undefined && { cache_slot: cacheSlot('decide', '') }) }, {}, signal, 'Colibri', colibriSettings().callSeconds * 1000)) as Reply;
      } finally {
        hold.release();
      }
      const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, fromSystemOne(data.answers?.[k] ?? {})]));
      return { answers, usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }, model: data.model ?? req.model, ms: Date.now() - t0 };
    },
  };
}
