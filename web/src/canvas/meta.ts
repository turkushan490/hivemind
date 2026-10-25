import type { NodeType } from '@hivemind/shared';

export interface NodeMeta {
  title: string;
  color: string;
  description: string;
  usesModel: boolean;
  hasInput: boolean;
  hasOutput: boolean;
}

export const NODE_META: Record<NodeType, NodeMeta> = {
  input: {
    title: 'Question',
    color: '#818cf8',
    description: 'Where the question comes in. Every canvas starts here.',
    usesModel: false,
    hasInput: false,
    hasOutput: true,
  },
  llm: {
    title: 'AI model',
    color: '#22d3ee',
    description: 'Answers using one model. Gets the question, or the answers of the nodes wired into it.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  review: {
    title: 'Review',
    color: '#fbbf24',
    description: 'Critiques and ranks the answers wired into it. Model names are hidden (Answer A, B, C).',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  judge: {
    title: 'Judge',
    color: '#f472b6',
    description: 'Merges all incoming answers and reviews into one final answer and notes where models disagreed.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  output: {
    title: 'Final answer',
    color: '#34d399',
    description: 'The result of the canvas: what the chat, phone app and Home Assistant get back.',
    usesModel: false,
    hasInput: true,
    hasOutput: false,
  },
};

/** Planned node types, shown in the palette so the roadmap is visible. */
export const COMING_SOON: { group: string; items: string[] }[] = [
  { group: 'Logic', items: ['Router', 'Debate rounds', 'Vote / rank'] },
  { group: 'Data', items: ['File / PDF', 'Web search', 'Memory'] },
  { group: 'Action', items: ['Home Assistant', 'Webhook', 'Discord'] },
];
