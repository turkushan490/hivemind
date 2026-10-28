import { HTTP_METHODS, NODE_TYPES, SEARCH_SOURCES, type CanvasGraph, type CanvasNode, type ModelInfo, type ModelRef, type NodeConfig, type NodeType } from '@hivemind/shared';
import { validateGraph } from '../engine/graph.js';
import { NODES } from '../nodes/index.js';

/**
 * The Builder: a model turns "I want X" into a canvas. It gets a compact description of every block,
 * the models that really exist, and the current canvas; it answers with a small JSON shape that is
 * checked, repaired and laid out here, so small local models can do it too.
 */

/** The shape the model writes: short ids, edges as pairs, models as "provider|model" strings. */
export interface BuilderCanvas {
  nodes: {
    id: string;
    type: string;
    label?: string;
    model?: string;
    models?: string[];
    rounds?: number;
    prompt?: string;
    system?: string;
    source?: string;
    count?: number;
    key?: string;
    mode?: string;
    query?: string;
    format?: string;
    fileName?: string;
    haOp?: string;
    entities?: string;
    service?: string;
    url?: string;
    method?: string;
    body?: string;
  }[];
  edges: [string, string][];
}

export interface BuilderReply {
  reply: string;
  canvas: BuilderCanvas | null;
}

const BLOCKS: Record<NodeType, string> = {
  input: 'the question comes in here. Exactly one per canvas.',
  llm: 'one model answers. Needs "model". Optional "prompt" with {{question}} and {{inputs}}, optional "system".',
  review: 'one model critiques and ranks the answers wired into it (anonymously). Needs "model".',
  judge: 'one model merges all incoming answers/reviews into one final answer. Needs "model". Usually the strongest model.',
  output: 'the final answer of the canvas. Exactly one per canvas, at the end.',
  router: 'a model picks ONE of the blocks wired after it (by their labels) to handle the question; the others are skipped. Needs "model". Give the blocks after it clear labels.',
  debate: 'several models answer, read each other and improve over "rounds" (1-4). Needs "models" (2 or more).',
  vote: 'models vote for the best of the answers wired into it; only the winner is passed on. Needs "models" (1 or more).',
  template: 'fixed text in "prompt" with {{question}} and {{inputs}} filled in.',
  file: 'text from a file the user loads later. No inputs. Leave its content empty.',
  search: `web search for the question (or the text of the block before it). Optional "source": ${SEARCH_SOURCES.join(' | ')}, "count" 1-10.`,
  memory: '"mode": "recall" brings back what was saved under "key"; "mode": "search" finds the best matching entries under "key" for "query" (default: the text wired in), e.g. rules from a rulebook; "mode": "save" remembers what flows through it under "key".',
  save: `saves what is wired into it as a file. "format": auto | md | txt | html | json | csv | code (auto = html for websites). Optional "fileName".`,
  homeassistant: 'Home Assistant action. "haOp": "state" reads "entities" (comma separated entity ids like sensor.temperature) and passes their states on; "haOp": "service" calls "service" (e.g. light.turn_on) with "body" as JSON data ({{input}} = text wired in). Only use when the user mentions Home Assistant or their smart home.',
  webhook: 'calls an HTTP "url" with "method" (GET/POST/PUT/PATCH/DELETE) and an optional "body" template ({{input}}, {{question}}); passes the response on.',
  discord: 'posts "body" (default {{input}}) to a Discord channel; the user pastes the webhook URL later. Put it after the block whose answer should be posted.',
  image: 'makes an image. Needs "model" (an image model from the list). Draws "prompt" if set, else the text of the block before it (put a model before it that writes an image prompt).',
};

const ref = (m: ModelInfo) => `${m.providerId}|${m.model}`;

function modelLine(m: ModelInfo): string {
  const gb = (m.sizeBytes ?? 0) / 1e9;
  if (m.kind === 'image') return `- ${ref(m)} (IMAGE model, only for "image" blocks)`;
  const tier = !m.sizeBytes ? 'cloud' : gb < 2 ? 'tiny, fast but weak' : gb < 6 ? 'small' : gb < 12 ? 'medium' : 'large';
  const tags = [m.free ? 'free' : 'paid', m.sizeBytes ? `local ${gb.toFixed(1)} GB` : 'cloud', ...(m.sizeBytes ? [tier] : [])];
  return `- ${ref(m)} (${tags.join(', ')})`;
}

/** Turns a stored graph into the compact shape the model reads and writes. */
export function toBuilderCanvas(g: CanvasGraph): BuilderCanvas {
  return {
    nodes: g.nodes.map((n) => {
      const c = n.config;
      return {
        id: n.id,
        type: n.type,
        ...(n.label && { label: n.label }),
        ...(c.model && { model: `${c.model.providerId}|${c.model.model}` }),
        ...(c.models && { models: c.models.map((m) => `${m.providerId}|${m.model}`) }),
        ...(c.rounds && { rounds: c.rounds }),
        ...(c.prompt && { prompt: c.prompt }),
        ...(c.system && { system: c.system }),
        ...(c.source && { source: c.source }),
        ...(c.count && { count: c.count }),
        ...(c.key && { key: c.key }),
        ...(c.mode && { mode: c.mode }),
        ...(c.query && { query: c.query }),
        ...(c.format && { format: c.format }),
        ...(c.haOp && { haOp: c.haOp }),
        ...(c.entities && { entities: c.entities }),
        ...(c.service && { service: c.service }),
        ...(c.method && { method: c.method }),
        ...(c.body && { body: c.body }),
      };
    }),
    edges: g.edges.map((e) => [e.source, e.target]),
  };
}

export function builderSystemPrompt(models: ModelInfo[]): string {
  const text = models.filter((m) => !m.kind && !(m.sizeBytes !== undefined && m.sizeBytes < 50e6)).slice(0, 50);
  const usable = [...text, ...models.filter((m) => m.kind === 'image').slice(0, 12)];
  return [
    'You are the Builder inside HiveMind, an app where AI models work together on a canvas of blocks wired left to right.',
    'You design or change canvases for the user. Keep them as simple as the request allows.',
    '',
    'Blocks ("type"):',
    ...NODE_TYPES.map((t) => `- ${t}: ${BLOCKS[t]}`),
    '',
    'Models you may use (copy the id before the space exactly; never invent one):',
    ...(usable.length ? usable.map(modelLine) : ['- (no models connected yet: leave "model" out)']),
    ...(usable.some((m) => m.kind === 'image') ? [] : ['(No image models are connected: do not use "image" blocks.)']),
    'Prefer local or free models. Use the strongest local or a cloud model as judge. Avoid "tiny" models for answering when small or medium ones exist; tiny ones are fine for a Router.',
    '',
    'Rules: every canvas has exactly one "input" and one "output"; edges go from earlier to later blocks, no loops; ids are short words like "q", "coder", "judge", "out".',
    'Wire every block: a Memory with mode "save" sits right before "output" (fed by the block whose answer to remember); a Memory "recall", File or Search feeds the model blocks that should use it; a Router feeds the blocks it chooses between.',
    '',
    'Answer with ONLY one JSON object, no other text:',
    '{"reply": "one or two friendly sentences about what you built or why you did not", "canvas": {"nodes": [{"id": "q", "type": "input", "label": "Question"}, {"id": "a", "type": "llm", "label": "Answer", "model": "<model id>"}, {"id": "out", "type": "output", "label": "Final answer"}], "edges": [["q", "a"], ["a", "out"]]}}',
    'Set "canvas" to null when the user only asks a question and nothing should change.',
  ].join('\n');
}

export function builderUserPrompt(message: string, current: CanvasGraph | undefined): string {
  const now = current && current.nodes.length ? `Current canvas:\n${JSON.stringify(toBuilderCanvas(current))}\n\n` : 'The canvas is empty.\n\n';
  return `${now}User: ${message}`;
}

/** Pulls the JSON object out of a reply, even with chatter or ```json fences around it. */
export function parseReply(text: string): BuilderReply {
  const json = firstJsonObject(text);
  if (!json) throw new Error('The answer contained no JSON object');
  const data = JSON.parse(json) as Partial<BuilderReply> & Partial<BuilderCanvas>;
  // Some models skip the wrapper and return the canvas itself.
  if (Array.isArray(data.nodes)) return { reply: '', canvas: data as BuilderCanvas };
  return { reply: typeof data.reply === 'string' ? data.reply : '', canvas: data.canvas ?? null };
}

/** The first balanced {...} in the text (models sometimes write a second object or notes after it). */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
}

/**
 * Turns the model's canvas into a valid graph: known types only, real models (or sensible fallbacks),
 * one input and output, unknown or looping wires dropped, then a clean left-to-right layout.
 * Returns notes about what had to be fixed.
 */
export function toGraph(c: BuilderCanvas, models: ModelInfo[]): { graph: CanvasGraph; fixes: string[] } {
  const fixes: string[] = [];
  if (!c || !Array.isArray(c.nodes)) throw new Error('"canvas.nodes" must be a list');
  const textModels = models.filter((m) => !m.kind);
  const imageModels = models.filter((m) => m.kind === 'image');
  const known = new Map(textModels.map((m) => [ref(m), m]));
  const local = textModels.filter((m) => (m.sizeBytes ?? 0) > 50e6).sort((a, b) => a.sizeBytes! - b.sizeBytes!);
  const fallbackSmall = local[0] ?? textModels[0];
  const fallbackBig = [...local].reverse().find((m) => m.sizeBytes! < 10e9) ?? textModels.find((m) => !m.sizeBytes) ?? fallbackSmall;
  const asImage = (id: string | undefined): ModelRef | undefined => {
    const m = (id && imageModels.find((x) => ref(x) === id || x.model === id)) || imageModels[0];
    if (id && m && ref(m) !== id && m.model !== id) fixes.push(`"${id}" is not an image model; used ${m.model}`);
    return m ? { providerId: m.providerId, model: m.model } : undefined;
  };
  const asRef = (id: string | undefined, big: boolean): ModelRef | undefined => {
    const m = (id && (known.get(id) ?? textModels.find((x) => x.model === id || ref(x).endsWith(`|${id}`)))) || (big ? fallbackBig : fallbackSmall);
    if (id && !known.has(id) && m) fixes.push(`"${id}" is not an available model; used ${m.model}`);
    return m ? { providerId: m.providerId, model: m.model } : undefined;
  };

  const nodes: CanvasNode[] = [];
  const ids = new Set<string>();
  for (const raw of c.nodes) {
    const type = String(raw.type ?? '').toLowerCase() as NodeType;
    if (!NODE_TYPES.includes(type)) {
      fixes.push(`Left out unknown block type "${raw.type}"`);
      continue;
    }
    let id = String(raw.id ?? type).replace(/[^\w-]/g, '').slice(0, 40) || type;
    while (ids.has(id)) id = `${id}_2`;
    ids.add(id);
    const def = NODES[type];
    const config: NodeConfig = {};
    if (type === 'image') config.model = asImage(raw.model);
    else if (def.usesModel) config.model = asRef(raw.model, type === 'judge' || type === 'router');
    if (def.minModels) {
      const list = (raw.models ?? []).map((m) => asRef(m, false)).filter((m): m is ModelRef => !!m);
      while (list.length < def.minModels && fallbackSmall) list.push(asRef(undefined, list.length > 0)!);
      config.models = list;
    }
    if (type === 'debate') config.rounds = Math.max(1, Math.min(4, Number(raw.rounds) || 2));
    if (raw.prompt) config.prompt = String(raw.prompt);
    if (raw.system && (def.usesModel || def.minModels)) config.system = String(raw.system);
    if (type === 'search') {
      if (SEARCH_SOURCES.includes(raw.source as never)) config.source = raw.source as NodeConfig['source'];
      if (raw.count) config.count = Math.max(1, Math.min(10, Number(raw.count) || 5));
    }
    if (type === 'save') config.format = (['auto', 'md', 'txt', 'html', 'json', 'csv', 'code'] as const).find((f) => f === raw.format) ?? 'auto';
    if (type === 'memory') {
      config.key = String(raw.key || 'default');
      config.mode = raw.mode === 'save' ? 'save' : raw.mode === 'search' ? 'search' : 'recall';
      if (raw.mode === 'search' && raw.query) config.query = String(raw.query);
    }
    if (type === 'homeassistant') {
      config.haOp = raw.haOp === 'service' ? 'service' : 'state';
      if (raw.entities) config.entities = String(raw.entities);
      if (raw.service) config.service = String(raw.service);
      if (raw.body) config.body = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body);
    }
    if (type === 'webhook' || type === 'discord') {
      if (type === 'webhook' && raw.url) config.url = String(raw.url);
      if (type === 'webhook') config.method = (HTTP_METHODS as readonly string[]).includes(String(raw.method).toUpperCase()) ? (String(raw.method).toUpperCase() as NodeConfig['method']) : 'POST';
      if (raw.body) config.body = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body);
    }
    nodes.push({ id, type, label: raw.label ? String(raw.label).slice(0, 60) : undefined, position: { x: 0, y: 0 }, config });
  }

  // Exactly one Question and one Final answer.
  const inputs = nodes.filter((n) => n.type === 'input');
  if (inputs.length === 0) {
    nodes.unshift({ id: 'q', type: 'input', label: 'Question', position: { x: 0, y: 0 }, config: {} });
    fixes.push('Added the Question block');
  }
  for (const extra of inputs.slice(1)) nodes.splice(nodes.indexOf(extra), 1);
  if (!nodes.some((n) => n.type === 'output')) {
    nodes.push({ id: 'out', type: 'output', label: 'Final answer', position: { x: 0, y: 0 }, config: {} });
    fixes.push('Added the Final answer block');
  }

  // Wires: only between existing blocks, no duplicates, no loops, never into Question or out of Final answer.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: CanvasGraph['edges'] = [];
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (x === to) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      edges.filter((e) => e.source === x).forEach((e) => stack.push(e.target));
    }
    return false;
  };
  for (const pair of Array.isArray(c.edges) ? c.edges : []) {
    const [a, b] = Array.isArray(pair) ? pair.map(String) : [String((pair as any)?.source), String((pair as any)?.target)];
    const s = byId.get(a);
    const t = byId.get(b);
    if (!s || !t || a === b || t.type === 'input' || t.type === 'file' || s.type === 'output') continue;
    if (edges.some((e) => e.source === a && e.target === b) || reaches(b, a)) continue;
    edges.push({ id: `${a}->${b}`, source: a, target: b });
  }

  // A "save" Memory nobody feeds remembers the final result: it goes between the last blocks and the output.
  for (const m of nodes.filter((n) => n.type === 'memory' && n.config.mode === 'save')) {
    if (edges.some((e) => e.target === m.id)) continue;
    const out = nodes.find((n) => n.type === 'output')!;
    const feeding = edges.filter((e) => e.target === out.id && e.source !== m.id);
    if (!feeding.length) continue;
    for (const e of feeding) {
      edges.splice(edges.indexOf(e), 1);
      edges.push({ id: `${e.source}->${m.id}`, source: e.source, target: m.id });
    }
    if (!edges.some((e) => e.source === m.id && e.target === out.id)) edges.push({ id: `${m.id}->${out.id}`, source: m.id, target: out.id });
    fixes.push(`Put "${m.label ?? m.id}" right before the final answer`);
  }

  // Blocks left without a wire are hooked up so the canvas runs: inputs from the Question, dead ends into the output.
  const q = nodes.find((n) => n.type === 'input')!;
  const out = nodes.find((n) => n.type === 'output')!;
  for (const n of nodes) {
    if (n === q || n.type === 'file') continue;
    if (!edges.some((e) => e.target === n.id)) {
      edges.push({ id: `${q.id}->${n.id}`, source: q.id, target: n.id });
      if (n !== out) fixes.push(`Wired the question into "${n.label ?? n.id}"`);
    }
  }
  for (const n of nodes) {
    if (n === out || n === q) continue;
    if (!edges.some((e) => e.source === n.id)) {
      edges.push({ id: `${n.id}->${out.id}`, source: n.id, target: out.id });
    }
  }
  // The Question straight into the output only makes sense when nothing else feeds it.
  const direct = edges.findIndex((e) => e.source === q.id && e.target === out.id);
  if (direct >= 0 && edges.some((e) => e.target === out.id && e.source !== q.id)) edges.splice(direct, 1);

  const graph = layout({ nodes, edges });
  validateGraph(graph);
  return { graph, fixes };
}

/** Left-to-right layers by longest path from the start; blocks in a layer are spread out vertically. */
export function layout(g: CanvasGraph): CanvasGraph {
  const depth = new Map<string, number>();
  const order = validateGraph(g);
  for (const id of order) {
    const parents = g.edges.filter((e) => e.target === id).map((e) => depth.get(e.source) ?? 0);
    depth.set(id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const layers = new Map<number, string[]>();
  for (const id of order) layers.set(depth.get(id)!, [...(layers.get(depth.get(id)!) ?? []), id]);
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const d = depth.get(n.id)!;
      const layer = layers.get(d)!;
      const i = layer.indexOf(n.id);
      return { ...n, position: { x: d * 320, y: (i - (layer.length - 1) / 2) * 190 } };
    }),
  };
}
