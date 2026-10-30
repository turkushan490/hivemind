import type { CanvasGraph, NodeOutput, RunEvent } from '@hivemind/shared';

/**
 * Every block that finished, keyed by its label (or id), from the stored events: apps read the
 * "narration" and the "state" block of one run separately. A second block with the same label
 * gets "#2". Skipped and failed blocks are left out (their status is in the events). With inputs, blocks that
 * called a chat model also get the exact messages of their last call.
 */

/** Events as the API shows them: without the stored messages (those come only with ?inputs=1). */
export const publicEvents = (events: RunEvent[]): RunEvent[] => events.map((e) => (e.sent ? (({ sent: _sent, ...rest }) => rest)(e) : e));
export function nodeOutputs(events: RunEvent[], opts: { inputs?: boolean } = {}): Record<string, NodeOutput> {
  const graph = events.find((e) => e.type === 'run_start')?.graph as CanvasGraph | undefined;
  const nodes = new Map(graph?.nodes.map((n) => [n.id, n]) ?? []);
  const out: Record<string, NodeOutput> = {};
  for (const ev of events) {
    if (ev.type !== 'node_done' || !ev.nodeId || ev.text === undefined) continue;
    const n = nodes.get(ev.nodeId);
    const base = ev.label || n?.label || ev.nodeId;
    let label = base;
    for (let i = 2; label in out; i++) label = `${base}#${i}`;
    out[label] = { nodeId: ev.nodeId, type: ev.nodeType ?? n?.type ?? 'llm', text: ev.text, ...(opts.inputs && ev.sent && { providerId: ev.sent.providerId, model: ev.sent.model, messages: ev.sent.messages }) };
  }
  return out;
}
