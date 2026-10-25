import type { CanvasEdge, CanvasGraph, CanvasNode, ModelRef, NodeType } from '@hivemind/shared';

export interface Template {
  id: string;
  name: string;
  description: string;
  build(models: (ModelRef | undefined)[]): CanvasGraph;
}

let counter = 0;
export const newNodeId = (type: NodeType) => `${type}-${Date.now().toString(36)}${(counter++).toString(36)}`;

const node = (type: NodeType, x: number, y: number, label?: string, model?: ModelRef, extra: Partial<CanvasNode['config']> = {}): CanvasNode => ({
  id: newNodeId(type),
  type,
  label,
  position: { x, y },
  config: { ...(model && { model }), ...extra },
});

const wire = (a: CanvasNode, b: CanvasNode): CanvasEdge => ({ id: `${a.id}->${b.id}`, source: a.id, target: b.id });

function council(models: (ModelRef | undefined)[], withReview: boolean): CanvasGraph {
  const q = node('input', 0, 240, 'Question');
  const members = [0, 1, 2].map((i) => node('llm', 300, i * 200 + 40, `Member ${i + 1}`, models[i] ?? models[0]));
  const judge = node('judge', withReview ? 900 : 620, 240, 'Judge', models[3] ?? models[0]);
  const out = node('output', withReview ? 1200 : 920, 240, 'Final answer');
  const nodes = [q, ...members, judge, out];
  const edges = [...members.map((m) => wire(q, m)), ...members.map((m) => wire(m, judge)), wire(judge, out)];
  if (withReview) {
    const review = node('review', 620, 460, 'Anonymous review', models[3] ?? models[0]);
    nodes.push(review);
    edges.push(...members.map((m) => wire(m, review)), wire(review, judge));
  }
  return { nodes, edges };
}

export const TEMPLATES: Template[] = [
  {
    id: 'council',
    name: 'Council',
    description: '3 models answer, a judge merges the best parts.',
    build: (m) => council(m, false),
  },
  {
    id: 'council-review',
    name: 'Council + review',
    description: '3 models answer, an anonymous review ranks them, then the judge decides.',
    build: (m) => council(m, true),
  },
  {
    id: 'chain',
    name: 'Draft → improve',
    description: 'One model writes a first answer, a second one checks and improves it.',
    build: (m) => {
      const q = node('input', 0, 120, 'Question');
      const draft = node('llm', 300, 120, 'Draft', m[0]);
      const improve = node('llm', 600, 120, 'Improve', m[1] ?? m[0], {
        prompt: 'Question: {{question}}\n\nHere is a first answer:\n\n{{inputs}}\n\nCheck it for mistakes and missing points, then write an improved final answer.',
      });
      const out = node('output', 900, 120, 'Final answer');
      return { nodes: [q, draft, improve, out], edges: [wire(q, draft), wire(draft, improve), wire(improve, out)] };
    },
  },
  {
    id: 'blank',
    name: 'Empty canvas',
    description: 'Just a question and an answer. Drag in what you need.',
    build: () => {
      const q = node('input', 0, 120, 'Question');
      const out = node('output', 600, 120, 'Final answer');
      return { nodes: [q, out], edges: [] };
    },
  },
];
