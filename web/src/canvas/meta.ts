import type { NodeType } from '@hivemind/shared';

export type NodeGroup = 'Core' | 'Logic' | 'Data';

export interface NodeMeta {
  title: string;
  color: string;
  group: NodeGroup;
  description: string;
  /** Needs one model (config.model). */
  usesModel: boolean;
  /** Needs a list of models (config.models) with at least this many. */
  multiModel?: number;
  hasInput: boolean;
  hasOutput: boolean;
}

export const NODE_META: Record<NodeType, NodeMeta> = {
  input: {
    title: 'Question',
    color: '#818cf8',
    group: 'Core',
    description: 'Where the question comes in. Every canvas starts here.',
    usesModel: false,
    hasInput: false,
    hasOutput: true,
  },
  llm: {
    title: 'AI model',
    color: '#22d3ee',
    group: 'Core',
    description: 'Answers using one model. Gets the question, or the answers of the blocks wired into it.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  review: {
    title: 'Review',
    color: '#fbbf24',
    group: 'Core',
    description: 'Critiques and ranks the answers wired into it. Model names are hidden (Answer A, B, C).',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  judge: {
    title: 'Judge',
    color: '#f472b6',
    group: 'Core',
    description: 'Merges all incoming answers and reviews into one final answer and notes where models disagreed.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  output: {
    title: 'Final answer',
    color: '#34d399',
    group: 'Core',
    description: 'The result of the canvas: what the chat, phone app and Home Assistant get back.',
    usesModel: false,
    hasInput: true,
    hasOutput: false,
  },
  router: {
    title: 'Router',
    color: '#fb923c',
    group: 'Logic',
    description: 'A model picks which of the blocks wired after it gets the question; the other branches are skipped. Name those blocks clearly (e.g. "Coding", "Cooking").',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  debate: {
    title: 'Debate',
    color: '#f87171',
    group: 'Logic',
    description: 'Several models answer, read each other’s answers and improve their own, for a number of rounds.',
    usesModel: false,
    multiModel: 2,
    hasInput: true,
    hasOutput: true,
  },
  vote: {
    title: 'Vote',
    color: '#c084fc',
    group: 'Logic',
    description: 'One or more models vote for the best of the answers wired into it; the winner is passed on.',
    usesModel: false,
    multiModel: 1,
    hasInput: true,
    hasOutput: true,
  },
  template: {
    title: 'Text template',
    color: '#94a3b8',
    group: 'Data',
    description: 'Fixed text with {{question}} and {{inputs}} filled in. Good for instructions or reshaping a question.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  file: {
    title: 'File',
    color: '#2dd4bf',
    group: 'Data',
    description: 'Text from a file (txt, md, csv, json or PDF) that the models can use. Wire it into a model block.',
    usesModel: false,
    hasInput: false,
    hasOutput: true,
  },
  search: {
    title: 'Web search',
    color: '#60a5fa',
    group: 'Data',
    description: 'Searches the web (Wikipedia for free, or Brave / Tavily / SearXNG) for the question, or for what the block before it wrote.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  memory: {
    title: 'Memory',
    color: '#a3e635',
    group: 'Data',
    description: 'Recall: brings back what was saved earlier under a name. Save: remembers what flows through it for next time.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
};

export const PALETTE: { group: NodeGroup; types: NodeType[] }[] = [
  { group: 'Core', types: ['input', 'llm', 'review', 'judge', 'output'] },
  { group: 'Logic', types: ['router', 'debate', 'vote'] },
  { group: 'Data', types: ['template', 'file', 'search', 'memory'] },
];

/** Planned blocks, shown in the palette so the roadmap is visible. */
export const COMING_SOON: { group: string; items: string[] }[] = [{ group: 'Action', items: ['Home Assistant', 'Webhook', 'Discord'] }];

/** One-line summary of a block's settings, shown under its name on the canvas. */
export function summary(kind: NodeType, c: import('@hivemind/shared').NodeConfig): { text: string; missing?: boolean } | undefined {
  switch (kind) {
    case 'llm':
    case 'review':
    case 'judge':
    case 'router':
      return c.model ? { text: c.model.model } : { text: 'Pick a model →', missing: true };
    case 'debate': {
      const n = c.models?.length ?? 0;
      return n >= 2 ? { text: `${n} models · ${c.rounds ?? 2} rounds` } : { text: 'Pick 2+ models →', missing: true };
    }
    case 'vote': {
      const n = c.models?.length ?? 0;
      return n >= 1 ? { text: `${n} voter${n > 1 ? 's' : ''}` } : { text: 'Pick voters →', missing: true };
    }
    case 'file':
      return c.text ? { text: `${c.fileName ?? 'file'} · ${Math.round(c.text.length / 1000)}k chars` } : { text: 'Load a file →', missing: true };
    case 'search':
      return { text: `${c.source ?? 'default source'} · ${c.count ?? 5} results` };
    case 'memory':
      return { text: `${c.mode === 'save' ? 'Save to' : 'Recall'} "${c.key || 'default'}"` };
    case 'template':
      return { text: (c.prompt ?? '{{question}} {{inputs}}').replace(/\s+/g, ' ').slice(0, 40) };
  }
}
