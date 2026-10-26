import type { ModelInfo } from '@hivemind/shared';
import { readLines } from './lines.js';
import { checkResponse, foldSystem, ProviderError, type ChatRequest, type LoadedModel, type ProviderAdapter, type PullProgress, type ProviderConfig, type StreamChunk } from './types.js';

export function ollamaAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');

  return {
    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${base}/api/tags`);
      await checkResponse(res, 'Ollama /api/tags');
      const data = (await res.json()) as {
        models?: { name: string; size?: number; modified_at?: string; details?: { parameter_size?: string; quantization_level?: string } }[];
      };
      return (data.models ?? []).map((m) => ({
        providerId: cfg.id,
        model: m.name,
        name: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
        free: true,
        sizeBytes: m.size,
        quant: m.details?.quantization_level,
        modifiedAt: m.modified_at,
      }));
    },

    async *pull(model: string, signal: AbortSignal): AsyncIterable<PullProgress> {
      const res = await fetch(`${base}/api/pull`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
      });
      await checkResponse(res, `Ollama pull ${model}`);
      for await (const line of readLines(res.body!)) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
        if (msg.error) throw new ProviderError(`Ollama pull ${model}: ${msg.error}`);
        yield { status: msg.status ?? '', total: msg.total, completed: msg.completed };
      }
    },

    async freeMemory(): Promise<void> {
      for (const m of await this.loaded!()) await this.unload!(m.model);
    },

    async remove(model: string): Promise<void> {
      const res = await fetch(`${base}/api/delete`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      await checkResponse(res, `Ollama delete ${model}`);
    },

    async loaded(): Promise<LoadedModel[]> {
      const res = await fetch(`${base}/api/ps`);
      await checkResponse(res, 'Ollama /api/ps');
      const data = (await res.json()) as { models?: { name: string; size?: number; size_vram?: number; expires_at?: string }[] };
      return (data.models ?? []).map((m) => ({ model: m.name, sizeBytes: m.size ?? 0, vramBytes: m.size_vram ?? 0, expiresAt: m.expires_at }));
    },

    async unload(model: string): Promise<void> {
      // keep_alive 0 tells Ollama to drop the model from RAM/VRAM right away.
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
      });
      await checkResponse(res, `Ollama unload ${model}`);
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      // Tell the UI when the model still has to be loaded into VRAM.
      try {
        const ps = await fetch(`${base}/api/ps`, { signal });
        if (ps.ok) {
          const loaded = ((await ps.json()) as { models?: { name: string }[] }).models ?? [];
          yield loaded.some((m) => m.name === req.model) ? { type: 'warm' } : { type: 'loading' };
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
            ...(req.json && { format: 'json' }),
            ...(req.think === false && { think: false }),
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
      if (res.status === 401) {
        // Ollama cloud models (ollama.com/...) need the Ollama server to be signed in to ollama.com.
        const body = (await res.json().catch(() => ({}))) as { signin_url?: string };
        throw new ProviderError(
          `${req.model} is an Ollama cloud model and the Ollama server is not signed in to ollama.com. ` +
            `Run "ollama signin" inside the Ollama container${body.signin_url ? ` or open ${body.signin_url}` : ''}, or pick a local model.`,
          401,
        );
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
          load_duration?: number;
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
            loadMs: msg.load_duration ? msg.load_duration / 1e6 : undefined,
          };
          return;
        }
      }
    },
  };
}
