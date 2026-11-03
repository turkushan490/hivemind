import { NODE_TYPES, type CanvasGraph } from '@hivemind/shared';
import { NODES } from '../nodes/index.js';

/** Checks a graph and returns its nodes in run order. Throws with a readable message. */
export function validateGraph(graph: CanvasGraph): string[] {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Graph needs nodes and edges');
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id || ids.has(n.id)) throw new Error(`Duplicate or empty node id "${n.id}"`);
    if (!NODE_TYPES.includes(n.type)) throw new Error(`Unknown node type "${n.type}"`);
    const def = NODES[n.type];
    const optional = !!def.modelOptional?.(n.config ?? {});
    if (def.usesModel && !optional && !(n.config?.model?.providerId && n.config.model.model)) throw new Error(`Node "${n.label ?? n.id}" has no model selected`);
    const problem = def.check?.(n.config ?? {});
    if (problem) throw new Error(`"${n.label ?? n.id}": ${problem}`);
    const min = def.minModels;
    if (min && !optional && (n.config?.models ?? []).filter((m) => m?.providerId && m.model).length < min)
      throw new Error(`"${n.label ?? n.type}" needs at least ${min} model${min > 1 ? 's' : ''}`);
    ids.add(n.id);
  }
  if (!graph.nodes.some((n) => n.type === 'input')) throw new Error('Graph needs an input node');
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) throw new Error(`Edge "${e.id}" points to a missing node`);
    if (e.source === e.target) throw new Error(`Edge "${e.id}" loops onto itself`);
  }

  // Kahn's algorithm: also detects cycles.
  const indeg = new Map([...ids].map((id) => [id, 0]));
  for (const e of graph.edges) indeg.set(e.target, indeg.get(e.target)! + 1);
  const queue = [...ids].filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges) {
      if (e.source !== id) continue;
      indeg.set(e.target, indeg.get(e.target)! - 1);
      if (indeg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (order.length !== ids.size) throw new Error('Graph has a cycle');
  loopsOf(graph);
  return order;
}

/** A For each block, its Collect block, and the blocks between them (run once per item). */
export interface Loop {
  foreach: string;
  collect: string;
  body: Set<string>;
}

/**
 * The For each … Collect parts of a graph. Each For each needs exactly one Collect after it; the blocks between
 * them only take input from inside the loop or from blocks that finish before the For each, and only feed blocks
 * inside the loop or the Collect. Loops can't be nested. Throws with a readable message.
 */
export function loopsOf(graph: CanvasGraph): Loop[] {
  const children = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  const parents = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    children.get(e.source)?.push(e.target);
    parents.get(e.target)?.push(e.source);
  }
  const reach = (from: string, next: Map<string, string[]>) => {
    const seen = new Set<string>();
    const stack = [...(next.get(from) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return seen;
  };
  const type = new Map(graph.nodes.map((n) => [n.id, n.type]));
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.label || id;
  const loops: Loop[] = [];
  for (const f of graph.nodes.filter((n) => n.type === 'foreach')) {
    const after = reach(f.id, children);
    const collects = [...after].filter((id) => type.get(id) === 'collect');
    // The nearest Collect: the one no other Collect after this For each comes before.
    const first = collects.filter((c) => !collects.some((o) => o !== c && reach(o, children).has(c)));
    if (first.length !== 1) throw new Error(`"${name(f.id)}" needs exactly one Collect block after it, where the items come together`);
    const collect = first[0];
    const before = reach(collect, parents);
    const body = new Set([...after].filter((id) => before.has(id)));
    const earlier = reach(f.id, parents);
    for (const id of body) {
      if (type.get(id) === 'foreach' || type.get(id) === 'collect') throw new Error(`"${name(f.id)}": loops can't be inside loops`);
      for (const c of children.get(id)!) if (c !== collect && !body.has(c)) throw new Error(`"${name(id)}" is inside "${name(f.id)}" and may only feed blocks inside it or its Collect`);
      for (const p of parents.get(id)!) if (p !== f.id && !body.has(p) && !earlier.has(p)) throw new Error(`"${name(id)}" is inside "${name(f.id)}" and may only use blocks inside it or before it`);
    }
    for (const c of children.get(f.id)!) if (c !== collect && !body.has(c)) throw new Error(`Everything after "${name(f.id)}" must lead to its Collect block`);
    for (const p of parents.get(collect)!) if (p !== f.id && !body.has(p)) throw new Error(`"${name(collect)}" may only collect from blocks inside "${name(f.id)}"`);
    loops.push({ foreach: f.id, collect, body });
  }
  for (const c of graph.nodes.filter((n) => n.type === 'collect')) {
    if (!loops.some((l) => l.collect === c.id)) throw new Error(`"${name(c.id)}" needs a For each block before it`);
  }
  return loops;
}
