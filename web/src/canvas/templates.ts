import type { CanvasEdge, CanvasGraph, CanvasNode, DecideQuestion, ModelRef, NodeConfig, NodeType } from '@hivemind/shared';

/** Models a template is filled with: fast members, a strong judge, and an image model when there is one. */
export interface TemplateModels {
  text: (ModelRef | undefined)[];
  judge?: ModelRef;
  image?: ModelRef;
  /** A decision model (Jev, Nimble…) for Decide blocks and the Auto model. */
  decision?: ModelRef;
  /** A big, slow model for work that may take hours (a colibri giant model), when there is one. */
  slow?: ModelRef;
  /** Colibri's models inside HiveMind, when some are downloaded: one to chat, one for code, and its decisions side. */
  colibri?: { chat?: ModelRef; coder?: ModelRef; decide?: ModelRef };
  /** A very fast model for small talk (quick robot answers). */
  fast?: ModelRef;
  /** The strongest model for hard planning (may be slow). */
  deep?: ModelRef;
  /** A model that sees pictures. */
  vision?: ModelRef;
}

export const TEMPLATE_GROUPS = ['Everyday', 'Voice', 'Coding', 'Creative', 'Home / research', 'Research', 'Website', 'Decisions', 'Train', 'Tabletop'] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

export interface Template {
  id: string;
  group: TemplateGroup;
  name: string;
  description: string;
  /** Needs an image model (ComfyUI or an image API) to run. */
  needsImage?: boolean;
  /** Needs a decision model (Settings → Providers → Decisions) to run. */
  needsDecision?: boolean;
  build(m: TemplateModels): CanvasGraph;
}

let counter = 0;
export const newNodeId = (type: NodeType) => `${type}-${Date.now().toString(36)}${(counter++).toString(36)}`;

const node = (type: NodeType, x: number, y: number, label?: string, config: NodeConfig = {}): CanvasNode => ({
  id: newNodeId(type),
  type,
  label,
  position: { x, y },
  config,
});
const wire = (a: CanvasNode, b: CanvasNode): CanvasEdge => ({ id: `${a.id}->${b.id}`, source: a.id, target: b.id });
/** A straight line of blocks, each wired to the next. */
function chain(...nodes: CanvasNode[]): CanvasGraph {
  return { nodes, edges: nodes.slice(1).map((n, i) => wire(nodes[i], n)) };
}
const llm = (x: number, y: number, label: string, model: ModelRef | undefined, prompt?: string, system?: string) =>
  node('llm', x, y, label, { ...(model && { model }), ...(prompt && { prompt }), ...(system && { system }) });

function council(m: TemplateModels, withReview: boolean): CanvasGraph {
  const q = node('input', 0, 240, 'Question');
  const members = [0, 1, 2].map((i) => llm(320, i * 200 + 40, `Member ${i + 1}`, m.text[i] ?? m.text[0]));
  const judge = node('judge', withReview ? 960 : 640, 240, 'Judge', m.judge ? { model: m.judge } : {});
  const out = node('output', withReview ? 1280 : 960, 240, 'Final answer');
  const nodes = [q, ...members, judge, out];
  const edges = [...members.map((x) => wire(q, x)), ...members.map((x) => wire(x, judge)), wire(judge, out)];
  if (withReview) {
    const review = node('review', 640, 460, 'Anonymous review', m.judge ? { model: m.judge } : {});
    nodes.push(review);
    edges.push(...members.map((x) => wire(x, review)), wire(review, judge));
  }
  return { nodes, edges };
}

const SITE_PROMPT =
  'Build a complete, modern, responsive single-file website for: {{question}}\n\n{{inputs}}\n\n' +
  'Use one HTML file with inline <style> and <script>, no external files except Google Fonts. Make it look polished: good spacing, colors, and real content (no lorem ipsum). ' +
  'Reply with only one ```html code block containing the whole page.';

// ---- Decisions (Jev and other decision models) ----

/** The six questions from the Jev guide's examples/questions.json. */
const SPAM_QUESTIONS: DecideQuestion[] = [
  { name: 'spam', type: 'noul', instructions: 'Is this comment spam?' },
  { name: 'contact', type: 'noul', instructions: 'Does it tell people to contact someone off the site?' },
  { name: 'money', type: 'noul', instructions: 'Does it talk about money, investing or crypto?' },
  { name: 'link', type: 'noul', instructions: 'Does it push the reader to a link or profile?' },
  {
    name: 'wants',
    type: 'choice',
    instructions: 'What does this commenter want?',
    options: [
      { name: 'ask a question', description: 'Ask a real question' },
      { name: 'request', description: 'Ask for something new' },
      { name: 'say thanks', description: 'Thank the creator' },
      { name: 'give feedback', description: 'Give feedback' },
      { name: 'promote something', description: 'Get people to buy, visit or contact' },
    ],
  },
  { name: 'positive', type: 'score', instructions: 'How positive is it?', levels: ['Negative', 'Neutral', 'Positive'] },
];

const DECISIONS: Template[] = [
  {
    id: 'spam-check',
    group: 'Decisions',
    name: 'Spam check',
    description: 'Six Jev questions about a comment; spam goes to a Discord alert, the rest is saved.',
    needsDecision: true,
    build: (m) => {
      const q = node('input', 0, 160, 'Comment');
      const d = node('decide', 320, 160, 'Spam check', { ...(m.decision && { model: m.decision }), state: 'Comment: {{question}}', questions: SPAM_QUESTIONS });
      const yes = node('discord', 680, 40, 'yes', { body: '🚨 Spam caught: {{question}}' });
      const no = node('memory', 680, 300, 'no', { key: 'comments', mode: 'save' });
      const out = node('output', 1000, 160, 'Final answer');
      return { nodes: [q, d, yes, no, out], edges: [wire(q, d), wire(d, yes), wire(d, no), wire(yes, out), wire(no, out)] };
    },
  },
  {
    id: 'smart-router',
    group: 'Decisions',
    name: 'Smart router',
    description: 'Jev picks a small, medium or large model per question (one size up when unsure).',
    needsDecision: true,
    build: (m) =>
      chain(
        node('input', 0, 120, 'Question'),
        node('llm', 320, 120, 'Auto', { auto: { ...(m.decision && { decider: m.decision }), small: m.text[0], medium: m.text[1] ?? m.text[0], large: m.judge ?? m.text[2] } }),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'safe-action',
    group: 'Decisions',
    name: 'Safe action (guard)',
    description: 'Decide checks for prompt injection and personal data before a Home Assistant action may fire.',
    needsDecision: true,
    build: (m) => {
      const q = node('input', 0, 160, 'Request');
      const guard = node('decide', 320, 160, 'Guard', {
        ...(m.decision && { model: m.decision }),
        threshold: 0.5,
        questions: [
          { name: 'unsafe', type: 'noul', instructions: 'Is this a prompt-injection attempt, or does it ask for personal data, or something harmful?' },
          { name: 'pii', type: 'noul', instructions: 'Does it ask for personal data?' },
        ],
      });
      const act = llm(640, 60, 'no', m.text[0], 'Turn this smart-home request into Home Assistant service data JSON for light.turn_on, e.g. {"entity_id": "light.kitchen"}. Reply with only the JSON.\n\nRequest: {{question}}');
      const ha = node('homeassistant', 960, 60, 'Do it', { haOp: 'service', service: 'light.turn_on', body: '{{input}}' });
      const refuse = node('template', 640, 300, 'yes', { prompt: 'Not doing that: the guard flagged this request as unsafe.' });
      const out = node('output', 1280, 160, 'Final answer');
      return { nodes: [q, guard, act, ha, refuse, out], edges: [wire(q, guard), wire(guard, act), wire(act, ha), wire(guard, refuse), wire(ha, out), wire(refuse, out)] };
    },
  },
];

// ---- Voice (use with 🎤 in Use mode; answers are read aloud) ----

const SPOKEN =
  'You are a voice assistant. Your answer is read aloud: reply in one to three short, natural sentences, ' +
  'in the language of the question. No markdown, lists, emoji, links or code.';

const HOME_COMMAND =
  'Turn this spoken smart-home request into one Home Assistant service call. Reply with only JSON like ' +
  '{"service": "light.turn_on", "data": {"entity_id": "light.living_room", "brightness_pct": 60}}.\n\n' +
  'My devices (edit this list to match your Home Assistant):\n' +
  'light.living_room, light.kitchen, light.bedroom, switch.coffee_machine, climate.living_room, media_player.living_room\n\n' +
  'Request: {{question}}';

const VOICE: Template[] = [
  {
    id: 'voice-assistant',
    group: 'Voice',
    name: 'Voice assistant',
    description: 'Ask out loud, get a short spoken answer. Remembers the last few things you talked about.',
    build: (m) => {
      const q = node('input', 0, 160, 'Spoken question');
      const recall = node('memory', 320, 40, 'Recent talk', { key: 'voice', mode: 'recall', limit: 6 });
      const a = llm(640, 160, 'Assistant', m.text[0], 'Earlier conversation:\n{{inputs}}\n\nNow answer: {{question}}', SPOKEN);
      const save = node('memory', 960, 160, 'Remember', { key: 'voice', mode: 'save' });
      const out = node('output', 1280, 160, 'Spoken answer');
      return { nodes: [q, recall, a, save, out], edges: [wire(q, recall), wire(q, a), wire(recall, a), wire(a, save), wire(save, out)] };
    },
  },
  {
    id: 'voice-home',
    group: 'Voice',
    name: 'Voice smart home',
    description: 'Say "turn off the kitchen light" and Home Assistant does it; other questions get a spoken answer.',
    build: (m) => {
      const q = node('input', 0, 200, 'Spoken request');
      const route = node('router', 320, 200, 'Command or question?', m.text[0] ? { model: m.text[0] } : {});
      const cmd = node('llm', 640, 60, 'Smart home command', { ...(m.text[0] && { model: m.text[0] }), prompt: HOME_COMMAND, json: true, jsonSchema: '{"service": "domain.service", "data": {"entity_id": "..."}}' });
      const ha = node('homeassistant', 960, 60, 'Do it', { haOp: 'service' });
      const done = llm(1280, 60, 'Confirm', m.text[0], 'Home Assistant did this:\n{{inputs}}\n\nThe user asked: {{question}}\n\nConfirm in one short sentence what was done.', SPOKEN);
      const answer = llm(640, 340, 'Question or chat', m.text[0], undefined, SPOKEN);
      const out = node('output', 1600, 200, 'Spoken answer');
      return {
        nodes: [q, route, cmd, ha, done, answer, out],
        edges: [wire(q, route), wire(route, cmd), wire(route, answer), wire(cmd, ha), wire(ha, done), wire(done, out), wire(answer, out)],
      };
    },
  },
];

// ---- Train (make your own models: data → training → test → put to work) ----

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

const TRAIN: Template[] = [
  {
    id: 'train-teacher-data',
    group: 'Train',
    name: 'Make training data with a teacher',
    description: 'Type a topic; a strong model writes examples (question + ideal answer) into a dataset. Review them in Lab → Datasets.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Topic'),
        node('generate', 320, 120, 'Teacher', { ...((m.judge ?? m.text[0]) && { model: m.judge ?? m.text[0] }), dataset: 'Teacher examples', count: 20, prompt: 'Questions people ask about: {{question}}. Answers: short, friendly, correct.', review: true }),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-collect',
    group: 'Train',
    name: 'Collect good answers',
    description: 'A model answers, a judge model checks it; good answers are kept in a dataset. Use "Run repeatedly" with a list of questions to collect many.',
    build: (m) => {
      const q = node('input', 0, 160, 'Question');
      const a = llm(320, 160, 'Answer', m.judge ?? m.text[0]);
      const check = node('decide', 640, 160, 'Good enough?', {
        ...(m.decision && { model: m.decision }),
        state: 'Question: {{question}}\n\nAnswer: {{inputs}}',
        questions: [{ name: 'good', type: 'noul', instructions: 'Is this a correct, helpful and well written answer to the question?' }],
      });
      const keep = node('dataset', 960, 60, 'yes', { dataset: 'Good answers' });
      const out = node('output', 1280, 160, 'Final answer');
      return { nodes: [q, a, check, keep, out], edges: [wire(q, a), wire(a, check), wire(check, keep), wire(a, out)] };
    },
    needsDecision: true,
  },
  {
    id: 'train-thumbs',
    group: 'Train',
    name: 'Train on my 👍 answers',
    description: 'Trains a small model on the answers you gave a 👍 ("My good answers"). Test it afterwards with "Compare models on a dataset".',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Start'),
        node('train', 320, 120, 'Train', { dataset: 'My good answers', trainBase: 'unsloth/Qwen3.5-2B', trainName: `my-style:${today()}`, epochs: 2 }),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-compare',
    group: 'Train',
    name: 'Compare models on a dataset',
    description: 'Several models answer test examples from a dataset; a judge grades them against the reference answers. Find out if your trained model is better.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Start'),
        node('evaluate', 320, 120, 'Evaluate', {
          ...((m.judge ?? m.text[0]) && { model: m.judge ?? m.text[0] }),
          models: [m.text[0], m.text[1] ?? m.text[0]].filter((x): x is ModelRef => !!x),
          dataset: 'My good answers',
          count: 5,
        }),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-dm',
    group: 'Train',
    name: 'Train the DungeonMind DM',
    description: 'Trains a DM model on the turns the Lab simulator collected (dataset "DungeonMind DM") and tests your current DM model on the same turns. When it is ready, use "Put a trained model to work".',
    build: (m) => {
      const q = node('input', 0, 160, 'Start');
      const t = node('train', 320, 60, 'Train DM', { dataset: 'DungeonMind DM', trainBase: 'unsloth/Qwen3-8B', trainName: `dungeonmind-dm:${today()}`, epochs: 2 });
      const e = node('evaluate', 320, 280, 'Test DM models', {
        ...((m.judge ?? m.text[0]) && { model: m.judge ?? m.text[0] }),
        models: [m.text[0]].filter((x): x is ModelRef => !!x),
        dataset: 'DungeonMind DM',
        count: 5,
      });
      const out = node('output', 680, 160, 'Final answer');
      return { nodes: [q, t, e, out], edges: [wire(q, t), wire(q, e), wire(t, out), wire(e, out)] };
    },
  },
  {
    id: 'train-skill',
    group: 'Train',
    name: 'Teach a small model a skill (all in one)',
    description: 'Type what the model should be good at. A teacher model writes 100 examples, then a small model trains on them and the run waits until it is in Ollama.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Skill'),
        node('generate', 320, 120, 'Teacher writes examples', {
          ...((m.judge ?? m.text[0]) && { model: m.judge ?? m.text[0] }),
          dataset: 'My skill',
          count: 100,
          prompt: 'Questions and requests about: {{question}}. Answers: correct, clear and in the style an expert would use.',
        }),
        node('train', 640, 120, 'Train', { dataset: 'My skill', trainBase: 'unsloth/Qwen3.5-2B', trainName: `my-skill:${today()}`, epochs: 2, trainWait: true }),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-robot-voice',
    group: 'Train',
    name: 'Train a HiveBot character (colibri teaches)',
    description:
      'Describe a robot character (name, personality, what it knows). Colibri (or your strongest model) writes 200 short spoken answers in that character, then a small fast model trains on them and lands in Ollama, ready for HiveBot. Training takes the GPU: run it when nobody needs it.',
    build: (m) => {
      const teacher = m.colibri?.chat ?? m.judge ?? m.text[0];
      return chain(
        node('input', 0, 120, 'The character'),
        node('generate', 320, 120, 'Colibri writes what the character says', {
          ...(teacher && { model: teacher }),
          dataset: 'HiveBot character',
          count: 200,
          prompt:
            'Things people say to a home robot (questions, small talk, requests, jokes, "what can you do?") and the robot\'s spoken answer, in this character: {{question}}. ' +
            'Answers are spoken out loud: 1-3 short sentences, no lists, no markdown, no emojis; stay in character; never invent facts like the time or the weather — say it can\'t check that yet.',
        }),
        node('train', 640, 120, 'Train the small model', { dataset: 'HiveBot character', trainBase: 'unsloth/Qwen3.5-2B', trainName: `hivebot-character:${today()}`, epochs: 2, trainWait: true }),
        node('output', 960, 120, 'Final answer'),
      );
    },
  },
  {
    id: 'train-decision',
    group: 'Train',
    name: 'Make your own decision model',
    description:
      'A teacher writes texts with the right answer to one question (here: how does a customer feel?), then a tiny model learns to answer it in a split second. Use it in Decide blocks under "Ollama decision models". Change the question and options in the Generate block.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Topic'),
        node('generate', 320, 120, 'Teacher writes examples', {
          ...((m.judge ?? m.text[0]) && { model: m.judge ?? m.text[0] }),
          dataset: 'Customer mood',
          datasetKind: 'decision',
          count: 120,
          prompt: 'Short customer messages about: {{question}}. Mix happy, unhappy and neutral ones, some sarcastic, some with typos.',
          questions: [
            {
              name: 'answer',
              type: 'choice',
              instructions: 'How does the customer feel?',
              options: [
                { name: 'happy', description: 'Pleased, thankful, positive' },
                { name: 'unhappy', description: 'Angry, disappointed, complaining' },
                { name: 'neutral', description: 'Just a question or a fact' },
              ],
            },
          ],
        }),
        node('train', 640, 120, 'Train decision model', { dataset: 'Customer mood', trainBase: 'unsloth/Qwen3.5-0.8B', trainName: `customer-mood:${today()}`, epochs: 3, trainWait: true }),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-lora-collect',
    group: 'Train',
    name: 'Make pictures for an image LoRA',
    description:
      'Your image model makes 4 pictures of what you type; they go into the picture dataset "My LoRA", with the prompt as caption. Use "Run repeatedly" with different prompts for 20–30 pictures, or add your own photos in Lab → Datasets.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'What to picture'),
        node('image', 320, 120, 'Pictures', { ...(m.image && { model: m.image }), width: 1024, height: 1024, batch: 4 }),
        node('dataset', 640, 120, 'Add to LoRA dataset', { dataset: 'My LoRA', datasetKind: 'image' }),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-lora',
    group: 'Train',
    name: 'Train an image LoRA',
    description:
      'Trains a LoRA on the picture dataset "My LoRA" in your ComfyUI (after its queue is empty). It ends up in models/loras/hivemind, ready for Image blocks. Set the checkpoint and trigger word in the Train block.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Start'),
        node('train', 320, 120, 'Train LoRA', { dataset: 'My LoRA', ...(m.image && { trainBase: m.image.model }), trainName: `my-lora:${today()}`, trainTrigger: 'mylora style' }),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-cloud',
    group: 'Train',
    name: 'Train a bigger model on Hugging Face',
    description:
      'Trains Qwen3.5 9B (too big for a 16 GB GPU) on a rented Hugging Face L4, only when it costs at most $5. Needs your Hugging Face token in Settings. The model comes back into your Ollama.',
    build: () =>
      chain(
        node('input', 0, 120, 'Start'),
        node('train', 320, 120, 'Train on Hugging Face', {
          dataset: 'My skill',
          trainBase: 'unsloth/Qwen3.5-9B',
          trainName: `my-skill-9b:${today()}`,
          epochs: 2,
          trainFlavor: 'l4x1',
          trainMaxUsd: 5,
        }),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'train-deploy',
    group: 'Train',
    name: 'Put a trained model to work',
    description: 'Puts a trained model into the AI model blocks of other workflows (here every workflow whose id starts with dnd-). Pick the model in the Deploy block first.',
    build: (m) => chain(node('input', 0, 120, 'Start'), node('deploy', 320, 120, 'Deploy', { ...(m.text[0] && { model: m.text[0] }), canvasPattern: 'dnd-*' }), node('output', 640, 120, 'Final answer')),
  },
];

// ---- Tabletop (the DungeonMind canvases, so you can see and tweak them) ----

/** What every DungeonMind prompt gets; the numbers are always the server's. */
const TABLE_CONTEXT =
  'Campaign:\n{{vars.campaign}}\n\nParty state:\n{{vars.party}}\n\nRecent turns:\n{{vars.recent}}\n\nDice results from the server:\n{{vars.results}}';
const DM_RULES =
  'You are the Dungeon Master of a dark-fantasy D&D 5e game. The numbers are always the server\'s: use the given dice results exactly and never change HP, spell slots or other numbers yourself.';
const json = (system: string, prompt: string, schema: string, model?: ModelRef, extra: NodeConfig = {}) => ({
  ...(model && { model }),
  system,
  prompt,
  json: true,
  jsonSchema: schema,
  ...extra,
});
const rulesSearch = (x: number, y: number, query = '{{question}}') =>
  node('memory', x, y, 'rules', { key: 'rules:{{vars.ruleset}}', mode: 'search', query, limit: 6 });

const TABLETOP: Template[] = [
  {
    id: 'dnd-setup',
    group: 'Tabletop',
    name: 'Adventure setup',
    description: 'Adventure pitches plus a setup form (selects, sliders, text) as JSON.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Wishes'),
        node(
          'llm',
          320,
          120,
          'pitch',
          json(
            DM_RULES,
            'The players want: {{question}}\n\nWrite 3 short adventure pitches and a setup form to tune the chosen one.',
            '{"pitches":[{"title":"","hook":""}],"fields":[{"id":"","label":"","type":"select|slider|text|multi","options":[""],"min":0,"max":10,"default":""}]}',
            m.judge ?? m.text[0],
          ),
        ),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'dnd-adjudicate',
    group: 'Tabletop',
    name: 'Adjudicate actions',
    description: 'Looks up the rules for the players’ actions and asks for the right rolls as JSON. Never invents results.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Actions'),
        rulesSearch(300, 120),
        node(
          'llm',
          600,
          120,
          'rolls',
          json(
            `${DM_RULES} You decide which rolls the actions need. Never roll or invent results yourself.`,
            `${TABLE_CONTEXT}\n\nRules:\n{{inputs}}\n\nActions: {{question}}`,
            '{"rolls":[{"pc":"","kind":"attack|save|skill|damage|heal","stat":"","dc":0,"targetAc":0,"adv":"none|adv|dis","dice":"1d20"}],"resources":[{"pc":"","name":"","amount":1}]}',
            m.text[0],
          ),
        ),
        node('output', 900, 120, 'Final answer'),
      ),
  },
  {
    id: 'dnd-narrate',
    group: 'Tabletop',
    name: 'Narrate a turn',
    description: 'Story memory + rules → narration (32K context) → state changes as JSON → remembered per table.',
    build: (m) => {
      const q = node('input', 0, 200, 'Turn');
      const story = node('memory', 300, 60, 'story', { key: 'dnd:{{vars.tableId}}', mode: 'search', limit: 5 });
      const rules = rulesSearch(300, 340);
      const narration = llm(620, 200, 'narration', m.judge ?? m.text[0], `${TABLE_CONTEXT}\n\nEarlier in this campaign and the rules:\n{{inputs}}\n\nWhat the players do: {{question}}\n\nNarrate what happens.`, DM_RULES);
      narration.config.numCtx = 32768;
      const state = node(
        'llm',
        940,
        200,
        'state',
        json(
          'You turn a D&D narration into state changes. Only record what the narration and the dice results say.',
          `${TABLE_CONTEXT}\n\nNarration:\n{{inputs}}`,
          '{"deltas":[],"xp":0,"conditions":[],"items":[],"positions":{"zone":["names"]},"zones":[{"name":"","distances":{}}],"choices":{"pc":["","","",""]},"speakers":[{"name":"","kind":"","gender":""}],"image":"","sceneEnd":false}',
          m.text[0],
        ),
      );
      const save = node('memory', 1260, 200, 'remember', { key: 'dnd:{{vars.tableId}}', mode: 'save' });
      const out = node('output', 1560, 200, 'Final answer');
      return {
        nodes: [q, story, rules, narration, state, save, out],
        edges: [wire(q, story), wire(q, rules), wire(story, narration), wire(rules, narration), wire(narration, state), wire(state, save), wire(save, out)],
      };
    },
  },
  {
    id: 'dnd-chronicle',
    group: 'Tabletop',
    name: 'Chronicle',
    description: 'Turns the session into patches for the campaign.md sections.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Session'),
        node(
          'llm',
          320,
          120,
          'patches',
          json('You keep the campaign log. Write short, factual patches.', `Campaign:\n{{vars.campaign}}\n\nRecent turns:\n{{vars.recent}}\n\n{{question}}`, '{"patches":[{"section":"","op":"replace|append","text":""}]}', m.judge ?? m.text[0]),
        ),
        node('output', 640, 120, 'Final answer'),
      ),
  },
  {
    id: 'dnd-ask',
    group: 'Tabletop',
    name: 'Ask the DM',
    description: 'An out-of-turn answer from the rules and the campaign that does not move the story on.',
    build: (m) => {
      const q = node('input', 0, 160, 'Question');
      const rules = rulesSearch(300, 60);
      const campaign = node('memory', 300, 280, 'campaign', { key: 'dnd:{{vars.tableId}}', mode: 'search', limit: 4 });
      const a = llm(620, 160, 'answer', m.judge ?? m.text[0], 'Campaign:\n{{vars.campaign}}\n\nMaterial:\n{{inputs}}\n\nOut-of-turn question: {{question}}\n\nAnswer briefly; do not move the story forward.', DM_RULES);
      const out = node('output', 940, 160, 'Final answer');
      return { nodes: [q, rules, campaign, a, out], edges: [wire(q, rules), wire(q, campaign), wire(rules, a), wire(campaign, a), wire(a, out)] };
    },
  },
  {
    id: 'dnd-sheet',
    group: 'Tabletop',
    name: 'Character sheet',
    description: 'A full, legal character sheet as JSON from the rules (DungeonMind checks it).',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Character idea'),
        rulesSearch(300, 120),
        node(
          'llm',
          600,
          120,
          'sheet',
          json('You build legal D&D 5e characters from the rules given.', 'Rules:\n{{inputs}}\n\nBuild this character: {{question}}', '{"name":"","race":"","class":"","level":1,"abilities":{"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10},"hp":0,"ac":0,"skills":[],"features":[],"spells":[],"items":[]}', m.judge ?? m.text[0]),
        ),
        node('output', 900, 120, 'Final answer'),
      ),
  },
  {
    id: 'dnd-sim',
    group: 'Tabletop',
    name: 'Simulated turn (Lab)',
    description: 'What the Lab runs: fake players with personas act, the DM answers with narration and bookkeeping as JSON.',
    build: (m) => {
      const q = node('input', 0, 220, 'Scene');
      const personas: [string, string][] = [
        ['Brakka', 'You are Brakka, a reckless half-orc fighter. You charge in first and never retreat.'],
        ['Quill', 'You are Quill, a rules-lawyer wizard who tries to cast spells even when the slots are used up.'],
        ['Turks', 'You are Turks, a casual player of a bard: short, sloppy, typo-heavy messages.'],
      ];
      const players = personas.map(([name, persona], i) => llm(320, i * 180 + 40, name, m.text[i] ?? m.text[0], '{{question}}\n\nSay what you do this turn in one or two sentences, in character.', persona));
      const dm = node(
        'llm',
        660,
        220,
        'dm',
        json(DM_RULES, `${TABLE_CONTEXT}\n\nWhat the players do:\n{{inputs}}\n\nRun this turn.`, '{"narration":"","rolls":[{"pc":"","kind":"attack|save|skill|damage"}],"resources":[{"pc":"","name":"","amount":1}],"hp":[{"pc":"","delta":0}],"conditions":[],"xp":0}', m.judge ?? m.text[0], { numCtx: 16384 }),
      );
      const out = node('output', 980, 220, 'Final answer');
      return { nodes: [q, ...players, dm, out], edges: [...players.map((p) => wire(q, p)), ...players.map((p) => wire(p, dm)), wire(dm, out)] };
    },
  },
  {
    id: 'dnd-portrait',
    group: 'Tabletop',
    name: 'Portraits',
    description: 'A model writes the portrait prompt; your image model draws 4 options.',
    needsImage: true,
    build: (m) =>
      chain(
        node('input', 0, 120, 'Character'),
        llm(320, 120, 'prompt', m.text[0], 'Write one image prompt (comma-separated keywords, subject first, then dark-fantasy painterly style, lighting and quality words; at most 50 words) for a portrait of: {{question}}. Reply with only the prompt.'),
        node('image', 640, 120, 'portraits', { ...(m.image && { model: m.image }), width: 832, height: 1216, batch: 4 }),
        node('output', 960, 120, 'Final answer'),
      ),
  },
];

// ---- Research: deep web research with several AIs per source, a shared memory, and follow-ups ----

/** All research shares one memory key; each run finds what it needs in it by searching for its question. */
const RESEARCH_KEY = 'research';

const SITE_REVIEW =
  'You review one web page for a research question. Start with "Source: <its url>". Then write what it says that matters for the question (facts, numbers, names, colours, dates, prices), ' +
  'how reliable it looks (shop, review, forum, official, old?), and anything it says that may contradict other sources. Be short and concrete; write "nothing useful" when it has nothing.';

const PAGE_PROMPT = 'Research question: {{question}}\n\nThe page:\n{{inputs}}';

const ANALYST_SYSTEM =
  'You read the notes of a web research (reviews of many sources by several AIs) and pull out what they add up to. Write: ' +
  '1. FACTS: what is well supported (by several sources), with the sources. ' +
  '2. CONFLICTS: where sources disagree (e.g. one says the shoe is blue, another red), with both sides and sources. ' +
  '3. LINKS: things that connect or explain each other, or point to something worth knowing. ' +
  '4. GAPS: what the question needs that nobody answered.';

const LEADS_SYSTEM =
  'From the analysts\' notes on a research, write the follow-up web searches worth doing: each conflict to settle, each link to check, each gap to fill. ' +
  'At most 4 short search queries, one per line, nothing else. If nothing is worth following up, write only: NONE';

const WRITER_SYSTEM =
  'You write the final answer of a web research, from the notes in memory and the analysts. Answer the question directly first. Then: the evidence with sources (links), ' +
  'conflicts and how they were settled (or that they are still open), and how sure you are. End with 2-3 ideas for more research. Never invent sources.';

const memoryRead = (x: number, y: number, label: string, limit = 40) => node('memory', x, y, label, { key: RESEARCH_KEY, mode: 'search', query: '{{question}}', limit });
const memoryWrite = (x: number, y: number, label: string) => node('memory', x, y, label, { key: RESEARCH_KEY, mode: 'save' });

/** Everyone who may review: the fast models and the strong one, without repeats. */
function reviewerPool(m: TemplateModels): ModelRef[] {
  const all = [...m.text, m.judge].filter((x): x is ModelRef => !!x);
  return all.filter((x, i) => all.findIndex((y) => y.providerId === x.providerId && y.model === x.model) === i);
}

/**
 * Search (adaptive), then each site is reviewed by 2 random AIs and kept in memory. Returns the blocks, the edges,
 * and the Collect block at the end.
 */
function searchAndReview(m: TemplateModels, x: number, y: number, label: string, opts: { list?: boolean; batch?: number; max?: number; rounds?: number }) {
  const fast = m.text[0] ?? m.judge;
  const pool = reviewerPool(m);
  const deep = node('deepSearch', x, y, label, {
    ...(fast && { model: fast }),
    ...(m.decision && { decider: m.decision }),
    source: 'duckduckgo',
    pageBatch: opts.batch ?? 5,
    maxPages: opts.max ?? 15,
    maxRounds: opts.rounds ?? 4,
    ...(opts.list && { searchList: true }),
    think: false,
  });
  const each = node('foreach', x + 300, y, 'For each site', { maxItems: 40 });
  const review = node('panel', x + 600, y, '2 random reviewers', { models: pool, count: 2, system: SITE_REVIEW, prompt: PAGE_PROMPT, think: false });
  const keep = memoryWrite(x + 900, y, 'Keep in memory');
  const all = node('collect', x + 1200, y, 'All sites reviewed');
  return { nodes: [deep, each, review, keep, all], edges: [wire(deep, each), wire(each, review), wire(review, keep), wire(keep, all)], first: deep, last: all };
}

function analysts(m: TemplateModels, x: number, y: number) {
  return node('panel', x, y, '3 analysts read the memory', { models: reviewerPool(m), count: 3, system: ANALYST_SYSTEM, prompt: 'Research question: {{question}}\n\nThe notes:\n{{inputs}}', think: false });
}

function deepResearch(m: TemplateModels): CanvasGraph {
  const fast = m.text[0] ?? m.judge;
  const strong = m.judge ?? m.text[0];
  const q = node('input', 0, 240, 'What to research');
  const one = searchAndReview(m, 300, 240, 'Deep search', {});
  const recall = memoryRead(1800, 240, 'Read the memory');
  const team = analysts(m, 2100, 240);
  const leads = node('llm', 2400, 240, 'Follow-ups to research', { ...(fast && { model: fast }), system: LEADS_SYSTEM, prompt: 'Research question: {{question}}\n\n{{inputs}}', think: false, maxTokens: 512 });
  const two = searchAndReview(m, 2700, 240, 'Research the follow-ups', { list: true, batch: 3, max: 9, rounds: 2 });
  const recallAll = memoryRead(4200, 240, 'Read the memory again', 60);
  const writer = node('llm', 4500, 240, 'Final answer', { ...(strong && { model: strong }), system: WRITER_SYSTEM, prompt: 'Research question: {{question}}\n\n{{inputs}}', think: false, maxTokens: 4096, numCtx: 32768 });
  const out = node('output', 4800, 240, 'Answer');
  return {
    nodes: [q, ...one.nodes, recall, team, leads, ...two.nodes, recallAll, writer, out],
    edges: [
      wire(q, one.first),
      ...one.edges,
      wire(one.last, recall),
      wire(recall, team),
      wire(team, leads),
      wire(leads, two.first),
      ...two.edges,
      wire(two.last, recallAll),
      wire(recallAll, writer),
      wire(team, writer),
      wire(writer, out),
    ],
  };
}

function digDeeper(m: TemplateModels): CanvasGraph {
  const fast = m.text[0] ?? m.judge;
  const strong = m.judge ?? m.text[0];
  const q = node('input', 0, 240, 'What to dig into');
  const recall = memoryRead(300, 240, 'What we know');
  const team = analysts(m, 600, 240);
  const leads = node('llm', 900, 240, 'What to research next', {
    ...(fast && { model: fast }),
    system: `${LEADS_SYSTEM} The owner asked to dig deeper into: use their words to choose. If the memory has nothing yet, write searches for the question itself.`,
    prompt: 'Dig deeper into: {{question}}\n\n{{inputs}}',
    think: false,
    maxTokens: 512,
  });
  const more = searchAndReview(m, 1200, 240, 'Research it', { list: true, batch: 5, max: 15, rounds: 3 });
  const recallAll = memoryRead(2700, 240, 'Read the memory again', 60);
  const writer = node('llm', 3000, 240, 'Answer', { ...(strong && { model: strong }), system: WRITER_SYSTEM, prompt: 'Research question: {{question}}\n\n{{inputs}}', think: false, maxTokens: 4096, numCtx: 32768 });
  const out = node('output', 3300, 240, 'Answer');
  return {
    nodes: [q, recall, team, leads, ...more.nodes, recallAll, writer, out],
    edges: [wire(q, recall), wire(recall, team), wire(team, leads), wire(leads, more.first), ...more.edges, wire(more.last, recallAll), wire(recallAll, writer), wire(team, writer), wire(writer, out)],
  };
}

/**
 * Overnight: the same search with 2 random reviewers per site on the fast models, then one big slow model (a colibri
 * giant such as GLM-5.2 or DeepSeek V4) reads the notes and writes the answer. Its blocks may take hours, and get
 * short prompts: on the CPU a long prompt costs more than the answer.
 */
function overnightResearch(m: TemplateModels): CanvasGraph {
  const fast = m.text[0] ?? m.judge;
  const big = m.slow ?? m.judge ?? m.text[0];
  const hours = 6 * 3600;
  const q = node('input', 0, 240, 'What to research');
  const one = searchAndReview(m, 300, 240, 'Deep search', { batch: 5, max: 20, rounds: 4 });
  const recall = memoryRead(1800, 240, 'Read the memory', 20);
  const think = node('llm', 2100, 240, 'Big model: facts, conflicts, links', {
    ...(big && { model: big }),
    system: ANALYST_SYSTEM,
    prompt: 'Research question: {{question}}\n\nThe notes:\n{{inputs}}',
    maxTokens: 2048,
    maxSeconds: hours,
  });
  const leads = node('llm', 2400, 240, 'Follow-ups to research', { ...(fast && { model: fast }), system: LEADS_SYSTEM, prompt: 'Research question: {{question}}\n\n{{inputs}}', think: false, maxTokens: 512 });
  const two = searchAndReview(m, 2700, 240, 'Research the follow-ups', { list: true, batch: 3, max: 12, rounds: 2 });
  const recallAll = memoryRead(4200, 240, 'Read the memory again', 20);
  const writer = node('llm', 4500, 240, 'Big model: final answer', {
    ...(big && { model: big }),
    system: WRITER_SYSTEM,
    prompt: 'Research question: {{question}}\n\n{{inputs}}',
    maxTokens: 4096,
    maxSeconds: hours,
  });
  const out = node('output', 4800, 240, 'Answer');
  return {
    nodes: [q, ...one.nodes, recall, think, leads, ...two.nodes, recallAll, writer, out],
    edges: [
      wire(q, one.first),
      ...one.edges,
      wire(one.last, recall),
      wire(recall, think),
      wire(think, leads),
      wire(leads, two.first),
      ...two.edges,
      wire(two.last, recallAll),
      wire(recallAll, writer),
      wire(think, writer),
      wire(writer, out),
    ],
  };
}

// ---- Colibri: a first workflow that shows what the built-in engine does, step by step ----

const COLIBRI_EXPLAIN = [
  '{{inputs}}',
  '',
  '---',
  '**How this workflow worked** (Colibri: start here)',
  '',
  '1. **Your question** came in.',
  '2. **Colibri sorts it** (a Decide block): the colibri model read your question and answered one typed question, "is this about code or a normal chat?", with a probability for each option instead of free text. That is the Jev-style decision API (/v1/systemone) colibri has built in.',
  '3. Only the matching block ran: **code** (the coder model, or the same model when you have one) or **chat**. The block whose name is the answer runs; the other is skipped.',
  '4. The model ran inside HiveMind, in the colibri engine: the parts of the model it uses most sit on the GPU and in RAM, the rest is read from the disk when needed. The first call loads the model (that can take a minute); after that it stays loaded until a few minutes without calls (Settings → Colibri).',
  '5. This block added this explanation under the answer. Delete it in the editor when you only want the answer.',
].join('\n');

/** Colibri: start here: sort the question with colibri's decisions, answer with the matching colibri model, explain. */
function colibriStart(m: TemplateModels): CanvasGraph {
  const chat = m.colibri?.chat ?? m.text[0];
  const coder = m.colibri?.coder ?? chat;
  const decide = m.colibri?.decide ?? m.decision;
  const q = node('input', 0, 200, 'Your question');
  const sort = node('decide', 320, 200, 'Colibri sorts it', {
    ...(decide && { model: decide }),
    state: 'Question: {{question}}',
    threshold: 0.5,
    questions: [
      {
        name: 'kind',
        type: 'choice',
        instructions: 'Is this question about programming (writing, fixing or explaining code), or a normal chat question?',
        options: [
          { name: 'code', description: 'Programming: code, errors, scripts, software' },
          { name: 'chat', description: 'Anything else: facts, advice, writing, ideas' },
        ],
        safe: 'chat',
      },
    ],
  });
  const code = node('llm', 680, 80, 'code', {
    ...(coder && { model: coder }),
    system: 'You are a careful programmer. Answer with working code and a short explanation of how it works.',
    prompt: '{{question}}',
    think: false,
    maxTokens: 4096,
  });
  const talk = node('llm', 680, 320, 'chat', { ...(chat && { model: chat }), system: 'Answer clearly and to the point.', prompt: '{{question}}', think: false, maxTokens: 1536 });
  const explain = node('template', 1040, 200, 'Explain what happened', { prompt: COLIBRI_EXPLAIN });
  const out = node('output', 1360, 200, 'Answer');
  return { nodes: [q, sort, code, talk, explain, out], edges: [wire(q, sort), wire(sort, code), wire(sort, talk), wire(code, explain), wire(talk, explain), wire(explain, out)] };
}

/** Jev (or another decision model) sorts the question; one specialist per branch answers. */
function hivemindRouter(m: TemplateModels): CanvasGraph {
  const main = m.colibri?.chat ?? m.text[0];
  const coder = m.colibri?.coder ?? main;
  const fast = m.fast ?? main;
  const deep = m.deep ?? m.slow ?? m.judge ?? main;
  const decide = m.decision ?? m.colibri?.decide;
  const q = node('input', 0, 360, 'Your question');
  const sort = node('decide', 320, 360, 'Jev sorts it', {
    ...(decide && { model: decide }),
    state: 'Question: {{question}}',
    threshold: 0.55,
    keepAlive: '30m',
    questions: [
      {
        name: 'kind',
        type: 'choice',
        instructions: 'What kind of question is this? Pick the branch that should answer it.',
        options: [
          { name: 'chat', description: 'Small talk, greetings, quick facts or simple questions' },
          { name: 'code', description: 'Writing, fixing or explaining code, scripts, errors, software' },
          { name: 'reasoning', description: 'Math, logic, puzzles, anything to work out step by step' },
          { name: 'writing', description: 'Stories, mails, texts, poems, rewriting' },
          { name: 'deep', description: 'Hard planning, big decisions, long complex questions' },
          { name: 'home', description: 'Switching lights or devices in the house, the house state' },
          { name: 'picture', description: 'The question has a picture attached (hm-file image) or asks about one' },
        ],
        safe: 'chat',
      },
    ],
  });
  const branch = (label: string, y: number, model: ModelRef | undefined, cfg: NodeConfig) => node('llm', 720, y, label, { ...(model && { model }), prompt: '{{question}}', ...cfg });
  const chat = branch('chat', 0, fast, { system: 'Answer briefly and warmly, in one to three sentences.', think: false, maxTokens: 512 });
  const code = branch('code', 130, coder, { system: 'You are a careful programmer. Answer with working code and a short explanation.', think: false, maxTokens: 4096 });
  const reasoning = branch('reasoning', 260, main, { system: 'Work it out step by step, then give the answer on its own line.', think: true, maxTokens: 6144 });
  const writing = branch('writing', 390, main, { system: 'You are a skilled writer. Write exactly what is asked, in a natural voice.', think: false, maxTokens: 3072 });
  const deepB = branch('deep', 520, deep, { system: 'Think this through carefully: options, risks, a clear plan. Be concrete.', maxTokens: 6144, maxSeconds: 7200 });
  const home = node('homeassistant', 720, 650, 'home', { haOp: 'assist', body: '{{question}}' });
  const picture = branch('picture', 780, m.vision ?? main, { system: 'Look at the picture carefully and answer the question about it.', think: false, maxTokens: 1536, ...(m.vision && { pictures: 'direct' as const }) });
  const out = node('output', 1100, 360, 'Answer');
  const branches = [chat, code, reasoning, writing, deepB, home, picture];
  return { nodes: [q, sort, ...branches, out], edges: [wire(q, sort), ...branches.map((b) => wire(sort, b)), ...branches.map((b) => wire(b, out))] };
}

const COLIBRI: Template[] = [
  {
    id: 'hivemind-router',
    group: 'Everyday',
    name: 'HiveMind: smart router',
    description:
      'Jev decides what your question is (chat, code, reasoning, writing, deep, home or picture) in a fraction of a second, and the specialist for that branch answers: a fast model for chat, the coder for code, a thinking model for reasoning, the big model for deep questions, Home Assistant for the house and a model that sees for pictures. Unsure: chat.',
    needsDecision: true,
    build: hivemindRouter,
  },
  {
    id: 'colibri-start',
    group: 'Everyday',
    name: 'Colibri: start here',
    description:
      'Your first colibri workflow (download a model in Settings → Colibri first): colibri decides whether your question is about code or a normal chat, the matching colibri model answers, and the answer ends with an explanation of every step.',
    build: colibriStart,
  },
];

const RESEARCH: Template[] = [
  {
    id: 'deep-research',
    group: 'Research',
    name: 'Deep research',
    description:
      'Searches the web in rounds (reads more sites or changes the search words when the first ones miss), has every site reviewed by 2 random AIs, keeps it all in memory, lets 3 AIs find facts, conflicts and links, researches those too, and writes the answer with sources.',
    build: deepResearch,
  },
  {
    id: 'deep-research-overnight',
    group: 'Research',
    name: 'Deep research: overnight',
    description:
      'Deep research for a big, slow model (a colibri giant such as GLM-5.2 or DeepSeek V4): the fast models search and review every site with 2 random AIs, then the big model reads the notes, finds conflicts and links, and writes the answer. Its blocks may take hours: start it in the evening.',
    build: overnightResearch,
  },
  {
    id: 'deep-research-more',
    group: 'Research',
    name: 'Deep research: dig deeper',
    description: 'Goes on from what the research memory already holds: finds conflicts, links and gaps, researches them on the web (2 random AIs per site), and answers again.',
    build: digDeeper,
  },
  {
    id: 'research-ask',
    group: 'Research',
    name: 'Research: what do we know?',
    description: 'Answers from the research memory only (no web): several AIs read the notes, one writes the answer with sources.',
    build: (m) => {
      const strong = m.judge ?? m.text[0];
      return chain(
        node('input', 0, 160, 'Question'),
        memoryRead(300, 160, 'Read the memory', 60),
        node('panel', 600, 160, '2 AIs read the notes', { models: reviewerPool(m), count: 2, system: ANALYST_SYSTEM, prompt: 'Question: {{question}}\n\nThe notes:\n{{inputs}}', think: false }),
        node('llm', 900, 160, 'Answer', { ...(strong && { model: strong }), system: `${WRITER_SYSTEM} Use only what is in the notes; say plainly what the memory does not know.`, think: false }),
        node('output', 1200, 160, 'Answer'),
      );
    },
  },
  {
    id: 'research-add',
    group: 'Research',
    name: 'Research: add notes',
    description: 'Adds your own notes or data to the research memory (one note per run); later research and answers use it like any source.',
    build: () =>
      chain(
        node('input', 0, 160, 'Your note or data'),
        node('memory', 320, 160, 'Keep in memory', { key: RESEARCH_KEY, mode: 'save' }),
        node('template', 640, 160, 'Saved', { prompt: 'Saved in the research memory:\n\n{{question}}' }),
        node('output', 960, 160, 'Result'),
      ),
  },
];

export const TEMPLATES: Template[] = [
  // ---- Everyday ----
  { id: 'council', group: 'Everyday', name: 'Council', description: '3 models answer, a judge merges the best parts.', build: (m) => council(m, false) },
  {
    id: 'council-review',
    group: 'Everyday',
    name: 'Council + review',
    description: '3 models answer, an anonymous review ranks them, then the judge decides.',
    build: (m) => council(m, true),
  },
  {
    id: 'chain',
    group: 'Everyday',
    name: 'Draft → improve',
    description: 'One model writes a first answer, a second one checks and improves it.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Question'),
        llm(320, 120, 'Draft', m.text[0]),
        llm(640, 120, 'Improve', m.judge ?? m.text[1], 'Question: {{question}}\n\nHere is a first answer:\n\n{{inputs}}\n\nCheck it for mistakes and missing points, then write an improved final answer.'),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'factcheck',
    group: 'Everyday',
    name: 'Fact-check with Wikipedia',
    description: 'Searches Wikipedia first, then answers from what it found, naming the sources.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Question'),
        node('search', 320, 120, 'Wikipedia', { source: 'wikipedia', count: 4 }),
        llm(640, 120, 'Answer from sources', m.judge ?? m.text[0], 'Question: {{question}}\n\nSearch results:\n{{inputs}}\n\nAnswer using only these results and name the articles you used. Say so if they do not answer it.'),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'summarize',
    group: 'Everyday',
    name: 'Summarize a file',
    description: 'Load a file (PDF, txt, …) and ask about it, e.g. "summarize in 5 points".',
    build: (m) => {
      const q = node('input', 0, 60, 'Question');
      const f = node('file', 0, 260, 'Your file');
      const a = llm(340, 160, 'Reader', m.judge ?? m.text[0], 'Document:\n{{inputs}}\n\nTask: {{question}}');
      const out = node('output', 680, 160, 'Final answer');
      return { nodes: [q, f, a, out], edges: [wire(q, a), wire(f, a), wire(a, out)] };
    },
  },
  {
    id: 'translate',
    group: 'Everyday',
    name: 'Translate',
    description: 'Paste text and say the language; a second model checks the translation.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Text + language'),
        llm(320, 120, 'Translator', m.text[0], undefined, 'You translate the text in the message into the language it asks for (English if none is named). Keep meaning, tone and formatting. Reply with only the translation.'),
        llm(640, 120, 'Proofreader', m.judge ?? m.text[1], 'Original request:\n{{question}}\n\nTranslation:\n{{inputs}}\n\nFix any mistakes and reply with only the final translation.'),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  { id: 'blank', group: 'Everyday', name: 'Empty canvas', description: 'Just a question and an answer. Drag in what you need.', build: () => ({ nodes: [node('input', 0, 120, 'Question'), node('output', 600, 120, 'Final answer')], edges: [] }) },

  // ---- Coding ----
  {
    id: 'code-review',
    group: 'Coding',
    name: 'Coder + reviewer',
    description: 'One model writes the code, a second reviews it for bugs and returns the fixed version.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Task'),
        llm(320, 120, 'Coder', m.text[0], undefined, 'You are a senior developer. Write clean, working code with short comments.'),
        llm(640, 120, 'Reviewer', m.judge ?? m.text[1], 'Task: {{question}}\n\nCode to review:\n{{inputs}}\n\nList bugs and problems briefly, then give the complete corrected code.'),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'bug-debate',
    group: 'Coding',
    name: 'Bug-hunt debate',
    description: 'Two models debate what is wrong with your code for 2 rounds; a judge writes the fix.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Code + problem'),
        node('debate', 320, 120, 'Bug hunt', { models: [m.text[0], m.text[1] ?? m.text[0]].filter((x): x is ModelRef => !!x), rounds: 2, system: 'You are debugging code with another engineer. Find the real cause and the fix.' }),
        node('judge', 640, 120, 'Fix', m.judge ? { model: m.judge } : {}),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'explain-code',
    group: 'Coding',
    name: 'Explain code from a file',
    description: 'Load a source file and ask what it does or how to change it.',
    build: (m) => {
      const q = node('input', 0, 60, 'Question');
      const f = node('file', 0, 260, 'Source file');
      const a = llm(340, 160, 'Explainer', m.judge ?? m.text[0], 'Code:\n{{inputs}}\n\nQuestion: {{question}}\n\nExplain clearly, with small examples.');
      const out = node('output', 680, 160, 'Final answer');
      return { nodes: [q, f, a, out], edges: [wire(q, a), wire(f, a), wire(a, out)] };
    },
  },
  {
    id: 'code-file',
    group: 'Coding',
    name: 'Code to file',
    description: 'Writes the code and saves it as a real file (.py, .js, …) in the files folder.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Task'),
        llm(320, 120, 'Coder', m.judge ?? m.text[0], undefined, 'Write complete, working code for the task in one fenced code block with the right language tag.'),
        node('save', 640, 120, 'Save code', { format: 'code', fileName: '{{question}}' }),
        node('output', 960, 120, 'Final answer'),
      ),
  },

  // ---- Creative ----
  {
    id: 'story',
    group: 'Creative',
    name: 'Story + editor',
    description: 'A writer drafts the story, an editor polishes it.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'Idea'),
        llm(320, 120, 'Writer', m.text[0], undefined, 'You are a creative writer. Write a vivid short story from the idea.'),
        llm(640, 120, 'Editor', m.judge ?? m.text[1], 'Idea: {{question}}\n\nDraft:\n{{inputs}}\n\nEdit for flow, pacing and style. Reply with only the final story.'),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'picture',
    group: 'Creative',
    name: 'Picture from an idea',
    description: 'A model turns your idea into an image prompt; your image model draws it.',
    needsImage: true,
    build: (m) =>
      chain(
        node('input', 0, 120, 'Idea'),
        llm(320, 120, 'Prompt writer', m.text[0], 'Write one image prompt (comma-separated keywords, subject first, then style, lighting and quality words; at most 50 words) for: {{question}}. Reply with only the prompt.'),
        node('image', 640, 120, 'Picture', { ...(m.image && { model: m.image }), width: 1024, height: 1024 }),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'brainstorm',
    group: 'Creative',
    name: 'Brainstorm + vote',
    description: 'Three models brainstorm ideas; a vote picks the best list.',
    build: (m) => {
      const q = node('input', 0, 240, 'Topic');
      const ideas = [0, 1, 2].map((i) => llm(320, i * 200 + 40, `Ideas ${i + 1}`, m.text[i] ?? m.text[0], 'Brainstorm 5 original ideas for: {{question}}. One line each.'));
      const vote = node('vote', 640, 240, 'Vote', { models: [m.judge ?? m.text[0]].filter((x): x is ModelRef => !!x) });
      const out = node('output', 960, 240, 'Final answer');
      return { nodes: [q, ...ideas, vote, out], edges: [...ideas.map((x) => wire(q, x)), ...ideas.map((x) => wire(x, vote)), wire(vote, out)] };
    },
  },

  // ---- Home / research ----
  {
    id: 'research',
    group: 'Home / research',
    name: 'Research with memory',
    description: 'Recalls what earlier runs learned, searches the web, answers, and remembers the result.',
    build: (m) => {
      const q = node('input', 0, 160, 'Question');
      const recall = node('memory', 320, 40, 'What I knew', { key: 'research', mode: 'recall', limit: 5 });
      const search = node('search', 320, 280, 'Web search', { count: 5 });
      const a = llm(640, 160, 'Researcher', m.judge ?? m.text[0], 'Question: {{question}}\n\nMaterial:\n{{inputs}}\n\nAnswer thoroughly; say what is new compared to what was known before.');
      const save = node('memory', 960, 160, 'Remember', { key: 'research', mode: 'save' });
      const out = node('output', 1280, 160, 'Final answer');
      return { nodes: [q, recall, search, a, save, out], edges: [wire(q, recall), wire(q, search), wire(recall, a), wire(search, a), wire(a, save), wire(save, out)] };
    },
  },
  {
    id: 'notes',
    group: 'Home / research',
    name: 'Ask your notes',
    description: 'Load notes or a manual (PDF/txt) and ask questions about them.',
    build: (m) => {
      const q = node('input', 0, 60, 'Question');
      const f = node('file', 0, 260, 'Notes / manual');
      const a = llm(340, 160, 'Answer', m.judge ?? m.text[0], 'Notes:\n{{inputs}}\n\nQuestion: {{question}}\n\nAnswer from the notes; say so when they do not cover it.');
      const out = node('output', 680, 160, 'Final answer');
      return { nodes: [q, f, a, out], edges: [wire(q, a), wire(f, a), wire(a, out)] };
    },
  },

  // ---- Website ----
  {
    id: 'website',
    group: 'Website',
    name: 'Website builder',
    description: 'A designer builds the site, a second model improves it; it is saved and shown in a live preview.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'What site?'),
        llm(320, 120, 'Designer', m.judge ?? m.text[0], SITE_PROMPT),
        llm(640, 120, 'Improver', m.judge ?? m.text[1], 'The user asked for: {{question}}\n\nHere is a website:\n{{inputs}}\n\nImprove the design and fix any bugs. Reply with only one ```html code block containing the complete improved page.'),
        node('save', 960, 120, 'Save site', { format: 'html', fileName: 'site-{{question}}' }),
        node('output', 1280, 120, 'Final answer'),
      ),
  },
  {
    id: 'landing',
    group: 'Website',
    name: 'Quick landing page',
    description: 'One model makes a single landing page fast, saved and previewed.',
    build: (m) =>
      chain(
        node('input', 0, 120, 'What site?'),
        llm(320, 120, 'Designer', m.judge ?? m.text[0], SITE_PROMPT),
        node('save', 640, 120, 'Save site', { format: 'html', fileName: 'site-{{question}}' }),
        node('output', 960, 120, 'Final answer'),
      ),
  },
  {
    id: 'site-builder',
    group: 'Website',
    name: 'Site builder (project)',
    description:
      'Keeps building one site in a project, run after run: a fast model plans and writes the files one by one (you check the plan), a strong model checks and polishes them, you check the site, and PROJECT.md remembers what was decided. Push to GitHub is its own workflow.',
    build: siteBuilder,
  },
  {
    id: 'site-quick',
    group: 'Website',
    name: 'Site: quick change',
    description: 'A small change to a project: a fast model edits the files, a strong model checks them, you look at the result, and PROJECT.md remembers it.',
    build: (m) => {
      const fast = m.text[0] ?? m.judge;
      const strong = m.judge ?? m.text[0];
      const read = node('readProject', 300, 160, 'Read project', {});
      const coder = node('llm', 600, 160, 'Coder', { ...(strong && { model: strong }), system: CODER_SYSTEM, prompt: QUICK_PROMPT, skillMode: 'auto', ...CODE_ANSWER });
      const g = chain(
        node('input', 0, 160, 'What to change'),
        read,
        coder,
        node('writeFiles', 900, 160, 'Write files', {}),
        node('readProject', 1200, 160, 'Read the site', {}),
        node('llm', 1500, 160, 'Checker', { ...(strong && { model: strong }), system: CHECK_SYSTEM, prompt: CHECK_PROMPT, ...CODE_ANSWER }),
        node('writeFiles', 1800, 160, 'Write fixes', { optionalWrite: true }),
        node('pause', 2100, 160, 'Check the changes', { title: 'Check the changes', prompt: 'Look at the changed files and the preview, then press Continue.' }),
        node('updateNotes', 2400, 160, 'Update PROJECT.md', { ...(fast && { model: fast }), think: false }),
        node('output', 2700, 160, 'Result'),
      );
      // With a decision model, Jev makes the small choices first.
      if (m.decision) {
        const d = quickDecisions(m, fast, 300, 400);
        g.nodes.push(d.ask, d.jev);
        g.edges.push(wire(read, d.ask), wire(d.ask, d.jev), wire(d.jev, coder));
      }
      return g;
    },
  },
  {
    id: 'site-push',
    group: 'Website',
    name: 'Site: push to GitHub',
    description: 'Commits everything in the project and pushes it to its GitHub repo (connect the project first on the Projects page). The question is the commit message.',
    build: () =>
      chain(
        node('input', 0, 160, 'Commit message'),
        node('git', 320, 160, 'Commit and push', { gitAction: 'commitPush', message: '{{question}}' }),
        node('output', 640, 160, 'Result'),
      ),
  },
  {
    id: 'software-builder',
    group: 'Coding',
    name: 'Software builder (project)',
    description:
      'Builds a program in a project, run after run (Node.js, also as a Windows .exe): a fast model plans and writes it, looks up online what it does not know, builds it, and when the build fails looks the error up and fixes it; a strong model checks it; PROJECT.md remembers it.',
    build: softwareBuilder,
  },
  ...RESEARCH,
  ...COLIBRI,
  ...VOICE,
  ...DECISIONS,
  ...TRAIN,
  ...TABLETOP,
];

// ---- Site builder: a project that grows run after run ----

/** The fast model: no thinking (small thinking models can loop), room for one whole file, a shorter time limit. */
const FAST_ANSWER: NodeConfig = { think: false, maxTokens: 16384, numCtx: 32768, maxSeconds: 900 };
/**
 * The strong model writing code: without thinking it answers several times faster, and a plan or one file needs no
 * long reasoning. (A 1B model can't write whole files: it gets the small jobs, the strong one the code.)
 */
const CODE_ANSWER: NodeConfig = { think: false, maxTokens: 16384, numCtx: 32768, maxSeconds: 1800 };

/** How a request changes a site that already exists: the part every model that writes needs to know. */
const EDIT_RULES =
  'The site already exists: you change it, you never start over. Keep everything the request does not mention: pages, text, sections, colours, links. ' +
  '"Make it about pandas and dogs" (when it is about pandas) means: keep all the panda content and add dogs next to it. ' +
  '"Instead of the purple block, a blue one" or "red letters instead of green" means: change only that colour or that part, everywhere it is used, and nothing else. ' +
  'PROJECT.md says what the site is and what was decided before; it wins over your own taste unless the request changes it.';

const PLANNER_SYSTEM =
  'You plan changes to a website project. Read PROJECT.md (the notes: what the site is, its style, pages and earlier decisions) and the files, then plan which files to create, change or delete for the request. ' +
  `${EDIT_RULES} Keep the plan small: only the files that really need to change (a colour change is often only the CSS). Use relative links between pages.`;

const PLAN_SCHEMA = '{"files": [{"path": "about.html", "action": "change", "reason": "add a dogs section under the pandas section"}]} — action is one of create, change, delete';

const CODER_SYSTEM =
  `You are a web developer working on a project of several files. ${EDIT_RULES} Write complete files, never parts or "…". ` +
  'Answer with each file in a code block whose first line names the path, like ```html path=pages/about.html — and nothing after the last block.';

const CODER_PROMPT =
  'The request: {{question}}\n\nThe file to write now (from the plan), PROJECT.md and the file as it is:\n\n{{inputs}}\n\n' +
  'Write the complete new content of that one file: the current file with the change made. If its action is "delete", answer with only {"delete": ["<its path>"]}.';

const QUICK_PROMPT =
  'The request: {{question}}\n\nThe project as it is:\n\n{{inputs}}\n\nMake the change. Answer with every file you change or add, complete, each in its own ```<lang> path=<path> block.';

const CHECK_SYSTEM =
  'You check a website project after a fast model changed it, and you are the last step before the owner looks at it. ' +
  '1. It works: links between pages point to files that exist, every page loads its CSS and scripts, the HTML is complete and valid. ' +
  '2. It did what was asked, and kept everything else (PROJECT.md says what the site is and what was decided). ' +
  '3. It looks polished: clear hierarchy, good spacing, a consistent colour palette and type scale, good contrast, hover states, and a layout that works on phones; prefer fixing the shared CSS. ' +
  'If something needs fixing, answer with only the fixed files, complete, each in a ```<lang> path=<path> block. If everything is fine, answer only: All good.';

const CHECK_PROMPT = 'The request was: {{question}}\n\nThe site after the change:\n\n{{inputs}}\n\nCheck it and fix what needs fixing.';

const ASK_SYSTEM =
  'You find the small choices a website change request leaves open, so a fast decision model can make them: the exact shade of a colour, a size, which font, where something goes, which existing page to change. ' +
  'Read the request, PROJECT.md and the site. Write at most 5 questions, each with 2 to 5 concrete options (real values like "#b91c1c dark red" or "Georgia (serif)"), and say in the instructions what the site looks like now so the question can be answered on its own. ' +
  'Only ask what the request really leaves open; never ask about things PROJECT.md or the request already decide. Nothing open: {"questions": []}.';

const ASK_SCHEMA = '{"questions": [{"name": "which_red", "type": "choice", "instructions": "The site is dark navy with white text. Which red fits the headings best?", "options": ["#b91c1c dark red", "#ef4444 bright red", "#f87171 soft red"]}]}';

/** A fast model writes the open questions, the decision model answers them in a moment; the rest of the run follows the answers. */
function quickDecisions(m: TemplateModels, fast: ModelRef | undefined, x: number, y: number) {
  const ask = node('llm', x, y, 'Questions for Jev', { ...(fast && { model: fast }), system: ASK_SYSTEM, prompt: 'The request: {{question}}\n\n{{inputs}}', json: true, jsonSchema: ASK_SCHEMA, ...FAST_ANSWER, maxTokens: 2048 });
  const jev = node('decide', x + 300, y, 'Jev decides', {
    ...(m.decision && { model: m.decision }),
    questionsFromInput: true,
    state: 'The owner asked for this change to their website: {{question}}',
  });
  return { ask, jev };
}

function siteBuilder(m: TemplateModels): CanvasGraph {
  // A fast model does the work (plan, files, notes); the strong one checks and polishes at the end.
  const fast = m.text[0] ?? m.judge;
  const strong = m.judge ?? m.text[0];
  const q = node('input', 0, 240, 'What to build or change');
  const read = node('readProject', 300, 240, 'Read project', {});
  const plan = node('llm', 600, 240, 'Planner', { ...(strong && { model: strong }), system: PLANNER_SYSTEM, prompt: 'The request: {{question}}\n\n{{inputs}}', json: true, jsonSchema: PLAN_SCHEMA, ...CODE_ANSWER, maxTokens: 4096 });
  const checkPlan = node('pause', 900, 240, 'Check the plan', { title: 'Check the plan', prompt: 'These files will be written. Edit the plan if you like, then press Continue.' });
  const each = node('foreach', 1200, 240, 'For each file', { maxItems: 30 });
  const readOne = node('readProject', 1500, 80, 'Read this file', { onlyNamed: true });
  const coder = node('llm', 1800, 240, 'Coder', { ...(strong && { model: strong }), system: CODER_SYSTEM, prompt: CODER_PROMPT, skillMode: 'auto', ...CODE_ANSWER });
  const write = node('writeFiles', 2100, 240, 'Write file', {});
  const all = node('collect', 2400, 240, 'All files written');
  const readSite = node('readProject', 2700, 240, 'Read the site', {});
  const check = node('llm', 3000, 240, 'Checker', { ...(strong && { model: strong }), system: CHECK_SYSTEM, prompt: CHECK_PROMPT, ...CODE_ANSWER });
  const fixes = node('writeFiles', 3300, 240, 'Write fixes', { optionalWrite: true });
  const checkSite = node('pause', 3600, 240, 'Check the site', { title: 'Check the site', prompt: 'Look at the changed files and the preview. Continue saves PROJECT.md (the memory for the next run).' });
  const notes = node('updateNotes', 3900, 240, 'Update PROJECT.md', { ...(fast && { model: fast }), think: false });
  const out = node('output', 4200, 240, 'Result');
  // With a decision model: small open choices ("which red?") are made by Jev before planning.
  const d = m.decision ? quickDecisions(m, fast, 300, 480) : undefined;
  return {
    nodes: [q, read, ...(d ? [d.ask, d.jev] : []), plan, checkPlan, each, readOne, coder, write, all, readSite, check, fixes, checkSite, notes, out],
    edges: [
      wire(q, read),
      ...(d ? [wire(read, d.ask), wire(d.ask, d.jev), wire(d.jev, plan), wire(d.jev, coder)] : []),
      wire(read, plan),
      wire(plan, checkPlan),
      wire(checkPlan, each),
      wire(each, readOne),
      wire(each, coder),
      wire(readOne, coder),
      wire(each, write),
      wire(coder, write),
      wire(write, all),
      wire(all, readSite),
      wire(readSite, check),
      wire(check, fixes),
      wire(fixes, checkSite),
      wire(checkSite, notes),
      wire(all, notes),
      wire(notes, out),
    ],
  };
}

// ---- Software builder: a program in a project, with web research and a fix-on-failure pass ----

const SW_EDIT_RULES =
  'The project already exists: you change it, you never start over. Keep everything the request does not mention: files, functions, options, behaviour. ' +
  'PROJECT.md says what the program is and what was decided before; it wins over your own taste unless the request changes it.';

const SW_TOOLING =
  'It is built with npm inside a Linux container (Node.js 24; no Python, Go, Rust or .NET compilers). ' +
  'A Windows .exe: a Node.js program with a package.json whose "build" script runs "npx --yes @yao-pkg/pkg . --targets node22-win-x64 --output dist/<name>.exe" (list the entry file in "bin"). ' +
  'A web app: Vite or plain HTML. A command-line tool: Node.js with a "bin" entry.';

const SW_PLANNER_SYSTEM =
  `You plan changes to a software project. Read PROJECT.md, the files and what was looked up online, then plan which files to create, change or delete for the request. ${SW_EDIT_RULES} ${SW_TOOLING} Keep the plan small.`;

const SW_RESEARCH_SYSTEM =
  'Before a software change is planned, you decide what to look up online: the parts of the request you are not sure how to do (the API of a library, packaging as an .exe, a file format, an error). ' +
  'Write at most 4 short web search queries, one per line, nothing else. If nothing needs looking up, write only: NONE';

const SW_PLAN_SCHEMA =
  '{"files": [{"path": "src/index.js", "action": "create", "reason": "the command-line entry point"}]} — action is one of create, change, delete';

const SW_CODER_SYSTEM =
  `You are a software developer working on a project of several files. ${SW_EDIT_RULES} ${SW_TOOLING} ` +
  'Use what was found online for exact APIs and options, not your memory. Write complete files, never parts or "…". ' +
  'Answer with each file in a code block whose first line names the path, like ```js path=src/index.js — and nothing after the last block.';

const SW_CODER_PROMPT =
  'The request: {{question}}\n\nThe file to write now (from the plan), PROJECT.md, the file as it is, and what was looked up online:\n\n{{inputs}}\n\n' +
  'Write the complete new content of that one file. If its action is "delete", answer with only {"delete": ["<its path>"]}.';

const SW_LOOKUP_SYSTEM =
  'A build failed. Read the end of the log and write 1 to 3 short web search queries that would find the fix (the exact error message, the tool and the package names). One per line, nothing else.';

const SW_FIX_SYSTEM =
  `The build of a software project failed. You get the log, the code and what was found online about the error. Find the cause and fix it. ${SW_EDIT_RULES} ${SW_TOOLING} ` +
  'Answer with only the fixed files, each complete, in a ```<lang> path=<path> block.';

const SW_CHECK_SYSTEM =
  'You check a software project after a fast model changed it, and you are the last step before the owner looks at it. ' +
  '1. It works: the files fit together (imports, file names, package.json scripts and dependencies), and the build log (if any) shows no errors. ' +
  '2. It did what was asked, and kept everything else (PROJECT.md says what the program is and what was decided). ' +
  '3. The code is clear and handles bad input. ' +
  'If something needs fixing, answer with only the fixed files, complete, each in a ```<lang> path=<path> block. If everything is fine, answer only: All good.';

const CODE_GLOBS = '*.js, *.mjs, *.cjs, *.ts, *.tsx, *.jsx, *.json, *.md, *.html, *.css, *.py';

function softwareBuilder(m: TemplateModels): CanvasGraph {
  const fast = m.text[0] ?? m.judge;
  const strong = m.judge ?? m.text[0];
  const q = node('input', 0, 240, 'What to build or change');
  const read = node('readProject', 300, 240, 'Read project', { globs: CODE_GLOBS });
  const plan = node('llm', 600, 240, 'Planner', { ...(strong && { model: strong }), system: SW_PLANNER_SYSTEM, prompt: 'The request: {{question}}\n\n{{inputs}}', json: true, jsonSchema: SW_PLAN_SCHEMA, ...CODE_ANSWER, maxTokens: 4096 });
  const checkPlan = node('pause', 900, 240, 'Check the plan', { title: 'Check the plan', prompt: 'These files will be written. Edit the plan if you like, then press Continue.' });
  const toLookUp = node('llm', 300, 0, 'What to look up', { ...(fast && { model: fast }), system: SW_RESEARCH_SYSTEM, prompt: 'The request: {{question}}\n\n{{inputs}}', ...FAST_ANSWER, maxTokens: 512 });
  const research = node('search', 600, 0, 'Look it up online', { source: 'duckduckgo', searchList: true, readPages: 1, count: 4 });
  const each = node('foreach', 1500, 240, 'For each file', { maxItems: 30 });
  const readOne = node('readProject', 1800, 60, 'Read this file', { onlyNamed: true });
  const coder = node('llm', 2100, 240, 'Coder', { ...(strong && { model: strong }), system: SW_CODER_SYSTEM, prompt: SW_CODER_PROMPT, skillMode: 'auto', ...CODE_ANSWER });
  const write = node('writeFiles', 2400, 240, 'Write file', {});
  const all = node('collect', 2700, 240, 'All files written');
  const build = node('build', 3000, 240, 'Build', { buildFailOk: true, buildOptional: true });
  const readCode = node('readProject', 4800, 240, 'Read the code', { globs: CODE_GLOBS });
  const check = node('llm', 5100, 240, 'Checker', { ...(strong && { model: strong }), system: SW_CHECK_SYSTEM, prompt: 'The request was: {{question}}\n\n{{inputs}}', ...CODE_ANSWER });
  const fixes = node('writeFiles', 5400, 240, 'Write fixes', { optionalWrite: true });
  const checkDone = node('pause', 5700, 240, 'Check the program', { title: 'Check the program', prompt: 'Look at the changed files (and the build in dist/). Continue saves PROJECT.md (the memory for the next run).' });
  const notes = node('updateNotes', 6000, 240, 'Update PROJECT.md', { ...(fast && { model: fast }), think: false });
  const out = node('output', 6300, 240, 'Result');
  const d = m.decision ? quickDecisions(m, fast, 300, 480) : undefined;
  const nodes = [q, read, ...(d ? [d.ask, d.jev] : []), toLookUp, research, plan, checkPlan, each, readOne, coder, write, all, build, readCode, check, fixes, checkDone, notes, out];
  const edges = [
    wire(q, read),
    ...(d ? [wire(read, d.ask), wire(d.ask, d.jev), wire(d.jev, plan), wire(d.jev, coder)] : []),
    wire(read, toLookUp),
    wire(toLookUp, research),
    wire(research, plan),
    wire(read, plan),
    wire(plan, checkPlan),
    wire(checkPlan, each),
    wire(each, readOne),
    wire(each, coder),
    wire(readOne, coder),
    wire(research, coder),
    wire(each, write),
    wire(coder, write),
    wire(write, all),
    wire(all, build),
    wire(readCode, check),
    wire(build, check),
    wire(check, fixes),
    wire(fixes, checkDone),
    wire(checkDone, notes),
    wire(all, notes),
    wire(notes, out),
  ];
  if (m.decision) {
    // The build failed? Jev says so; then the error is looked up online, fixed and built once more.
    const failed = node('decide', 3300, 240, 'Did the build fail?', {
      model: m.decision,
      questions: [{ name: 'failed', type: 'noul', instructions: 'Did the build fail? It failed when the text says BUILD FAILED or shows errors; "Build OK" or "BUILD SKIPPED" is not a failure.' }],
    });
    const lookup = node('llm', 3600, 60, 'failed: yes', { ...(fast && { model: fast }), system: SW_LOOKUP_SYSTEM, prompt: '{{inputs}}', ...FAST_ANSWER, maxTokens: 512 });
    const errSearch = node('search', 3900, 60, 'Look up the error', { source: 'duckduckgo', searchList: true, readPages: 1, count: 4 });
    const readForFix = node('readProject', 3900, 420, 'Read the code to fix', { globs: CODE_GLOBS });
    const fixer = node('llm', 4200, 240, 'Fixer', { ...(strong && { model: strong }), system: SW_FIX_SYSTEM, prompt: 'The request was: {{question}}\n\n{{inputs}}', ...CODE_ANSWER });
    const writeFix = node('writeFiles', 4500, 240, 'Write the fix', { optionalWrite: true });
    const rebuild = node('build', 4500, 420, 'Build again', { buildFailOk: true, buildOptional: true });
    nodes.push(failed, lookup, errSearch, readForFix, fixer, writeFix, rebuild);
    edges.push(
      wire(build, failed),
      wire(failed, lookup),
      wire(build, lookup),
      wire(lookup, errSearch),
      wire(lookup, readForFix),
      wire(errSearch, fixer),
      wire(readForFix, fixer),
      wire(build, fixer),
      wire(fixer, writeFix),
      wire(writeFix, rebuild),
      wire(failed, readCode),
      wire(rebuild, readCode),
      wire(rebuild, check),
    );
  } else {
    edges.push(wire(build, readCode));
  }
  return { nodes, edges };
}
