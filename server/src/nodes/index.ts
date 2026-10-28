import { JUDGE_SYSTEM, REVIEW_SYSTEM, type CanvasNode, type ModelRef, type NodeType, type OutputFile, type SearchSource } from '@hivemind/shared';
import type { ChatMessage } from '../providers/types.js';
import { ACTION_NODES } from './actions.js';

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
  };
  /** Writes into the files folder without overwriting; returns the path used. */
  saveFile?(path: string, data: Buffer | string): OutputFile;
  /** Unloads idle models of the local AI servers on this GPU host (before an image model needs the memory). */
  freeGpu?(hostKey: string, exceptProviderId?: string): Promise<void>;
  /** Home Assistant address and token (Settings → Home Assistant), or undefined when not set up. */
  homeAssistant?(): { url: string; token: string } | undefined;
}

export interface NodeContext {
  node: CanvasNode;
  question: string;
  /** Named values sent with the run (POST /api/runs vars), filled in as {{vars.name}}. */
  vars: Record<string, string>;
  inputs: NodeInput[];
  /** Blocks wired after this one (for the Router). */
  outgoing: { id: string; label: string; type: NodeType }[];
  /** Streams one model call; token events are emitted by the engine. Defaults to the block's own model. */
  callModel(messages: ChatMessage[], model?: ModelRef): Promise<string>;
  /** Router: only these outgoing blocks run; the others are skipped. */
  choose(targetIds: string[]): void;
  /** A short status line shown on the block while it works. */
  progress(note: string): void;
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
  /** Needs config.models with at least this many models. */
  minModels?: number;
  execute(ctx: NodeContext): Promise<string>;
}

/**
 * Fills {{question}}, {{inputs}} and {{vars.name}} in one pass, so text that came in is never filled in again.
 * An unknown var becomes empty.
 */
export const fill = (tpl: string, ctx: Pick<NodeContext, 'question' | 'vars'>, inputs = '') =>
  tpl.replace(/\{\{\s*(question|inputs|vars\.([a-zA-Z0-9_]{1,40}))\s*\}\}/g, (_, k: string, name?: string) =>
    name !== undefined ? (ctx.vars?.[name] ?? '') : k === 'question' ? ctx.question : inputs,
  );

const withSystem = (system: string | undefined, user: string): ChatMessage[] =>
  system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];

/** Upstream results that are more than the bare question. */
const answers = (inputs: NodeInput[]) => inputs.filter((i) => i.type !== 'input');

function labelled(inputs: NodeInput[]): string {
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

export const NODES: Record<NodeType, NodeDefinition> = {
  input: {
    usesModel: false,
    async execute(ctx) {
      return ctx.question;
    },
  },

  llm: {
    usesModel: true,
    async execute(ctx) {
      const prev = answers(ctx.inputs);
      const { prompt } = ctx.node.config;
      const system = ctx.node.config.system && fill(ctx.node.config.system, ctx, labelled(prev));
      let user: string;
      if (prompt) user = fill(prompt, ctx, labelled(prev));
      else if (prev.length === 0) user = ctx.question;
      else user = `Question: ${ctx.question}\n\nInput from previous steps:\n\n${labelled(prev)}\n\nUse this input to answer the question.`;
      return ctx.callModel(withSystem(system, user));
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
      const prev = answers(ctx.inputs);
      if (prev.length === 0) throw new Error('Judge needs at least one answer as input');
      const body = prev
        .map((p, i) => (p.type === 'review' ? `### Review (${p.label})\n${p.text}` : `### Answer ${i + 1} (${p.label})\n${p.text}`))
        .join('\n\n');
      const contenders = prev.map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => p.type !== 'review');
      let user = fill(ctx.node.config.prompt ?? 'Question: {{question}}\n\n{{inputs}}', ctx, body);
      // With two or more answers the judge also names the best one, for the leaderboard; that line is removed again.
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
    async execute(ctx) {
      const options = ctx.outgoing;
      if (options.length === 0) throw new Error('Wire the Router to the blocks it can choose between');
      const passOn = answers(ctx.inputs).length ? labelled(answers(ctx.inputs)) : ctx.question;
      if (options.length === 1) {
        ctx.choose([options[0].id]);
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
    async execute(ctx) {
      const candidates = answers(ctx.inputs);
      if (candidates.length === 0) throw new Error('Vote needs answers wired into it');
      if (candidates.length === 1) return candidates[0].text;
      const voters = ctx.node.config.models!;
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
      const best = tally.indexOf(Math.max(...tally));
      if (counted) ctx.pickWinner?.(candidates[best].nodeId, candidates.map((c) => c.nodeId));
      const score = tally.map((t, i) => `${letter(i)} ${t}`).join(', ');
      ctx.progress(counted ? `Winner: ${candidates[best].label} · ${score}` : `No valid votes — passed on ${candidates[0].label}`);
      return candidates[best].text;
    },
  },

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
      const key = (ctx.node.config.key || 'default').trim();
      if (ctx.node.config.mode === 'save') {
        const prev = answers(ctx.inputs);
        const text = prev.length ? prev.map((p) => p.text).join('\n\n') : ctx.question;
        mem.save(key, `Q: ${ctx.question}\nA: ${text}`);
        ctx.progress(`Saved to "${key}"`);
        return text;
      }
      const items = mem.recall(key, Math.max(1, Math.min(50, ctx.node.config.limit ?? 5)));
      ctx.progress(items.length ? `Recalled ${items.length} from "${key}"` : `Nothing in "${key}" yet`);
      return items.length ? `Remembered from earlier (${key}):\n\n${items.map((m) => `[${m.at}]\n${m.text}`).join('\n\n')}` : '(nothing remembered yet)';
    },
  },

  // ---- Action ----
  ...ACTION_NODES,
};
