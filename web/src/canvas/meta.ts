import type { NodeType } from '@hivemind/shared';

export type NodeGroup = 'Core' | 'Logic' | 'Data' | 'Create' | 'Action' | 'Project' | 'Train' | 'Voice';

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
  decide: {
    title: 'Decide',
    color: '#818cf8',
    group: 'Logic',
    description:
      'A decision model (Jev, Nimble, OpenAI Decisions) answers yes/no, choice and score questions about the text wired in, in about 0.1 s, with probabilities. Name the blocks after it "yes", "no", an option or "fallback": only the winning branch runs.',
    usesModel: true,
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
    description: 'Recall: brings back what was saved earlier under a name. Search: finds the best matching entries (e.g. one rule out of a whole rulebook). Save: remembers what flows through it for next time.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  readMemory: {
    title: 'Read memory',
    color: '#a3e635',
    group: 'Data',
    description: 'Reads memory files (Markdown) and passes their text on. Give it the paths, or wire a small "picker" model before it; turn on the index to also see what memory exists.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  writeMemory: {
    title: 'Write memory',
    color: '#a3e635',
    group: 'Create',
    description: 'Writes what is wired into it to a memory file (replace, append, or move). Without a path it reads JSON {"path","text"} from the block before it. Records who changed it, and keeps versions.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  save: {
    title: 'Save file',
    color: '#facc15',
    group: 'Create',
    description: 'Saves what is wired into it as a file in the files folder (outputs/): a website, Markdown, text, JSON, CSV or code. You can download and preview it.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  image: {
    title: 'Image',
    color: '#e879f9',
    group: 'Create',
    description: 'Makes a picture with an image model (your ComfyUI, or an image API). Draws its own prompt, or the text of the block before it — put a model before it that writes the prompt.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  homeassistant: {
    title: 'Home Assistant',
    color: '#41bdf5',
    group: 'Action',
    description: 'Reads the state of your smart-home entities (to give the models live facts), or calls a service like light.turn_on with the text wired into it. Connect Home Assistant in Settings first.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  webhook: {
    title: 'Webhook / HTTP',
    color: '#f97316',
    group: 'Action',
    description: 'Calls any web address (GET, POST, …) with your headers and a body template, and passes the response on — to trigger automations or fetch data from an API.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  discord: {
    title: 'Discord',
    color: '#5865f2',
    group: 'Action',
    description: 'Posts the text wired into it (or your message template) to a Discord channel through a webhook, then passes it on.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  generate: {
    title: 'Generate examples',
    color: '#fde047',
    group: 'Train',
    description: 'A teacher model (a strong cloud model, or a local one) writes training examples — an input and the ideal answer — for what you describe, and stores them in a dataset.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  dataset: {
    title: 'Add to dataset',
    color: '#bef264',
    group: 'Train',
    description: 'Keeps the answer wired into it as a training example (with the question as input) in a dataset. Put a Decide or Judge before it to keep only the good ones, or send them to the review queue.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  train: {
    title: 'Train model',
    color: '#f0abfc',
    group: 'Train',
    description: 'Starts training a new model on a dataset (it waits for the GPU and runs in the background for minutes to hours). The new model lands in Ollama under its own name; follow it in Lab → New model.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  evaluate: {
    title: 'Evaluate',
    color: '#67e8f9',
    group: 'Train',
    description: 'Gives test examples from a dataset to several models; a judge model grades their answers against the reference answers. The scores come out as a table.',
    usesModel: true,
    multiModel: 1,
    hasInput: true,
    hasOutput: true,
  },
  deploy: {
    title: 'Deploy model',
    color: '#86efac',
    group: 'Train',
    description: 'Puts a model (e.g. the one you just trained) into the AI model blocks of the canvases you name, such as dnd-*.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  readProject: {
    title: 'Read project',
    color: '#93c5fd',
    group: 'Project',
    description: "Reads a project (a folder of files, e.g. a website): its file list, PROJECT.md (the project's notes) and the files you pick, up to a size budget. Put it before a model that changes the project.",
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  writeFiles: {
    title: 'Write files',
    color: '#60a5fa',
    group: 'Project',
    description: 'Writes the files in the answer wired into it into the project (folders are made): code blocks like ```html path=pages/about.html, or JSON {"files": [...]}. Shows what changed.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  updateNotes: {
    title: 'Update notes',
    color: '#a5b4fc',
    group: 'Project',
    description: 'A model keeps PROJECT.md up to date (what the site is, its style, pages and decisions), so the next run knows what was chosen before.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  git: {
    title: 'Git',
    color: '#f0883e',
    group: 'Project',
    description: 'Commits and pushes the project to its GitHub repo (or pulls, or opens a pull request). Passes when the project is not connected to GitHub. Never force-pushes.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  build: {
    title: 'Build',
    color: '#fde047',
    group: 'Project',
    description: 'Runs npm install and an npm script (build) for projects with a package.json (React, Vite…), inside HiveMind. The output folder (dist/) is what the preview shows. Plain HTML sites need no build.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  pause: {
    title: 'Pause',
    color: '#fb923c',
    group: 'Logic',
    description: 'Stops the run and waits for you: shows what came in (and the files changed so far, with a preview). Continue (after editing if you like), Reject (goes to a block named "rejected") or Stop.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  foreach: {
    title: 'For each',
    color: '#c084fc',
    group: 'Logic',
    description: 'Runs the blocks between it and its Collect block once per item of the list wired in (a JSON list, or one item per line). Each run gets one item.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  deepSearch: {
    title: 'Deep search',
    color: '#38bdf8',
    group: 'Data',
    description:
      'Searches the web in rounds: reads a few sites, then decides (with a decision model, or its own model) to stop, read more sites, or search with other words. Gives the sites it read, for a For each to review one by one.',
    usesModel: true,
    hasInput: true,
    hasOutput: true,
  },
  panel: {
    title: 'Review panel',
    color: '#fda4af',
    group: 'Logic',
    description: 'Several different AIs, picked at random from a pool, each review what is wired in. A reviewer that fails is replaced by another from the pool.',
    usesModel: false,
    multiModel: 2,
    hasInput: true,
    hasOutput: true,
  },
  collect: {
    title: 'Collect',
    color: '#c084fc',
    group: 'Logic',
    description: 'Ends a For each: gathers what every item gave, in order, and passes it on.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  audioPrep: {
    title: 'Audio prep',
    color: '#f472b6',
    group: 'Voice',
    description: 'Cuts the recordings attached to the question (mp3, mp4, wav, m4a) into clean clips of 3–15 seconds and throws away the bad ones (too quiet, clipped, mostly silence). Type the character with the files (e.g. "Jarvis").',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  voiceDataset: {
    title: 'Voice dataset',
    color: '#f472b6',
    group: 'Voice',
    description: 'After Audio prep: writes down what is said in every clip (speech to text) and keeps the clips in a voice dataset. Running it again adds only what is new.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  voiceClone: {
    title: 'Voice clone',
    color: '#f472b6',
    group: 'Voice',
    description: 'After Voice dataset: builds a voice (clone:<character>) from the best clips, inside HiveMind (Qwen3-TTS). The app and the robot can then speak with it.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
  speak: {
    title: 'Speak',
    color: '#f472b6',
    group: 'Voice',
    description: 'Says text (one sentence per line, or what is wired in) in a voice — a built-in one or a cloned one — as audio files you can play in the run.',
    usesModel: false,
    hasInput: true,
    hasOutput: true,
  },
};

export const PALETTE: { group: NodeGroup; types: NodeType[] }[] = [
  { group: 'Core', types: ['input', 'llm', 'review', 'judge', 'output'] },
  { group: 'Logic', types: ['router', 'decide', 'debate', 'vote', 'panel', 'pause', 'foreach', 'collect'] },
  { group: 'Data', types: ['template', 'file', 'search', 'deepSearch', 'memory'] },
  { group: 'Create', types: ['image', 'save'] },
  { group: 'Action', types: ['homeassistant', 'webhook', 'discord'] },
  { group: 'Project', types: ['readProject', 'writeFiles', 'updateNotes', 'build', 'git'] },
  { group: 'Train', types: ['generate', 'dataset', 'train', 'evaluate', 'deploy'] },
  { group: 'Voice', types: ['audioPrep', 'voiceDataset', 'voiceClone', 'speak'] },
];

/** Planned blocks, shown in the palette so the roadmap is visible. */
export const COMING_SOON: { group: string; items: string[] }[] = [];

/** One-line summary of a block's settings, shown under its name on the canvas. */
export function summary(kind: NodeType, c: import('@hivemind/shared').NodeConfig): { text: string; missing?: boolean } | undefined {
  switch (kind) {
    case 'llm':
    case 'review':
    case 'judge':
    case 'router':
      if (kind === 'llm' && c.auto) {
        const sizes = (['local', 'small', 'medium', 'large'] as const).filter((t) => c.auto![t]);
        return sizes.length ? { text: `Auto ⚡ ${sizes.join(' / ')}` } : { text: 'Pick models per size →', missing: true };
      }
      if (kind === 'router' && c.decideWith === 'jev') return c.decider ? { text: `Jev ⚡ ${c.decider.model}` } : { text: 'Pick a decision model →', missing: true };
      return c.model ? { text: c.model.model } : { text: 'Pick a model →', missing: true };
    case 'image':
      return c.model
        ? { text: `${c.model.model.split('/').pop()!.replace(/\.safetensors$/, '')} · ${c.width ?? 1024}×${c.height ?? 1024}${c.lora ? ' · LoRA' : ''}${(c.batch ?? 1) > 1 ? ` · ×${c.batch}` : ''}` }
        : { text: 'Pick an image model →', missing: true };
    case 'save':
      return { text: `${c.fileName || 'answer-{{date}}'} · ${c.format ?? 'auto'}` };
    case 'debate': {
      const n = c.models?.length ?? 0;
      return n >= 2 ? { text: `${n} models · ${c.rounds ?? 2} rounds` } : { text: 'Pick 2+ models →', missing: true };
    }
    case 'vote': {
      const n = c.models?.length ?? 0;
      if (c.jevScore) return { text: n ? `Jev ⚡ + ${n} voter${n > 1 ? 's' : ''}` : 'Jev ⚡ scores, best wins' };
      return n >= 1 ? { text: `${n} voter${n > 1 ? 's' : ''}` } : { text: 'Pick voters →', missing: true };
    }
    case 'file':
      return c.text ? { text: `${c.fileName ?? 'file'} · ${Math.round(c.text.length / 1000)}k chars` } : { text: 'Load a file →', missing: true };
    case 'search':
      return { text: `${c.source ?? 'default source'} · ${c.count ?? 5} results` };
    case 'memory':
      return { text: `${c.mode === 'save' ? 'Save to' : c.mode === 'search' ? 'Search' : 'Recall'} "${c.key || 'default'}"` };
    case 'homeassistant':
      return (c.haOp ?? 'state') === 'state'
        ? c.entities?.trim()
          ? { text: `Read ${c.entities.trim().replace(/\s+/g, ' ')}` }
          : { text: 'Pick entities to read →', missing: true }
        : c.service?.trim()
          ? { text: `Call ${c.service.trim()}` }
          : { text: 'Pick a service →', missing: true };
    case 'webhook':
      return c.url?.trim() ? { text: `${c.method ?? 'POST'} ${c.url.replace(/^https?:\/\//, '')}` } : { text: 'Fill in the URL →', missing: true };
    case 'discord':
      return c.url?.trim() ? { text: (c.body ?? '{{input}}').replace(/\s+/g, ' ').slice(0, 40) } : { text: 'Paste the webhook URL →', missing: true };
    case 'decide': {
      if (!c.model) return { text: 'Pick a decision model →', missing: true };
      if (c.questionsFromInput) return { text: `questions from the block before · ${c.model.model}` };
      const qs = c.questions ?? [];
      return qs.length ? { text: `${qs.map((q) => q.name).join(', ')} · ${c.model.model}` } : { text: 'Add a question →', missing: true };
    }
    case 'template':
      return { text: (c.prompt ?? '{{question}} {{inputs}}').replace(/\s+/g, ' ').slice(0, 40) };
    case 'generate':
      return !c.model ? { text: 'Pick a teacher model →', missing: true } : { text: `${c.count ?? 10} examples${c.dataset ? ` → ${c.dataset}` : ''} · ${c.model.model}` };
    case 'dataset':
      return c.dataset?.trim() ? { text: `→ ${c.dataset}${c.review ? ' (review)' : ''}` } : { text: 'Name the dataset →', missing: true };
    case 'train':
      return c.dataset?.trim() && c.trainBase && c.trainName ? { text: `${c.dataset} → ${c.trainName}` } : { text: 'Pick dataset, base and name →', missing: true };
    case 'evaluate': {
      const n = c.models?.length ?? 0;
      return n && c.model && c.dataset ? { text: `${n} model${n > 1 ? 's' : ''} · ${c.count ?? 5} tests · ${c.dataset}` } : { text: 'Pick models, judge and dataset →', missing: true };
    }
    case 'deploy':
      return c.model && c.canvasPattern ? { text: `${c.model.model} → ${c.canvasPattern}` } : { text: 'Pick the model and canvases →', missing: true };
    case 'readProject':
      return { text: `${projectText(c)}${c.onlyNamed ? ' · named files' : c.globs ? ` · ${c.globs.replace(/\s+/g, ' ').slice(0, 30)}` : ''}` };
    case 'writeFiles':
      return { text: `${projectText(c)}${c.writeMode === 'new' ? ' · new files only' : ''}` };
    case 'updateNotes':
      return c.model ? { text: `${projectText(c)} · ${c.model.model}` } : { text: 'Pick a model →', missing: true };
    case 'git':
      return { text: `${projectText(c)} · ${GIT_ACTIONS[c.gitAction ?? 'commitPush']}` };
    case 'build':
      return { text: `${projectText(c)} · npm run ${c.script || 'build'}` };
    case 'pause':
      return { text: c.timeoutMinutes ? `${c.title || 'Check'} · ${c.timeoutMinutes} min` : c.title || 'Waits for you' };
    case 'foreach':
      return { text: `each item · max ${c.maxItems ?? 50}` };
    case 'deepSearch':
      return c.model ? { text: `${c.pageBatch ?? 5} sites a round · max ${c.maxPages ?? 15}${c.decider ? ' · Jev decides' : ''}` } : { text: 'Pick a model →', missing: true };
    case 'panel': {
      const n = c.models?.length ?? 0;
      return n >= 2 ? { text: `${c.count ?? 2} of ${n} at random` } : { text: 'Pick 2+ models →', missing: true };
    }
  }
}

export const GIT_ACTIONS: Record<NonNullable<import('@hivemind/shared').NodeConfig['gitAction']>, string> = {
  commitPush: 'commit + push',
  commit: 'commit',
  push: 'push',
  pull: 'pull',
  pr: 'pull request',
};

/** The project a block works on, as shown on the canvas: its own setting, or the run's vars.project. */
const projectText = (c: import('@hivemind/shared').NodeConfig) => (c.project?.trim() ? `📁 ${c.project.startsWith('{{') ? c.project : (projectNames.get(c.project) ?? c.project)}` : '📁 {{vars.project}}');

/** Project names by id, filled in by the project picker so blocks show names, not ids. */
export const projectNames = new Map<string, string>();
