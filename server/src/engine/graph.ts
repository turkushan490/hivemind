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
  return order;
}
