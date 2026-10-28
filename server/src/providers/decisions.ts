import type { DecisionType, ModelInfo } from '@hivemind/shared';
import { ProviderError, type ProviderAdapter, type ProviderConfig } from './types.js';

/**
 * Decision models: they read a "state" and answer typed questions with probabilities, in about 0.1 s.
 * One internal shape, three wire formats (checked against each service's own docs and SDKs):
 * - TypeSafe Jev: POST /v1/systemone {model, state, questions:{name:{type, instructions, criteria}}}
 *   (box questions and images: "assets" + the TypeSafe-Danger-Zone-Images header, Jev 1.14+);
 * - Ollama decision models (Nimble, Tev1, Clef) and Ollama's cloud: the same /v1/systemone shape, images as base64 "images";
 * - OpenAI Decisions: POST /v1/decisions {model, input, questions:[{name, type:"predicate"|"choice"|"score", …}]}.
 */

export interface DecisionQuestionSpec {
  type: DecisionType;
  instructions: string;
  /** choice: option → description. score: levels low → high. noul: optional {true, false} descriptions. */
  criteria?: Record<string, string> | string[];
}

export interface DecisionRequest {
  model: string;
  state: string;
  questions: Record<string, DecisionQuestionSpec>;
  /** Images to judge (box questions, image questions): PNG / JPEG / WebP bytes. */
  images?: { data: Buffer; ext: string }[];
}

export type DecisionAnswer =
  | { type: 'noul'; p: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number }
  /** probabilities are keyed by level index ("0", "1", …); score is the weighted level. */
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence?: number }
  | { type: 'box'; box: { top: number; bottom: number; left: number; right: number }; confidence?: number }
  | { type: 'refusal' };

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  /** The model that answered (TypeSafe answers with the version, e.g. jev-1.14.0). */
  model: string;
  ms: number;
}

const TIMEOUT_MS = 30_000;

async function post(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal | undefined, what: string): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (timeout.aborted) throw new ProviderError(`${what} did not answer within ${TIMEOUT_MS / 1000} s`);
    const cause = (err as { cause?: { code?: string } }).cause;
    throw new ProviderError(`Can't reach ${what} at ${url}: ${cause?.code ?? (err as Error).message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const hint = res.status === 401 ? ' — the API key is missing or wrong (Settings → Providers)' : res.status === 429 ? ' — rate limited, try again shortly' : '';
    throw new ProviderError(`${what} answered HTTP ${res.status}${hint}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return res.json();
}

const sniff = (img: { data: Buffer; ext: string }) => {
  const d = img.data;
  if (d[0] === 0x89 && d[1] === 0x50) return 'png';
  if (d[0] === 0xff && d[1] === 0xd8) return 'jpg';
  if (d.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return img.ext.toLowerCase().replace('jpeg', 'jpg');
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A /v1/systemone answer (TypeSafe and Ollama) in the internal shape. */
export function fromSystemOne(raw: Record<string, any>): DecisionAnswer {
  switch (raw?.type) {
    case 'noul':
      return { type: 'noul', p: num(raw.noul) };
    case 'choice':
      return { type: 'choice', choice: String(raw.choice ?? ''), probabilities: raw.probabilities ?? {}, confidence: raw.confidence };
    case 'score':
      return { type: 'score', score: num(raw.score), probabilities: raw.probabilities ?? {}, confidence: raw.confidence };
    case 'box':
      return { type: 'box', box: { top: num(raw.box?.top), bottom: num(raw.box?.bottom), left: num(raw.box?.left), right: num(raw.box?.right) }, confidence: raw.confidence };
    default:
      return { type: 'refusal' };
  }
}

/** TypeSafe Jev and Ollama's /v1/systemone. */
export function systemOneAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const typesafe = cfg.preset === 'typesafe';
  const name = typesafe ? 'TypeSafe (Jev)' : cfg.preset === 'clef-cloud' ? 'Ollama cloud' : 'Ollama';
  const auth = (): Record<string, string> => (cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {});

  return {
    async listModels(): Promise<ModelInfo[]> {
      const info = (model: string, n = model): ModelInfo => ({
        providerId: cfg.id,
        model,
        name: n,
        kind: 'decision',
        free: !typesafe && cfg.preset !== 'clef-cloud',
        ...(typesafe && { price: { input: 0.042, output: 0 } }),
      });
      if (typesafe) {
        const res = await fetch(`${base}/v1/models`, { headers: auth() });
        if (!res.ok) throw new ProviderError(`TypeSafe /v1/models answered HTTP ${res.status}${res.status === 401 ? ' — check the API key' : ''}`, res.status);
        const data = (await res.json()) as { models?: { name: string }[] };
        const names = (data.models ?? []).map((m) => m.name);
        // The box model must be asked by version; offer it even when only aliases are listed.
        return [...new Set([...names, 'jev-latest', 'jev-1.14.0'])].map((m) => info(m));
      }
      if (cfg.preset === 'clef-cloud') return [info('clef', 'Clef'), info('clef-flash', 'Clef Flash')];
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) throw new ProviderError(`Ollama /api/tags answered HTTP ${res.status}`, res.status);
      const data = (await res.json()) as { models?: { name: string; size?: number }[] };
      // Ollama does not mark decision models; these are the families it ships with /v1/systemone.
      return (data.models ?? []).filter((m) => /^(nimble|tev1|clef)/i.test(m.name)).map((m) => ({ ...info(m.name), sizeBytes: m.size }));
    },

    // eslint-disable-next-line require-yield
    async *stream() {
      throw new ProviderError('This is a decision model: use it in a Decide block, as the Auto model router, or for Jev scoring');
    },

    async decide(req, signal) {
      const t0 = Date.now();
      const hasBox = Object.values(req.questions).some((q) => q.type === 'box');
      const images = req.images ?? [];
      if (hasBox && !typesafe) throw new ProviderError(`Box questions need TypeSafe Jev 1.14 — ${name} decision models can't find boxes`);
      if (hasBox && !images.length) throw new ProviderError('A box question needs an image: wire in a block whose output has a picture');
      const questions = Object.fromEntries(
        Object.entries(req.questions).map(([k, q]) => [k, { type: q.type, instructions: q.instructions, ...(q.criteria && q.type !== 'box' && { criteria: q.criteria }) }]),
      );
      let body: Record<string, unknown>;
      const headers = auth();
      if (typesafe) {
        // Each image gets a reference that is written into the state; TypeSafe puts the picture there.
        const refs = images.map((_, i) => `hm-image-${i + 1}`);
        const state = refs.length ? { text: req.state, images: refs.map((r) => `\`${r}\``).join(' ') } : req.state;
        body = { model: req.model, state, questions };
        if (refs.length) {
          body.assets = Object.fromEntries(images.map((img, i) => [refs[i], { type: 'image', format: sniff(img) === 'jpg' ? 'jpg' : 'png', data_base64: img.data.toString('base64') }]));
          headers['typesafe-danger-zone-images'] = 'true';
        }
      } else {
        body = { model: req.model, state: req.state, questions, ...(images.length && { images: images.map((i) => i.data.toString('base64')) }) };
      }
      const data = (await post(`${base}/v1/systemone`, body, headers, signal, name)) as {
        model?: string;
        answers?: Record<string, Record<string, unknown>>;
        usage?: { input_tokens?: number | null; output_tokens?: number | null };
      };
      const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, fromSystemOne(data.answers?.[k] ?? {})]));
      return { answers, usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }, model: data.model ?? req.model, ms: Date.now() - t0 };
    },
  };
}

/** OpenAI's Decisions API: predicate (= noul), choice with choices[], score with levels[]; answers come back as a list in order. */
export function openaiDecisionsAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    async listModels(): Promise<ModelInfo[]> {
      // Only gpt-6-luna is supported; there is no model list for decisions.
      return [{ providerId: cfg.id, model: 'gpt-6-luna', name: 'GPT-6 Luna (decisions)', kind: 'decision', free: false }];
    },

    // eslint-disable-next-line require-yield
    async *stream() {
      throw new ProviderError('This is a decision model: use it in a Decide block, as the Auto model router, or for Jev scoring');
    },

    async decide(req, signal) {
      const t0 = Date.now();
      if (Object.values(req.questions).some((q) => q.type === 'box')) throw new ProviderError('OpenAI Decisions has no box questions — use TypeSafe Jev 1.14');
      const names = Object.keys(req.questions);
      const questions = names.map((name) => {
        const q = req.questions[name];
        if (q.type === 'noul') return { name, type: 'predicate', instructions: q.instructions };
        if (q.type === 'choice') {
          const c = (q.criteria ?? {}) as Record<string, string>;
          return { name, type: 'choice', instructions: q.instructions, choices: Object.entries(c).map(([value, description]) => ({ value, ...(description && { description }) })) };
        }
        const levels = (q.criteria ?? []) as string[];
        return { name, type: 'score', instructions: q.instructions, levels: levels.map((label) => ({ label })) };
      });
      const images = req.images ?? [];
      const input = images.length
        ? [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: req.state },
                ...images.map((img) => ({ type: 'input_image', image_url: `data:image/${sniff(img) === 'jpg' ? 'jpeg' : sniff(img)};base64,${img.data.toString('base64')}` })),
              ],
            },
          ]
        : req.state;
      const data = (await post(`${base}/decisions`, { model: req.model, input, questions }, { authorization: `Bearer ${cfg.apiKey ?? ''}` }, signal, 'OpenAI Decisions')) as {
        model?: string;
        answers?: Record<string, any>[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const answers: Record<string, DecisionAnswer> = {};
      (data.answers ?? []).forEach((a, i) => {
        const name = typeof a.name === 'string' && a.name in req.questions ? a.name : names[i];
        if (!name) return;
        if (a.type === 'predicate') answers[name] = { type: 'noul', p: num(a.probability) };
        else if (a.type === 'choice')
          answers[name] = {
            type: 'choice',
            choice: String(a.choice),
            probabilities: Object.fromEntries((a.probabilities ?? []).map((p: { value: unknown; probability: number }) => [String(p.value), num(p.probability)])),
            confidence: a.confidence,
          };
        else if (a.type === 'score') {
          const levels = (req.questions[name].criteria ?? []) as string[];
          answers[name] = {
            type: 'score',
            score: num(a.score),
            probabilities: Object.fromEntries(
              (a.probabilities ?? []).map((p: { label: string; value: number; probability: number }) => [String(typeof p.value === 'number' ? p.value : levels.indexOf(p.label)), num(p.probability)]),
            ),
            confidence: a.confidence,
          };
        } else answers[name] = { type: 'refusal' };
      });
      for (const n of names) answers[n] ??= { type: 'refusal' };
      return { answers, usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }, model: data.model ?? req.model, ms: Date.now() - t0 };
    },
  };
}

export function decisionAdapter(cfg: ProviderConfig): ProviderAdapter {
  return cfg.preset === 'openai-decisions' ? openaiDecisionsAdapter(cfg) : systemOneAdapter(cfg);
}

/** The spam example from the Jev guide: Settings → Providers → Test runs it. */
export const SPAM_TEST: DecisionRequest['questions'] = {
  spam: { type: 'noul', instructions: 'Is this YouTube comment spam?' },
  wants: {
    type: 'choice',
    instructions: 'What does this commenter want?',
    criteria: { 'ask a question': 'Ask a real question about the video', 'say thanks': 'Thank the creator', 'promote something': 'Get people to buy, visit or contact' },
  },
  positive: { type: 'score', instructions: 'How positive is it?', criteria: ['Negative', 'Neutral', 'Positive'] },
};
export const SPAM_TEST_STATE = 'I checked out few comments and I got help by *👉 him 👈* Find Him *on in$ţă_ɢʀăᴍ* he helped me out fast and reliable 💯✅✅✅';
