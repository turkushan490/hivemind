import type { ModelInfo } from '@hivemind/shared';
import { readSSE } from './lines.js';
import { anthropicMessages, checkResponse, type ChatRequest, type ProviderAdapter, type ProviderConfig, type StreamChunk } from './types.js';

const VERSION = '2023-06-01';

export function anthropicAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    'anthropic-version': VERSION,
    ...(cfg.apiKey && { 'x-api-key': cfg.apiKey }),
  });

  return {
    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${base}/v1/models?limit=100`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
      await checkResponse(res, 'Anthropic /v1/models');
      const data = (await res.json()) as { data?: { id: string; display_name?: string }[] };
      return (data.data ?? []).map((m) => ({ providerId: cfg.id, model: m.id, name: m.display_name ?? m.id, free: false }));
    },

    async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = req.messages.filter((m) => m.role !== 'system');
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: headers(),
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 8192,
          stream: true,
          messages: anthropicMessages(messages),
          ...(system && { system }),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.topP !== undefined && { top_p: req.topP }),
          ...(req.stop !== undefined && { stop_sequences: Array.isArray(req.stop) ? req.stop : [req.stop] }),
          ...(req.tools?.length && { tools: req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object', properties: {} } })) }),
          ...(req.tools?.length && anthropicChoice(req.toolChoice)),
        }),
      });
      await checkResponse(res, 'Anthropic messages');
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      // Content block index → tool call index (tool_use blocks only).
      const tools = new Map<number, number>();
      for await (const ev of readSSE(res.body!)) {
        switch (ev.type) {
          case 'content_block_start':
            if (ev.content_block?.type === 'tool_use') {
              tools.set(ev.index, tools.size);
              yield { type: 'tool_call', index: tools.get(ev.index)!, id: ev.content_block.id, name: ev.content_block.name };
            }
            break;
          case 'message_start':
            inputTokens = ev.message?.usage?.input_tokens;
            break;
          case 'content_block_delta':
            if (ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'token', text: ev.delta.text };
            else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) yield { type: 'thinking', text: ev.delta.thinking };
            else if (ev.delta?.type === 'input_json_delta' && tools.has(ev.index)) yield { type: 'tool_call', index: tools.get(ev.index)!, arguments: ev.delta.partial_json ?? '' };
            break;
          case 'message_delta':
            outputTokens = ev.usage?.output_tokens ?? outputTokens;
            break;
          case 'error':
            throw new Error(`Anthropic: ${ev.error?.message ?? 'stream error'}`);
          case 'message_stop':
            yield { type: 'done', inputTokens, outputTokens };
            return;
        }
      }
      yield { type: 'done', inputTokens, outputTokens };
    },
  };
}

/** OpenAI's tool_choice in Anthropic's words. */
function anthropicChoice(choice: unknown): { tool_choice?: Record<string, unknown> } {
  if (choice === 'required') return { tool_choice: { type: 'any' } };
  if (choice === 'none') return { tool_choice: { type: 'none' } };
  const name = (choice as { function?: { name?: string } } | undefined)?.function?.name;
  if (name) return { tool_choice: { type: 'tool', name } };
  return {};
}
