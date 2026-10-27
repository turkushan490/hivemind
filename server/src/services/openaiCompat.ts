import type { CanvasGraph, RunEvent } from '@hivemind/shared';

/**
 * Mapping between the OpenAI chat API and canvases: every saved canvas is a "model",
 * the last user message is the question, the final answer is the reply.
 */

export interface CanvasModelRow {
  id: string;
  name: string;
  description?: string | null;
  updatedAt: string;
}

type ContentPart = { type?: string; text?: string };
export interface OpenAIMessage {
  role: string;
  content?: string | ContentPart[] | null;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** GET /v1/models: one model per canvas; the id is the canvas id, the slug of its name works too. */
export function modelList(rows: CanvasModelRow[]) {
  return {
    object: 'list',
    data: rows.map((r) => ({
      id: r.id,
      object: 'model',
      created: toUnix(r.updatedAt),
      owned_by: 'hivemind',
      name: r.name,
      slug: slugify(r.name),
      ...(r.description && { description: r.description }),
    })),
  };
}

/** The canvas a "model" names: its id first, then the slug of its name, then the name itself (any case). */
export function findCanvas<T extends { id: string; name: string }>(rows: T[], model: string): T | undefined {
  const m = model.trim();
  // Clients sometimes prefix the provider ("hivemind/my-canvas").
  const bare = m.replace(/^hivemind[/:]/i, '');
  return (
    rows.find((r) => r.id === m || r.id === bare) ??
    rows.find((r) => slugify(r.name) === slugify(bare)) ??
    rows.find((r) => r.name.toLowerCase() === bare.toLowerCase())
  );
}

const textOf = (content: OpenAIMessage['content']): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && (p.type === 'text' || p.type === undefined) && typeof p.text === 'string').map((p) => p.text).join('\n');
  return '';
};

/** The canvas input: the last user message with text. Throws a readable error when there is none. */
export function questionFrom(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('"messages" must be a non-empty array');
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as OpenAIMessage;
    if (m?.role !== 'user') continue;
    const text = textOf(m.content).trim();
    if (text) return text;
  }
  throw new Error('No user message with text in "messages"');
}

/**
 * The block whose tokens can be streamed live: the only block wired into the Final answer.
 * With several (a join, or Router branches) the answer is only known at the end, so nothing is streamed early.
 */
export function streamSource(graph: CanvasGraph): string | undefined {
  const outs = graph.nodes.filter((n) => n.type === 'output');
  if (outs.length !== 1) return;
  const parents = [...new Set(graph.edges.filter((e) => e.target === outs[0].id).map((e) => e.source))];
  if (parents.length !== 1) return;
  const p = graph.nodes.find((n) => n.id === parents[0]);
  return p && p.type !== 'input' ? p.id : undefined;
}

/** Token use of a whole run, from its node_done events. */
export function usageOf(events: RunEvent[]) {
  let prompt = 0;
  let completion = 0;
  for (const e of events) {
    if (e.type !== 'node_done') continue;
    prompt += e.inputTokens ?? 0;
    completion += e.tokens ?? 0;
  }
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

const toUnix = (s: string) => {
  const t = Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};
const now = () => Math.floor(Date.now() / 1000);

export function completion(id: string, model: string, text: string, usage: ReturnType<typeof usageOf>) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  };
}

/** One SSE chunk of a streamed completion. */
export function chunk(id: string, model: string, delta: { role?: 'assistant'; content?: string }, finish: 'stop' | null = null) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: now(),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** OpenAI-style error body. */
export const apiError = (message: string, type = 'invalid_request_error', code?: string) => ({ error: { message, type, code: code ?? null } });

const BEST_LINE = /^[ \t>*_#]*best(?: answer)?[*_]*\s*[:=]\s*[*_]*\s*(?:answer\s*)?#?\d+/i;

/**
 * Streams a block's tokens to an API client, but holds back a line that may be the judge's "BEST: 2"
 * marker (it is removed from the final answer). finish() returns whatever of the final answer was not sent.
 */
export class LiveText {
  private buffer = '';
  private lineOpen = false;
  sent = '';

  push(text: string): string {
    this.buffer += text;
    let out = '';
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (this.lineOpen) {
        if (nl < 0) {
          out += this.buffer;
          this.buffer = '';
          break;
        }
        out += this.buffer.slice(0, nl + 1);
        this.buffer = this.buffer.slice(nl + 1);
        this.lineOpen = false;
        continue;
      }
      const head = (nl < 0 ? this.buffer : this.buffer.slice(0, nl)).replace(/^[ \t>*_#]+/, '').toLowerCase();
      if (nl < 0 && (head.length < 4 ? 'best'.startsWith(head) : head.startsWith('best'))) break; // wait: may become "BEST: 2"
      if (nl >= 0 && BEST_LINE.test(this.buffer.slice(0, nl))) {
        this.buffer = this.buffer.slice(nl + 1); // never sent
        continue;
      }
      if (!this.buffer) break;
      this.lineOpen = true;
    }
    this.sent += out;
    return out;
  }

  finish(final: string): string {
    const base = this.sent.trimEnd();
    if (!final.startsWith(base)) return this.sent ? '' : final;
    let rest = final.slice(base.length);
    const ws = this.sent.slice(base.length);
    if (rest.startsWith(ws)) rest = rest.slice(ws.length);
    return rest;
  }
}
