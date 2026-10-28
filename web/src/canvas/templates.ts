import type { CanvasEdge, CanvasGraph, CanvasNode, ModelRef, NodeConfig, NodeType } from '@hivemind/shared';

/** Models a template is filled with: fast members, a strong judge, and an image model when there is one. */
export interface TemplateModels {
  text: (ModelRef | undefined)[];
  judge?: ModelRef;
  image?: ModelRef;
}

export const TEMPLATE_GROUPS = ['Everyday', 'Coding', 'Creative', 'Home / research', 'Website', 'Tabletop'] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

export interface Template {
  id: string;
  group: TemplateGroup;
  name: string;
  description: string;
  /** Needs an image model (ComfyUI or an image API) to run. */
  needsImage?: boolean;
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
  ...TABLETOP,
];
