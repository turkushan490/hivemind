import type { ModelInfo } from '@hivemind/shared';
import { readSSE } from './lines.js';
import { checkResponse, type ChatRequest, type ProviderAdapter, type ProviderConfig, type StreamChunk } from './types.js';

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
      const res = await fetch(`${base}/models`, { headers: headers() });
      await checkResponse(res, `${cfg.preset} /models`);
      const data = (await res.json()) as { data?: OpenAIModel[] };
      return (data.data ?? []).map((m) => {
        const pIn = Number(m.pricing?.prompt);
        const pOut = Number(m.pricing?.completion);
        const priced = m.pricing && Number.isFinite(pIn) && Number.isFinite(pOut);
        const free = cfg.preset === 'openrouter' ? m.id.endsWith(':free') || (priced && pIn === 0 && pOut === 0) : isFreePreset(cfg.preset);
        return {
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

function isFreePreset(preset: string): boolean {
  return preset === 'groq' || preset === 'gemini';
}
