import { JUDGE_SYSTEM, REVIEW_SYSTEM, type CanvasNode, type NodeType } from '@hivemind/shared';
import type { ChatMessage } from '../providers/types.js';

/** Output of an upstream node, as seen by the node that runs next. */
export interface NodeInput {
  nodeId: string;
  type: NodeType;
  label: string;
  text: string;
}

export interface NodeContext {
  node: CanvasNode;
  question: string;
  inputs: NodeInput[];
  /** Streams one model call; token events are emitted by the engine. */
  callModel(messages: ChatMessage[]): Promise<string>;
}

export interface NodeDefinition {
  /** Whether this node calls a model (needs config.model). */
  usesModel: boolean;
  execute(ctx: NodeContext): Promise<string>;
}

const fill = (tpl: string, question: string, inputs: string) =>
  tpl.replaceAll('{{question}}', question).replaceAll('{{inputs}}', inputs);

const withSystem = (system: string | undefined, user: string): ChatMessage[] =>
  system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];

/** Upstream results that are more than the bare question. */
const answers = (inputs: NodeInput[]) => inputs.filter((i) => i.type !== 'input');

function labelled(inputs: NodeInput[]): string {
  return inputs.map((i) => `### ${i.label}\n${i.text}`).join('\n\n');
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');

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
      const { prompt, system } = ctx.node.config;
      let user: string;
      if (prompt) user = fill(prompt, ctx.question, labelled(prev));
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
      const user = fill(ctx.node.config.prompt ?? 'Question: {{question}}\n\n{{inputs}}', ctx.question, body);
      return ctx.callModel(withSystem(ctx.node.config.system ?? REVIEW_SYSTEM, user));
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
      const user = fill(ctx.node.config.prompt ?? 'Question: {{question}}\n\n{{inputs}}', ctx.question, body);
      return ctx.callModel(withSystem(ctx.node.config.system ?? JUDGE_SYSTEM, user));
    },
  },

  output: {
    usesModel: false,
    async execute(ctx) {
      const prev = answers(ctx.inputs);
      return prev.map((p) => p.text).join('\n\n---\n\n');
    },
  },
};
