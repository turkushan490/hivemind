import { AUTO_TIER_TEXT, AUTO_TIERS, JUDGE_SYSTEM, REVIEW_SYSTEM, type AutoTier, type CanvasNode, type DecisionEvent, type NodeConfig, type ModelRef, type NodeType, type OutputFile, type SearchSource } from '@hivemind/shared';
import type { DecisionRequest, DecisionResult } from '../providers/decisions.js';
import type { ChatMessage } from '../providers/types.js';
import { DECIDE_NODE, DEFAULT_THRESHOLD, toView } from './decide.js';
import { ACTION_NODES } from './actions.js';
import { TRAINING_NODES } from './training.js';

/** Output of an upstream node, as seen by the node that runs next. */
export interface NodeInput {
  nodeId: string;
  type: NodeType;
  label: string;
  text: string;
}

/** Things outside the graph a block may use. Missing services make those blocks fail with a clear message. */
export interface NodeServices {
  search?(query: string, opts: { source?: SearchSource; count?: number }): Promise<{ title: string; url: string; text: string }[]>;
  memory?: {
    recall(key: string, limit: number): { text: string; at: string }[];
    save(key: string, text: string): void;
    /** The best matches for a query (full-text, BM25). */
    search?(key: string, query: string, limit: number): { text: string; score: number; at: string }[];
  };
  /** Writes into the files folder without overwriting; returns the path used. */
  saveFile?(path: string, data: Buffer | string): OutputFile;
  /** Unloads idle models of the local AI servers on this GPU host (before an image model needs the memory). */
  freeGpu?(hostKey: string, exceptProviderId?: string): Promise<void>;
  /** Home Assistant address and token (Settings → Home Assistant), or undefined when not set up. */
  homeAssistant?(): { url: string; token: string } | undefined;
  /** Training blocks: datasets, training jobs and deploying models, for the user who runs the canvas (not viewers). */
  training?: {
    addExamples(
      dataset: string,
      items: { input?: string; output?: string; system?: string; ref?: string }[],
      opts: { review?: boolean; source: 'generated' | 'block' },
    ): { name: string; added: number; items: number; pending: number };
    sample(dataset: string, n: number): { input: string; output: string; system: string | null }[];
    startTrain(opts: { dataset: string; base: string; name: string; target?: string; epochs?: number }): { id: string; name: string; rows: number; state: string };
    deploy(pattern: string, model: ModelRef): { canvases: number; blocks: number };
  };
  /** Reads a file from the files folder (images for box questions). */
  readFile?(path: string): Buffer;
}

/** A chat sent through /v1: its system messages and the turns before the last question. */
export interface ChatContext {
  system: string;
  history: ChatMessage[];
}

export interface NodeContext {
  node: CanvasNode;
  question: string;
  /** Named values sent with the run (POST /api/runs vars), filled in as {{vars.name}}. */
  vars: Record<string, string>;
  /** {{system}} and {{history}}: the conversation that came in over /v1 (empty otherwise). */
  chat?: ChatContext;
  inputs: NodeInput[];
  /** Blocks wired after this one (for the Router). */
  outgoing: { id: string; label: string; type: NodeType }[];
  /** Streams one model call; token events are emitted by the engine. Defaults to the block's own model. */
  callModel(messages: ChatMessage[], model?: ModelRef, opts?: { json?: boolean }): Promise<string>;
  /** Router: only these outgoing blocks run; the others are skipped. */
  choose(targetIds: string[]): void;
  /** A short status line shown on the block while it works (with a decision: the probability bars). */
  progress(note: string, decision?: DecisionEvent): void;
  /** Asks a decision model (the block's own, or the one given); usage and cost are recorded like model calls. */
  decide(req: Omit<DecisionRequest, 'model'>, model?: ModelRef): Promise<DecisionResult>;
  /** Judge / Vote: which wired-in block gave the best answer, out of which ones (for the leaderboard). */
  pickWinner?(winnerNodeId: string, contenderNodeIds: string[]): void;
  /** Makes images with the block's (image) model; they are saved and attached to the block. */
  generateImage(prompt: string): Promise<OutputFile[]>;
  /** Shows a file this block wrote on the block and in the final answer. */
  attach(file: OutputFile): void;
  services: NodeServices;
  /** Aborted when the run is cancelled. */
  signal?: AbortSignal;
}

export interface NodeDefinition {
  /** Needs config.model. */
  usesModel: boolean;
  /** This configuration needs no config.model / config.models after all (Auto model, Jev router, Jev scoring). */
  modelOptional?(c: NodeConfig): boolean;
  /** A readable problem with the configuration, checked before the run starts. */
  check?(c: NodeConfig): string | undefined;
  /** Needs config.models with at least this many models. */
  minModels?: number;
  execute(ctx: NodeContext): Promise<string>;
}

/** Earlier chat turns as "User: …" / "Assistant: …" text. */
export const historyText = (history: ChatMessage[]) =>
  history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');

/**
 * Fills {{question}}, {{inputs}}, {{system}}, {{history}} and {{vars.name}} in one pass, so text that came in
 * is never filled in again. An unknown var becomes empty.
 */
export const fill = (tpl: string, ctx: Pick<NodeContext, 'question' | 'vars'> & { chat?: ChatContext }, inputs = '') =>
  tpl.replace(/\{\{\s*(question|inputs|system|history|vars\.([a-zA-Z0-9_]{1,40}))\s*\}\}/g, (_, k: string, name?: string) => {
    if (name !== undefined) return ctx.vars?.[name] ?? '';
    if (k === 'question') return ctx.question;
    if (k === 'system') return ctx.chat?.system ?? '';
    if (k === 'history') return historyText(ctx.chat?.history ?? []);
    return inputs;
  });

/** The answer without ``` fences, parsed as JSON; throws with the parser's message. */
export function parseJson(text: string): unknown {
  const t = text.trim();
  const body = t.match(/^```[\w-]*\s*\n?([\s\S]*?)\n?```$/)?.[1] ?? fenced(t, ['json', '']) ?? t;
  return JSON.parse(body.trim());
}

/**
 * JSON mode: asks for JSON (with the block's schema in the system prompt), checks it, and asks once more
 * with the parser's error when it isn't valid. Returns the normalised JSON text.
 */
export async function jsonCall(ctx: NodeContext, messages: ChatMessage[], model?: ModelRef): Promise<string> {
  const schema = ctx.node.config.jsonSchema?.trim();
  const rule = `Reply with only valid JSON, no other text.${schema ? `\nThe JSON must have this shape:\n${schema}` : ''}`;
  const sys = messages.findIndex((m) => m.role === 'system');
  const asked: ChatMessage[] =
    sys >= 0 ? messages.map((m, i) => (i === sys ? { ...m, content: `${m.content}\n\n${rule}` } : m)) : [{ role: 'system', content: rule }, ...messages];
  const reply = await ctx.callModel(asked, model, { json: true });
  try {
    return JSON.stringify(parseJson(reply));
  } catch (err) {
    ctx.progress('Answer was not valid JSON — asking for a fix');
    const fixed = await ctx.callModel(
      [...asked, { role: 'assistant', content: reply }, { role: 'user', content: `Your last answer was not valid JSON: ${(err as Error).message}. Reply with only the corrected JSON.` }],
      model,
      { json: true },
    );
    try {
      return JSON.stringify(parseJson(fixed));
    } catch {
      throw new Error('Invalid JSON after repair');
    }
  }
}

/** Calls the block's model, in JSON mode when the block asks for it. */
const ask = (ctx: NodeContext, messages: ChatMessage[], model?: ModelRef) => (ctx.node.config.json ? jsonCall(ctx, messages, model) : ctx.callModel(messages, model));

const withSystem = (system: string | undefined, user: string): ChatMessage[] =>
  system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];

/** The memory key after filling in {{vars.name}} (one memory per campaign: "dnd:{{vars.tableId}}"); trimmed, at most 120 chars, "default" when empty. */
export function memoryKey(tpl: string | undefined, ctx: Pick<NodeContext, 'question' | 'vars'>): string {
  return fill(tpl ?? '', ctx).trim().slice(0, 120).trim() || 'default';
}

/** Upstream results that are more than the bare question. */
export const answers = (inputs: NodeInput[]) => inputs.filter((i) => i.type !== 'input');

export function labelled(inputs: NodeInput[]): string {
  return inputs.map((i) => `### ${i.label}\n${i.text}`).join('\n\n');
}

/** "2026-10-26_14-05" for file names. */
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'answer';

/** The contents of the first ``` block (optionally of a given language), or undefined. */
function fenced(text: string, langs?: string[]): string | undefined {
  for (const m of text.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)) {
    if (!langs || langs.includes(m[1].toLowerCase())) return m[2].trim();
  }
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
const modelName = (m: ModelRef) => m.model.split('/').pop()!.replace(/:latest$/, '');

/** Takes the judge's "BEST: 2" line off its answer. */
export function splitBest(reply: string): { text: string; best?: number } {
  let best: number | undefined;
  const text = reply
    .replace(/^[ \t>*_#]*best(?: answer)?[*_]*\s*[:=]\s*[*_]*\s*(?:answer\s*)?#?(\d+)[^\n]*$/gim, (_, n: string) => {
      best = Number(n);
      return '';
    })
    .trimEnd();
  return { text, best };
}

/** Extra material (search results, files, memory) wired into a block, as a context section. */
function context(inputs: NodeInput[]): string {
  const prev = answers(inputs);
  return prev.length ? `\n\nUse this material:\n\n${labelled(prev)}` : '';
}

const modelLabel = (m: ModelRef) => m.model.split('/').pop()!.replace(/:latest$/, '');

/**
 * Auto model (the Jev router): a decision model reads the question and picks a model size; under the threshold
 * it moves up one size, because a too-small model is the costly mistake. Returns the model that answers.
 */
export async function autoModel(ctx: NodeContext, state: string): Promise<ModelRef> {
  const a = ctx.node.config.auto ?? {};
  const tiers = AUTO_TIERS.filter((t) => a[t]);
  if (!tiers.length) throw new Error('Auto model: fill in at least one size (small / medium / large / local)');
  if (tiers.length === 1) return a[tiers[0]]!;
  if (!a.decider) throw new Error('Auto model: pick the decision model that chooses the size');
  const criteria = Object.fromEntries(tiers.map((t) => [t, AUTO_TIER_TEXT[t]]));
  const spec = { type: 'choice' as const, instructions: 'Which size of AI model does this request need to be answered correctly?', criteria };
  ctx.progress('Choosing a model size…');
  const r = await ctx.decide({ state: state.slice(0, 50_000), questions: { route: spec } }, a.decider);
  const ans = r.answers.route;
  const threshold = ctx.node.config.threshold ?? DEFAULT_THRESHOLD;
  let pick: AutoTier = ans?.type === 'choice' && tiers.includes(ans.choice as AutoTier) ? (ans.choice as AutoTier) : tiers[tiers.length - 1];
  const top = ans?.type === 'choice' ? (ans.probabilities[pick] ?? 0) : 0;
  let moved = false;
  if (top < threshold && pick !== tiers[tiers.length - 1]) {
    pick = tiers[tiers.indexOf(pick) + 1];
    moved = true;
  }
  const model = a[pick]!;
  const view = toView('route', ans ?? { type: 'refusal' }, spec);
  const route = `${pick}: ${modelLabel(model)}`;
  ctx.progress(`${moved ? `Only ${Math.round(top * 100)}% sure — one size up ` : ''}→ ${route}`, { model: r.model, ms: r.ms, answers: [view], threshold, route });
  return model;
}

const QUALITY_LEVELS = ['Wrong, off-topic or unhelpful', 'Partly right or incomplete', 'Mostly right and useful', 'Correct, complete and clear'];

/**
 * Jev scoring for Judge / Vote: every answer is scored on one quality scale (~0.1 s each), best first.
 * The scores show as bars on the block.
 */
export async function jevRank(ctx: NodeContext, candidates: NodeInput[]): Promise<{ input: NodeInput; score: number }[]> {
  const spec = { type: 'score' as const, instructions: 'How well does the Answer answer the Question?', criteria: QUALITY_LEVELS };
  ctx.progress(`Jev is scoring ${candidates.length} answers…`);
  const results = await Promise.all(
    candidates.map((c) => ctx.decide({ state: `Question: ${ctx.question}\n\nAnswer:\n${c.text}`.slice(0, 100_000), questions: { quality: spec } }, ctx.node.config.jevScore)),
  );
  const ranked = candidates
    .map((input, i) => {
      const a = results[i].answers.quality;
      return { input, score: a?.type === 'score' ? a.score : 0, view: toView(input.label, a ?? { type: 'refusal' }, spec) };
    })
    .sort((a, b) => b.score - a.score);
  ctx.progress(`Jev ranking: ${ranked.map((r) => `${r.input.label} ${r.score.toFixed(2)}`).join(' · ')}`, {
    model: results[0]?.model ?? '',
    ms: Math.max(...results.map((r) => r.ms)),
    answers: ranked.map((r) => r.view),
    route: ranked[0]?.input.label,
  });
  return ranked;
}

export const NODES: Record<NodeType, NodeDefinition> = {
  input: {
    usesModel: false,
    async execute(ctx) {
      return ctx.question;
    },
  },

  llm: {
    usesModel: true,
    modelOptional: (c) => !!c.auto,
    check: (c) => (c.auto && !AUTO_TIERS.some((t) => c.auto![t]) ? 'Auto model: fill in at least one size' : undefined),
    async execute(ctx) {
      const prev = answers(ctx.inputs);
      const { prompt } = ctx.node.config;
      const system = ctx.node.config.system && fill(ctx.node.config.system, ctx, labelled(prev));
      let user: string;
      if (prompt) user = fill(prompt, ctx, labelled(prev));
      else if (prev.length === 0) user = ctx.question;
      else user = `Question: ${ctx.question}\n\nInput from previous steps:\n\n${labelled(prev)}\n\nUse this input to answer the question.`;
      // Auto: the decision model picks which model answers, from the question (and what is wired in).
      const model = ctx.node.config.auto ? await autoModel(ctx, prev.length ? `${ctx.question}\n\n${labelled(prev)}` : ctx.question) : undefined;
      if (ctx.node.config.useMessages && ctx.chat) {
        // The real conversation: system prompts, the earlier turns, then this block's prompt.
        const sys = [system, ctx.chat.system].filter(Boolean).join('\n\n');
        return ask(ctx, [...(sys ? [{ role: 'system' as const, content: sys }] : []), ...ctx.chat.history, { role: 'user', content: user }], model);
      }
      return ask(ctx, withSystem(system, user), model);
    },
  },

  review: {
    usesModel: true,
    async execute(ctx) {
      const prev = answers(ctx.inputs);
      if (prev.length === 0) throw new Error('Review needs at least one answer as input');
      // Anonymous: reviewers only see letters, not model names.
      const body = prev.map((p, i) => `### Answer ${letter(i)}\n${p.text}`).join('\n\n');
      const user = fill(ctx.node.config.prompt ?? 'Question: {{question}}\n\n{{inputs}}', ctx, body);
      return ctx.callModel(withSystem(ctx.node.config.system ? fill(ctx.node.config.system, ctx) : REVIEW_SYSTEM, user));
    },
  },

  judge: {
    usesModel: true,
    async execute(ctx) {
      let prev = answers(ctx.inputs);
      if (prev.length === 0) throw new Error('Judge needs at least one answer as input');
      // Jev pre-ranking: the judge reads the answers best first, with their scores.
      const scores = new Map<string, number>();
      if (ctx.node.config.jevScore) {
        const reviews = prev.filter((p) => p.type === 'review');
        const ranked = await jevRank(ctx, prev.filter((p) => p.type !== 'review'));
        ranked.forEach((r) => scores.set(r.input.nodeId, r.score));
        prev = [...ranked.map((r) => r.input), ...reviews];
      }
      const scoreNote = (p: NodeInput) => (scores.has(p.nodeId) ? `, Jev score ${scores.get(p.nodeId)!.toFixed(2)}/${QUALITY_LEVELS.length - 1}` : '');
      const body = prev
        .map((p, i) => (p.type === 'review' ? `### Review (${p.label})\n${p.text}` : `### Answer ${i + 1} (${p.label}${scoreNote(p)})\n${p.text}`))
        .join('\n\n');
      const contenders = prev.map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => p.type !== 'review');
      let user = fill(ctx.node.config.prompt ?? 'Question: {{question}}\n\n{{inputs}}', ctx, body);
      // With two or more answers the judge also names the best one, for the leaderboard; that line is removed again.
      if (ctx.node.config.json) return jsonCall(ctx, withSystem(ctx.node.config.system ? fill(ctx.node.config.system, ctx) : JUDGE_SYSTEM, user));
      if (contenders.length >= 2) user += `\n\nAfter your final answer, add one last line exactly like "BEST: <number>" with the number of the best single answer (${contenders.map((c) => c.n).join(', ')}).`;
      const { text, best } = splitBest(await ctx.callModel(withSystem(ctx.node.config.system ? fill(ctx.node.config.system, ctx) : JUDGE_SYSTEM, user)));
      const winner = contenders.find((c) => c.n === best);
      if (winner) {
        ctx.pickWinner?.(winner.p.nodeId, contenders.map((c) => c.p.nodeId));
        ctx.progress(`Best answer: ${winner.p.label}`);
      }
      return text;
    },
  },

  output: {
    usesModel: false,
    async execute(ctx) {
      const prev = answers(ctx.inputs);
      return prev.map((p) => p.text).join('\n\n---\n\n');
    },
  },

  // ---- Logic ----

  router: {
    usesModel: true,
    modelOptional: (c) => c.decideWith === 'jev' && !!c.decider,
    check: (c) => (c.decideWith === 'jev' && !c.decider ? 'Router: pick the decision model that chooses the route' : undefined),
    async execute(ctx) {
      const options = ctx.outgoing;
      if (options.length === 0) throw new Error('Wire the Router to the blocks it can choose between');
      const passOn = answers(ctx.inputs).length ? labelled(answers(ctx.inputs)) : ctx.question;
      if (options.length === 1) {
        ctx.choose([options[0].id]);
        return passOn;
      }
      if (ctx.node.config.decideWith === 'jev' && ctx.node.config.decider) {
        // Jev: one choice question over the branch names, ~0.1 s instead of a model call.
        const names = [...new Set(options.map((o) => o.label))];
        const spec = { type: 'choice' as const, instructions: 'Which of these should handle this request?', criteria: Object.fromEntries(names.map((n) => [n, n])) };
        ctx.progress('Choosing a route…');
        const r = await ctx.decide({ state: `${ctx.question}${context(ctx.inputs)}`.slice(0, 50_000), questions: { route: spec } }, ctx.node.config.decider);
        const ans = r.answers.route;
        const label = ans?.type === 'choice' && names.includes(ans.choice) ? ans.choice : names[0];
        const top = ans?.type === 'choice' ? (ans.probabilities[label] ?? 0) : 0;
        const threshold = ctx.node.config.threshold ?? DEFAULT_THRESHOLD;
        ctx.choose(options.filter((o) => o.label === label).map((o) => o.id));
        ctx.progress(`Route: ${label}${top < threshold ? ` (only ${Math.round(top * 100)}% sure)` : ''}`, { model: r.model, ms: r.ms, answers: [toView('route', ans ?? { type: 'refusal' }, spec)], threshold, route: label });
        return passOn;
      }
      const list = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      ctx.progress('Choosing a route…');
      const reply = await ctx.callModel(
        withSystem(
          (ctx.node.config.system && fill(ctx.node.config.system, ctx)) ||
            'You route questions. Pick the single best option for the question. Reply with only the number of that option, nothing else.',
          `Question: ${ctx.question}${context(ctx.inputs)}\n\nOptions:\n${list}\n\nWhich option number?`,
        ),
      );
      // The first number in the reply that names an option; anything unclear goes to the first option.
      const n = [...reply.matchAll(/\d+/g)].map((m) => Number(m[0])).find((x) => x >= 1 && x <= options.length) ?? 1;
      const pick = options[n - 1];
      ctx.choose([pick.id]);
      ctx.progress(`Route: ${pick.label}`);
      return passOn;
    },
  },

  debate: {
    usesModel: false,
    minModels: 2,
    async execute(ctx) {
      const models = ctx.node.config.models!;
      const rounds = Math.max(1, Math.min(4, ctx.node.config.rounds ?? 2));
      const material = context(ctx.inputs);
      let latest: string[] = [];
      for (let r = 1; r <= rounds; r++) {
        const next: string[] = [];
        for (let i = 0; i < models.length; i++) {
          ctx.progress(`Round ${r} of ${rounds} · ${modelName(models[i])}`);
          const others = latest
            .map((a, j) => (j === i ? '' : `### ${modelName(models[j])}\n${a}`))
            .filter(Boolean)
            .join('\n\n');
          const user =
            r === 1
              ? `Question: ${ctx.question}${material}\n\nGive your answer.`
              : `Question: ${ctx.question}${material}\n\nYour previous answer:\n${latest[i]}\n\nThe other participants answered:\n\n${others}\n\n` +
                'Point out what they got wrong or missed in one or two lines, then give your improved final answer.';
          next.push(await ctx.callModel(withSystem(ctx.node.config.system ?? 'You take part in a debate between AI models. Be concise and correct.', user), models[i]));
        }
        latest = next;
      }
      return latest.map((a, i) => `### ${modelName(models[i])} (after ${rounds} round${rounds > 1 ? 's' : ''})\n${a}`).join('\n\n');
    },
  },

  vote: {
    usesModel: false,
    minModels: 1,
    modelOptional: (c) => !!c.jevScore,
    async execute(ctx) {
      const candidates = answers(ctx.inputs);
      if (candidates.length === 0) throw new Error('Vote needs answers wired into it');
      if (candidates.length === 1) return candidates[0].text;
      const voters = (ctx.node.config.models ?? []).filter((m) => m?.providerId && m.model);
      // Jev scoring: without voters the best score wins; with voters it breaks ties.
      const jev = ctx.node.config.jevScore ? await jevRank(ctx, candidates) : undefined;
      if (jev && !voters.length) {
        ctx.pickWinner?.(jev[0].input.nodeId, candidates.map((c) => c.nodeId));
        ctx.progress(`Winner: ${jev[0].input.label} · Jev ${jev[0].score.toFixed(2)}/${QUALITY_LEVELS.length - 1}`);
        return jev[0].input.text;
      }
      const body = candidates.map((c, i) => `### Answer ${letter(i)}\n${c.text}`).join('\n\n');
      const tally = new Array(candidates.length).fill(0);
      const letters = candidates.map((_, i) => letter(i));
      const allowed = `${letters.slice(0, -1).join(', ')} or ${letters.at(-1)}`;
      // The vote: one of the allowed letters, or nothing (anything else is not a vote).
      const read = (reply: string) => {
        const pick = reply.trim().toUpperCase().match(/([A-Z])/)?.[1] ?? reply.trim().toUpperCase()[0];
        const idx = pick ? pick.charCodeAt(0) - 65 : -1;
        return idx >= 0 && idx < candidates.length ? idx : -1;
      };
      let counted = 0;
      for (const v of voters) {
        ctx.progress(`${modelName(v)} is voting…`);
        const ask = `Question: ${ctx.question}\n\n${body}\n\nThere are exactly ${candidates.length} answers: ${allowed}. Which is best? Reply with only one letter: ${allowed}.`;
        const system = 'You compare answers and vote for the best one. Reply with only the letter of the best answer.';
        let idx = read(await ctx.callModel(withSystem(system, ask), v));
        // One stricter try when the reply is not one of the allowed letters.
        if (idx < 0) idx = read(await ctx.callModel(withSystem(system, `${ask}\n\nOnly ${allowed} are valid. One letter, nothing else.`), v));
        if (idx >= 0) {
          tally[idx]++;
          counted++;
        }
      }
      const most = Math.max(...tally);
      const jevScore = (i: number) => jev?.find((r) => r.input.nodeId === candidates[i].nodeId)?.score ?? 0;
      const best = tally.map((t, i) => i).filter((i) => tally[i] === most).sort((a, b) => jevScore(b) - jevScore(a))[0];
      if (counted) ctx.pickWinner?.(candidates[best].nodeId, candidates.map((c) => c.nodeId));
      const score = tally.map((t, i) => `${letter(i)} ${t}`).join(', ');
      ctx.progress(counted ? `Winner: ${candidates[best].label} · ${score}` : `No valid votes — passed on ${candidates[best].label}`);
      return candidates[best].text;
    },
  },

  decide: DECIDE_NODE,

  // ---- Data ----

  template: {
    usesModel: false,
    async execute(ctx) {
      return fill(ctx.node.config.prompt ?? '{{question}}\n\n{{inputs}}', ctx, labelled(answers(ctx.inputs))).trim();
    },
  },

  file: {
    usesModel: false,
    async execute(ctx) {
      const text = ctx.node.config.text?.trim();
      if (!text) throw new Error('No file loaded in this block');
      return text;
    },
  },

  search: {
    usesModel: false,
    async execute(ctx) {
      if (!ctx.services.search) throw new Error('Web search is not available here');
      // Search for what an earlier block wrote (e.g. a model turning the question into search words), else the question.
      const prev = answers(ctx.inputs);
      const query = (prev.length ? prev[prev.length - 1].text : ctx.question).slice(0, 300);
      const source = ctx.node.config.source;
      ctx.progress(`Searching${source ? ` ${source}` : ''}: ${query.slice(0, 60)}`);
      const results = await ctx.services.search(query, { source, count: ctx.node.config.count ?? 5 });
      if (results.length === 0) return `No search results for: ${query}`;
      ctx.progress(`${results.length} results`);
      return results.map((r, i) => `${i + 1}. ${r.title}\n${r.text}\n${r.url}`).join('\n\n');
    },
  },

  save: {
    usesModel: false,
    async execute(ctx) {
      if (!ctx.services.saveFile) throw new Error('Saving files is not available here');
      const prev = answers(ctx.inputs);
      const text = prev.length ? prev.map((p) => p.text).join('\n\n') : ctx.question;
      let format = ctx.node.config.format ?? 'auto';
      const html = fenced(text, ['html', 'htm']) ?? (/^\s*(<!doctype html|<html)/i.test(text) ? text.trim() : undefined);
      if (format === 'auto') format = html ? 'html' : 'md';
      // What goes in the file: the code from the answer for code formats, the whole answer otherwise.
      let body = text;
      let ext: string = format;
      if (format === 'html') body = html ?? fenced(text) ?? text;
      if (format === 'json') body = fenced(text, ['json', '']) ?? text;
      if (format === 'csv') body = fenced(text, ['csv', '']) ?? text;
      if (format === 'code') {
        const m = text.match(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/);
        body = m ? m[2].trim() : text;
        const lang = (m?.[1] ?? '').toLowerCase();
        const exts: Record<string, string> = { python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', bash: 'sh', sh: 'sh', shell: 'sh', css: 'css', sql: 'sql', go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', json: 'json', yaml: 'yml', yml: 'yml' };
        ext = exts[lang] ?? 'txt';
      }
      // Var values in a file name can't add folders.
      const safeVars = Object.fromEntries(Object.entries(ctx.vars ?? {}).map(([k, v]) => [k, v.replace(/[\\/]+|\.\.+/g, '-').slice(0, 80)]));
      const name = fill((ctx.node.config.fileName || `${slug(ctx.question)}-{{date}}`).replaceAll('{{date}}', stamp()), { question: slug(ctx.question), vars: safeVars });
      const file = ctx.services.saveFile(`outputs/${name.replace(/\.[a-z0-9]{1,5}$/i, '')}.${ext}`, body);
      ctx.attach(file);
      ctx.progress(`Saved ${file.path}`);
      return text;
    },
  },

  image: {
    usesModel: true,
    async execute(ctx) {
      // What to draw: a prompt template, else what the block before wrote (e.g. a model writing a prompt), else the question.
      const prev = answers(ctx.inputs);
      const prompt = ctx.node.config.prompt
        ? fill(ctx.node.config.prompt, ctx, prev.map((p) => p.text).join('\n\n'))
        : prev.length
          ? prev[prev.length - 1].text
          : ctx.question;
      const files = await ctx.generateImage(prompt.slice(0, 2000));
      return files.map((f) => `![image](hm-file:${f.path})`).join('\n') + `\n\nPrompt: ${prompt.slice(0, 500)}`;
    },
  },

  memory: {
    usesModel: false,
    async execute(ctx) {
      const mem = ctx.services.memory;
      if (!mem) throw new Error('Memory is not available here');
      const key = memoryKey(ctx.node.config.key, ctx);
      if (ctx.node.config.mode === 'save') {
        const prev = answers(ctx.inputs);
        const text = prev.length ? prev.map((p) => p.text).join('\n\n') : ctx.question;
        mem.save(key, `Q: ${ctx.question}\nA: ${text}`);
        ctx.progress(`Saved to "${key}"`);
        return text;
      }
      const limit = Math.max(1, Math.min(50, ctx.node.config.limit ?? 5));
      if (ctx.node.config.mode === 'search') {
        if (!mem.search) throw new Error('Memory search is not available here');
        // What to look up: the query template (e.g. {{vars.actions}}), else what the block before wrote, else the question.
        const prev = answers(ctx.inputs);
        const query = (ctx.node.config.query ? fill(ctx.node.config.query, ctx, labelled(prev)) : prev.length ? prev[prev.length - 1].text : ctx.question).trim().slice(0, 2000);
        if (!query) throw new Error('Nothing to search for: the query is empty');
        const hits = mem.search(key, query, limit);
        ctx.progress(hits.length ? `Found ${hits.length} in "${key}"` : `No match in "${key}"`);
        return hits.length ? `Found in memory (${key}) for "${query.slice(0, 80)}":\n\n${hits.map((h) => h.text).join('\n\n---\n\n')}` : `(nothing in "${key}" matches "${query.slice(0, 80)}")`;
      }
      const items = mem.recall(key, limit);
      ctx.progress(items.length ? `Recalled ${items.length} from "${key}"` : `Nothing in "${key}" yet`);
      return items.length ? `Remembered from earlier (${key}):\n\n${items.map((m) => `[${m.at}]\n${m.text}`).join('\n\n')}` : '(nothing remembered yet)';
    },
  },

  // ---- Action ----
  ...ACTION_NODES,

  // ---- Train ----
  ...TRAINING_NODES,
};
