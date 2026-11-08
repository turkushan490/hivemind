import type { ModelInfo } from '@hivemind/shared';
import { checkUrl, readCapped, timeoutSignal } from '../services/net.js';
import { readSSE } from './lines.js';
import { checkResponse, openaiMessages, type ChatRequest, type GeneratedImage, type ImageRequest, type ProviderAdapter, type ProviderConfig, type StreamChunk } from './types.js';

interface OpenAIModel {
  id: string;
  name?: string;
  context_length?: number;
  /** OpenRouter: USD per token as strings. */
  pricing?: { prompt?: string; completion?: string };
}

/** Any OpenAI-compatible chat API: OpenAI, OpenRouter, Groq, Gemini, OpenCode Zen, custom. */
export function openaiAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(cfg.apiKey && { authorization: `Bearer ${cfg.apiKey}` }),
    ...(cfg.preset === 'openrouter' && { 'x-title': 'HiveMind', 'http-referer': 'https://github.com/turkushan490/hivemind' }),
  });

  return {
    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
      await checkResponse(res, `${cfg.preset} /models`);
      const data = (await res.json()) as { data?: OpenAIModel[] };
      return (data.data ?? []).map((m) => {
        const pIn = Number(m.pricing?.prompt);
        const pOut = Number(m.pricing?.completion);
        const priced = m.pricing && Number.isFinite(pIn) && Number.isFinite(pOut);
        const free = cfg.preset === 'openrouter' ? m.id.endsWith(':free') || (priced && pIn === 0 && pOut === 0) : isFreePreset(cfg.preset);
        return {
          ...(IMAGE_MODEL.test(m.id) && { kind: 'image' as const }),
          providerId: cfg.id,
          // Gemini returns "models/gemini-x"; the chat endpoint wants it without the prefix.
          model: m.id.replace(/^models\//, ''),
          name: m.name ?? m.id.replace(/^models\//, ''),
          free: !!free,
          contextLength: m.context_length,
          ...(priced && { price: { input: pIn * 1e6, output: pOut * 1e6 } }),
        };
      });
    },

    async image(req: ImageRequest, signal: AbortSignal, onProgress: (note: string) => void): Promise<GeneratedImage[]> {
      const size = `${req.width}x${req.height}`;
      const want = Math.max(1, Math.min(8, Math.floor(req.batch ?? 1)));
      // DALL·E 3 makes one picture per request; the others take n.
      const one = /^dall-e-3/i.test(req.model);
      const items: { b64_json?: string; url?: string }[] = [];
      for (let i = 0; i < (one ? want : 1); i++) {
        onProgress(want > 1 ? `Asking the image API… (${one ? `${i + 1}/${want}` : `${want} pictures`})` : 'Asking the image API…');
        const res = await fetch(`${base}/images/generations`, {
          method: 'POST',
          signal,
          headers: headers(),
          body: JSON.stringify({ model: req.model, prompt: req.prompt, n: one ? 1 : want, size, ...(/^dall-e/i.test(req.model) && { response_format: 'b64_json' }) }),
        });
        await checkResponse(res, `${cfg.preset} images`);
        items.push(...(((await res.json()) as { data?: { b64_json?: string; url?: string }[] }).data ?? []));
      }
      return Promise.all(
        items.map(async (d) => {
          if (d.b64_json) return { data: Buffer.from(d.b64_json, 'base64'), ext: 'png' };
          // A link the API hands back: same address guard as the Webhook block, and a size cap.
          await checkUrl(d.url!, 'The image link from the image API');
          const r = await fetch(d.url!, { signal: timeoutSignal(120_000, signal), redirect: 'error' });
          await checkResponse(r, `${cfg.preset} image download`);
          return { data: await readCapped(r, 50 * 1024 * 1024, 'The image'), ext: 'png' };
        }),
      );
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      // think: false also for cloud reasoning models (Gemini, gpt-oss), which otherwise think before every answer.
      const effort = req.think === false ? noThinking(cfg.preset, req.model) : undefined;
      const send = (withEffort: boolean) =>
        fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: headers(),
        body: JSON.stringify({
          ...(withEffort && effort && { reasoning_effort: effort }),
          model: req.model,
          messages: openaiMessages(cfg.preset === 'gemini' ? withThoughtSignatures(req.messages) : req.messages),
          stream: true,
          stream_options: { include_usage: true },
          // Only providers known to accept it; others get the instruction in the prompt alone.
          ...(req.json && ['openai', 'groq'].includes(cfg.preset) && { response_format: { type: 'json_object' } }),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
          ...toolFields(req),
        }),
      });
      let res = await send(true);
      // A model that has no such setting refuses it: ask again without.
      if (effort && res.status === 400) {
        const detail = await res.clone().text().catch(() => '');
        if (/reasoning|effort|thinking/i.test(detail)) res = await send(false);
      }
      await checkResponse(res, `${cfg.preset} chat`);
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      let stopped: 'length' | undefined;
      for await (const msg of readSSE(res.body!)) {
        if (msg.error) throw new Error(`${cfg.preset}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        const delta = msg.choices?.[0]?.delta;
        // OpenRouter/Groq send "reasoning", DeepSeek-style APIs "reasoning_content".
        const thinking = delta?.reasoning ?? delta?.reasoning_content;
        if (thinking) yield { type: 'thinking', text: thinking };
        const text = delta?.content;
        if (text) yield { type: 'token', text };
        yield* toolDeltas(delta?.tool_calls);
        if (msg.usage) usage = msg.usage;
        if (msg.choices?.[0]?.finish_reason === 'length') stopped = 'length';
      }
      yield { type: 'done', inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, ...(stopped && { stopped }) };
    },
  };
}

/** tools, tool_choice, stop and top_p for an OpenAI-compatible request (only what the caller set). */
export function toolFields(req: ChatRequest) {
  return {
    ...(req.tools?.length && { tools: req.tools }),
    ...(req.tools?.length && req.toolChoice !== undefined && { tool_choice: req.toolChoice }),
    ...(req.stop !== undefined && { stop: req.stop }),
    ...(req.topP !== undefined && { top_p: req.topP }),
  };
}

/** OpenAI's streamed tool_calls deltas as tool_call chunks. */
export function* toolDeltas(calls: unknown): Iterable<StreamChunk> {
  if (!Array.isArray(calls)) return;
  for (const c of calls as { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }[]) {
    yield {
      type: 'tool_call',
      index: c.index ?? 0,
      ...(c.id && { id: c.id }),
      ...(c.function?.name && { name: c.function.name }),
      ...(c.function?.arguments && { arguments: c.function.arguments }),
      // Gemini: the thought signature that has to go back with this call next turn.
      ...(c.extra_content && { extra: c.extra_content }),
    };
  }
}

/** OpenAI-compatible image models: DALL·E, gpt-image, and Google's Imagen through Gemini's compatible API. */
const IMAGE_MODEL = /^(models\/)?(dall-e|gpt-image|imagen)/i;

/** The "think as little as possible" setting of a cloud API, when it has one. */
export function noThinking(preset: string, model: string): string | undefined {
  if (preset === 'gemini') return 'none';
  if (/gpt-oss/i.test(model)) return 'low';
  if (preset === 'openai' && /^(o\d|gpt-5)/i.test(model)) return 'minimal';
  return undefined;
}

function isFreePreset(preset: string): boolean {
  return preset === 'groq' || preset === 'gemini';
}

/**
 * Gemini wants each earlier tool call back with its thought signature. A client that dropped it (most agents do)
 * gets Google's documented placeholder, so the conversation can go on instead of failing with HTTP 400.
 */
export function withThoughtSignatures(messages: ChatRequest['messages']): ChatRequest['messages'] {
  return messages.map((m) =>
    m.toolCalls?.length ? { ...m, toolCalls: m.toolCalls.map((c) => (c.extra ? c : { ...c, extra: { google: { thought_signature: 'skip_thought_signature_validator' } } })) } : m,
  );
}
