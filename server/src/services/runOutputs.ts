import type { CanvasGraph, NodeOutput, RunEvent } from '@hivemind/shared';

/**
 * Every block that finished, keyed by its label (or id), from the stored events: apps read the
 * "narration" and the "state" block of one run separately. A second block with the same label
 * gets "#2". Skipped and failed blocks are left out (their status is in the events).
 */
export function nodeOutputs(events: RunEvent[]): Record<string, NodeOutput> {
  const graph = events.find((e) => e.type === 'run_start')?.graph as CanvasGraph | undefined;
  const nodes = new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
  const out: Record<string, NodeOutput> = {};
  for (const ev of events) {
    if (ev.type !== 'node_done' || !ev.nodeId || ev.text === undefined) continue;
    const n = nodes.get(ev.nodeId);
    const base = ev.label || n?.label || ev.nodeId;
    let label = base;
    for (let i = 2; label in out; i++) label = `${base}#${i}`;
    out[label] = { nodeId: ev.nodeId, type: ev.nodeType ?? n?.type ?? 'llm', text: ev.text };
  }
  return out;
}
