import type { ModelInfo } from '@hivemind/shared';
import { checkUrl, readCapped, timeoutSignal } from '../services/net.js';
import { readSSE } from './lines.js';
import { checkResponse, type ChatRequest, type GeneratedImage, type ImageRequest, type ProviderAdapter, type ProviderConfig, type StreamChunk } from './types.js';

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
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: headers(),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          stream_options: { include_usage: true },
          // Only providers known to accept it; others get the instruction in the prompt alone.
          ...(req.json && ['openai', 'groq'].includes(cfg.preset) && { response_format: { type: 'json_object' } }),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
        }),
      });
      await checkResponse(res, `${cfg.preset} chat`);
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      for await (const msg of readSSE(res.body!)) {
        if (msg.error) throw new Error(`${cfg.preset}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        const delta = msg.choices?.[0]?.delta;
        // OpenRouter/Groq send "reasoning", DeepSeek-style APIs "reasoning_content".
        const thinking = delta?.reasoning ?? delta?.reasoning_content;
        if (thinking) yield { type: 'thinking', text: thinking };
        const text = delta?.content;
        if (text) yield { type: 'token', text };
        if (msg.usage) usage = msg.usage;
      }
      yield { type: 'done', inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
    },
  };
}

/** OpenAI-compatible image models: DALL·E, gpt-image, and Google's Imagen through Gemini's compatible API. */
const IMAGE_MODEL = /^(models\/)?(dall-e|gpt-image|imagen)/i;

function isFreePreset(preset: string): boolean {
  return preset === 'groq' || preset === 'gemini';
}
