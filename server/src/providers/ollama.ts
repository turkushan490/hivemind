import type { ModelInfo } from '@hivemind/shared';
import { readLines } from './lines.js';
import { checkResponse, foldSystem, type ChatRequest, type ProviderAdapter, type ProviderConfig, type StreamChunk } from './types.js';

export function ollamaAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');

  return {
    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${base}/api/tags`);
      await checkResponse(res, 'Ollama /api/tags');
      const data = (await res.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
      return (data.models ?? []).map((m) => ({
        providerId: cfg.id,
        model: m.name,
        name: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
        free: true,
      }));
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      // Tell the UI when the model still has to be loaded into VRAM.
      try {
        const ps = await fetch(`${base}/api/ps`, { signal });
        if (ps.ok) {
          const loaded = ((await ps.json()) as { models?: { name: string }[] }).models ?? [];
          if (!loaded.some((m) => m.name === req.model)) yield { type: 'loading' };
        }
      } catch {}

      const chat = (messages: ChatRequest['messages']) =>
        fetch(`${base}/api/chat`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: req.model,
            messages,
            stream: true,
            options: {
              ...(req.temperature !== undefined && { temperature: req.temperature }),
              ...(req.maxTokens !== undefined && { num_predict: req.maxTokens }),
            },
          }),
        });
      let res = await chat(req.messages);
      if (!res.ok && req.messages.some((m) => m.role === 'system')) {
        // Some GGUF chat templates choke on system messages ("System message must be at the beginning").
        const detail = await res.clone().text().catch(() => '');
        if (/system/i.test(detail)) res = await chat(foldSystem(req.messages));
      }
      await checkResponse(res, 'Ollama /api/chat');
      for await (const line of readLines(res.body!)) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as {
          message?: { content?: string; thinking?: string };
          done?: boolean;
          error?: string;
          prompt_eval_count?: number;
          eval_count?: number;
          eval_duration?: number;
        };
        if (msg.error) throw new Error(`Ollama: ${msg.error}`);
        if (msg.message?.thinking) yield { type: 'thinking', text: msg.message.thinking };
        if (msg.message?.content) yield { type: 'token', text: msg.message.content };
        if (msg.done) {
          yield {
            type: 'done',
            inputTokens: msg.prompt_eval_count,
            outputTokens: msg.eval_count,
            genMs: msg.eval_duration ? msg.eval_duration / 1e6 : undefined,
          };
          return;
        }
      }
    },
  };
}
