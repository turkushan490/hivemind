import type { ModelInfo } from '@hivemind/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { withHostLock, type ResolvedProvider } from '../engine/run.js';
import type { ChatMessage, ChatRequest, ToolCall, ToolDef } from '../providers/types.js';
import { isOllamaDecisionModel } from '../providers/decisions.js';
import { allowedFor } from './access.js';
import { apiError } from './openaiCompat.js';
import { noteCall, startLiveCall } from './activity.js';
import { callCost } from './pricing.js';
import { runLimits } from './runLimits.js';
import { newId } from '../crypto.js';
import { logError } from '../errors.js';
import type { User } from '../api/auth.js';

/**
 * /v1 for coding agents (T3 Code / OpenCode, Continue, any OpenAI client): besides the canvases, the provider models
 * a person may use are "models" too ("colibri/qwen36-35b", "ollama/gemma4:e2b"), called directly with everything an
 * agent sends: several system messages, tools and tool results. Same rules as a run: access profiles, the run time
 * limit, the shared GPU queue, and usage in the stats.
 */

/** Context size API calls get on Ollama (its own default of 4096 is far too small for an agent's ~12k first request). */
export const API_NUM_CTX = 32768;

/** "colibri/qwen36-35b" → provider and model (the model may have slashes of its own: "ollama/hf.co/x/y:Q4"). */
export function splitModelId(id: string): { providerId: string; model: string } | undefined {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) return undefined;
  return { providerId: id.slice(0, i), model: id.slice(i + 1) };
}

type Part = { type?: string; text?: string; image_url?: { url?: string } | string };
type RawMessage = {
  role?: string;
  content?: string | Part[] | null;
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string | Record<string, unknown> }; extra_content?: Record<string, unknown> }[];
  tool_call_id?: string;
  name?: string;
};

const textOf = (c: RawMessage['content']) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p && (p.type === 'text' || p.type === undefined) && typeof p.text === 'string').map((p) => p.text).join('\n') : '';

function imagesOf(c: RawMessage['content']): { data: Buffer; ext: string }[] {
  if (!Array.isArray(c)) return [];
  const out: { data: Buffer; ext: string }[] = [];
  for (const p of c) {
    if (p?.type !== 'image_url') continue;
    const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
    const m = url?.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
    if (m) out.push({ ext: m[1].toLowerCase().replace('jpeg', 'jpg'), data: Buffer.from(m[2], 'base64') });
  }
  return out;
}

/**
 * The agent's messages as HiveMind's: every system (and "developer") message joined into one at the start (some chat
 * templates refuse a second one), tool calls and tool results kept, pictures as images.
 */
export function toChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('"messages" must be a non-empty array');
  const system: string[] = [];
  const rest: ChatMessage[] = [];
  const names = new Map<string, string>();
  for (const m of raw as RawMessage[]) {
    const role = m?.role;
    if (role === 'system' || role === 'developer') {
      const t = textOf(m.content).trim();
      if (t) system.push(t);
    } else if (role === 'user') {
      const images = imagesOf(m.content);
      rest.push({ role: 'user', content: textOf(m.content), ...(images.length && { images }) });
    } else if (role === 'assistant') {
      const calls: ToolCall[] = (m.tool_calls ?? []).map((c, i) => {
        const id = c.id || `call_${i}_${newId().slice(0, 8)}`;
        const name = c.function?.name ?? '';
        names.set(id, name);
        const args = c.function?.arguments;
        return { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}), ...(c.extra_content && typeof c.extra_content === 'object' && { extra: c.extra_content }) };
      });
      rest.push({ role: 'assistant', content: textOf(m.content), ...(calls.length && { toolCalls: calls }) });
    } else if (role === 'tool') {
      const id = m.tool_call_id ?? '';
      rest.push({ role: 'tool', content: textOf(m.content), toolCallId: id, toolName: m.name ?? names.get(id) });
    } else throw new Error(`Unknown message role "${String(role)}"`);
  }
  return system.length ? [{ role: 'system', content: system.join('\n\n') }, ...rest] : rest;
}

/** Tools from the request, checked for the shape providers need. */
export function toolsOf(raw: unknown): ToolDef[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('"tools" must be an array');
  return raw.map((t, i) => {
    const f = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function;
    if (!f || typeof f.name !== 'string' || !f.name) throw new Error(`tools[${i}] needs function.name`);
    const parameters = f.parameters && typeof f.parameters === 'object' ? (f.parameters as Record<string, unknown>) : undefined;
    return { type: 'function' as const, function: { name: f.name, ...(typeof f.description === 'string' && { description: f.description }), ...(parameters && { parameters }) } };
  });
}

/** Rough token count (4 characters a token) of what is sent, tools included, to refuse a request that can't fit. */
export const roughTokens = (messages: ChatMessage[], tools?: ToolDef[]) =>
  Math.ceil((messages.reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? '').length, 0) + JSON.stringify(tools ?? '').length) / 4);

/** Whether a model can use tools: what the provider says, else by kind (cloud APIs and colibri can). */
export function toolSupport(m: ModelInfo, kind: string, preset: string): boolean {
  if (m.tools !== undefined) return m.tools;
  return kind === 'openai' || kind === 'anthropic' || preset === 'colibri';
}

/** The provider models listed in /v1/models (chat models only: no image, decision or ComfyUI models). */
export interface ApiModel {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  tools: boolean;
}

export function isApiModel(m: ModelInfo, kind: string) {
  return !m.kind && kind !== 'comfyui' && kind !== 'decision' && !(kind === 'ollama' && isOllamaDecisionModel(m.model));
}

/** Calls one provider model for /v1/chat/completions and answers in OpenAI's format (streamed or not). */
export async function callApiModel(
  req: FastifyRequest,
  reply: FastifyReply,
  o: {
    user: User;
    id: string;
    providerId: string;
    model: string;
    provider: ResolvedProvider;
    freeGpu: (host: string, providerId?: string, need?: { model?: string; bytes?: number }) => Promise<unknown>;
    body: Record<string, unknown>;
  },
) {
  const { user, id, providerId, model, provider: p, body } = o;
  noteCall(req, { model: id });
  if (!allowedFor(user).model(providerId, model)) return reply.code(403).send(apiError(`You may not use ${model} (Settings → Access)`, 'permission_error', 'model_not_allowed'));
  let messages: ChatMessage[];
  let tools: ToolDef[] | undefined;
  try {
    messages = toChatMessages(body.messages);
    tools = toolsOf(body.tools);
  } catch (err) {
    return reply.code(400).send(apiError((err as Error).message));
  }
  const info = await p.modelInfo(model).catch(() => undefined);
  const ollama = p.local && p.adapter.pull !== undefined;
  const numCtx = ollama ? API_NUM_CTX : undefined;
  const limit = numCtx ?? info?.contextLength;
  const need = roughTokens(messages, tools);
  if (limit && need > limit)
    return reply
      .code(400)
      .send(apiError(`This request is about ${need} tokens and ${model} takes ${limit} here. Send less, or use a model with a bigger context.`, 'invalid_request_error', 'context_length_exceeded'));
  const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens);
  const chatReq: ChatRequest = {
    model,
    messages,
    ...(typeof body.temperature === 'number' && { temperature: body.temperature }),
    ...(typeof body.top_p === 'number' && { topP: body.top_p }),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 && { maxTokens: Math.round(maxTokens) }),
    ...((typeof body.stop === 'string' || Array.isArray(body.stop)) && { stop: body.stop as string | string[] }),
    ...(tools?.length && { tools, ...(body.tool_choice !== undefined && { toolChoice: body.tool_choice }) }),
    ...(numCtx && { numCtx }),
    ...(p.local && { keepAlive: '30m' }),
  };
  const limits = runLimits();
  const seconds = Math.max(limits.maxSeconds, p.callSeconds ?? 0);
  const runId = `api-${newId()}`;
  const stream = body.stream === true;
  const created = Math.floor(Date.now() / 1000);
  const base = { id: `chatcmpl-${runId}`, object: stream ? 'chat.completion.chunk' : 'chat.completion', created, model: id };

  const stop = new AbortController();
  let finished = false;
  reply.raw.on('close', () => {
    if (!finished) stop.abort();
  });
  const timer = setTimeout(() => stop.abort(), seconds * 1000);

  let send: ((data: unknown) => void) | undefined;
  let ping: NodeJS.Timeout | undefined;
  let note = ': waiting for GPU';
  if (stream) {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    send = (data) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    // Waiting for the GPU or a big model loading can take minutes: comments keep clients from timing out.
    ping = setInterval(() => reply.raw.write(`${note}\n\n`), 10_000);
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  }

  const now = startLiveCall(req, id, tools?.length ?? 0);
  now.set({ promptTokens: need });
  let firstAt = 0;
  let content = '';
  let reasoning = '';
  const calls: { id: string; name: string; arguments: string; extra?: Record<string, unknown> }[] = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let stopped: 'length' | undefined;
  let genMs: number | undefined;
  const work = async () => {
    note = ': working';
    now.set({ state: 'reading the prompt' });
    const t0 = Date.now();
    for await (const c of p.adapter.stream(chatReq, stop.signal)) {
      if (c.type === 'loading') {
        note = ': loading model';
        now.set({ state: 'loading the model' });
      } else if (c.type === 'warm') now.set({ state: 'reading the prompt' });
      else if (c.type === 'token') {
        note = ': working';
        if (!firstAt) firstAt = Date.now();
        now.write(c.text);
        now.set({ tokensPerSec: Math.round((now.set({}).tokens / Math.max(0.2, (Date.now() - firstAt) / 1000)) * 10) / 10 });
        content += c.text;
        send?.({ ...base, choices: [{ index: 0, delta: { content: c.text }, finish_reason: null }] });
      } else if (c.type === 'thinking') {
        if (!firstAt) firstAt = Date.now();
        now.write(c.text, true);
        reasoning += c.text;
        send?.({ ...base, choices: [{ index: 0, delta: { reasoning_content: c.text }, finish_reason: null }] });
      } else if (c.type === 'tool_call') {
        const call = (calls[c.index] ??= { id: c.id ?? `call_${c.index}_${newId().slice(0, 8)}`, name: '', arguments: '' });
        if (c.id) call.id = c.id;
        if (c.name) call.name += c.name;
        if (c.arguments) call.arguments += c.arguments;
        if (c.extra) call.extra = { ...call.extra, ...c.extra };
        if (!firstAt) firstAt = Date.now();
        now.set({ state: 'calling a tool', toolCalls: calls.filter(Boolean).map((x) => x.name).filter(Boolean) });
        send?.({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: c.index,
                    ...(c.id && { id: call.id, type: 'function' }),
                    function: { ...(c.name && { name: c.name }), ...(c.arguments !== undefined && { arguments: c.arguments }) },
                    ...(c.extra && { extra_content: c.extra }),
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      } else if (c.type === 'done') {
        usage = { prompt_tokens: c.inputTokens ?? 0, completion_tokens: c.outputTokens ?? 0 };
        stopped = c.stopped;
        genMs = c.genMs;
      }
    }
    // What the log shows for this call.
    const secs = genMs ? genMs / 1000 : firstAt ? (Date.now() - firstAt) / 1000 : 0;
    noteCall(req, {
      promptTokens: usage.prompt_tokens || undefined,
      completionTokens: usage.completion_tokens || undefined,
      ...(secs > 0 && usage.completion_tokens && { tokensPerSec: Math.round((usage.completion_tokens / secs) * 10) / 10 }),
      ...(firstAt && { firstTokenMs: firstAt - t0 }),
      ...(calls.length && { toolCalls: calls.filter(Boolean).map((x) => x.name) }),
    });
  };

  try {
    if (p.local && p.exclusive !== false) {
      await withHostLock(
        p.hostKey,
        async () => {
          await o.freeGpu(p.hostKey, providerId, { model, bytes: info?.sizeBytes }).catch(() => {});
          await work();
        },
        { signal: stop.signal, label: `API: ${model}` },
      );
    } else await work();
  } catch (err) {
    finished = true;
    now.finish();
    clearTimeout(timer);
    if (ping) clearInterval(ping);
    const why = stop.signal.aborted && !reply.raw.destroyed ? `${model} was stopped after ${seconds} seconds` : (err as Error).message;
    logError({ source: 'run', message: `/v1 ${id}: ${why}`, userId: user.id });
    if (send) {
      send(apiError(why, 'server_error', 'model_failed'));
      reply.raw.end();
      return;
    }
    return reply.code(502).send(apiError(why, 'server_error', 'model_failed'));
  }
  finished = true;
  now.finish();
  clearTimeout(timer);
  if (ping) clearInterval(ping);
  const toolCalls = calls.filter(Boolean);
  const finish = toolCalls.length ? 'tool_calls' : stopped === 'length' ? 'length' : 'stop';
  noteCall(req, { finish });
  try {
    const cost = callCost(info, model, usage.prompt_tokens, usage.completion_tokens);
    db.prepare('INSERT INTO run_usage (run_id, owner_id, node_id, node_type, provider_id, model, input_tokens, output_tokens, cost, gen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      runId,
      user.id,
      'v1',
      'api',
      providerId,
      model,
      usage.prompt_tokens,
      usage.completion_tokens,
      cost ?? null,
      genMs ?? null,
    );
  } catch {}
  const u = { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
  if (send) {
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) send({ ...base, choices: [], usage: u });
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return;
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || (toolCalls.length ? null : ''),
          ...(reasoning && { reasoning_content: reasoning }),
          ...(toolCalls.length && {
            tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' }, ...(c.extra && { extra_content: c.extra }) })),
          }),
        },
        finish_reason: finish,
      },
    ],
    usage: u,
  };
}
