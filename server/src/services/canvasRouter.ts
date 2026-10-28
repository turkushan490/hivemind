import type { DecisionEvent, ModelRef } from '@hivemind/shared';
import type { ResolvedProvider } from '../engine/run.js';
import { toView } from '../nodes/decide.js';

/**
 * Canvas router (optional, Settings → Voice): one Jev choice "which canvas does this request belong to?",
 * so one voice agent (Use mode, Home Assistant through /v1 model "auto") reaches the right canvas.
 */
export async function routeCanvas(
  text: string,
  canvases: { id: string; name: string; description?: string | null }[],
  decider: ModelRef,
  resolve: (providerId: string) => Promise<ResolvedProvider>,
): Promise<{ canvasId: string; name: string; decision: DecisionEvent }> {
  if (!canvases.length) throw new Error('There are no canvases to route to');
  const p = await resolve(decider.providerId);
  if (!p.adapter.decide) throw new Error(`${decider.model} is not a decision model (Settings → Voice → Canvas router)`);
  if (canvases.length === 1) return { canvasId: canvases[0].id, name: canvases[0].name, decision: { model: decider.model, ms: 0, answers: [] } };
  const pick = canvases.slice(0, 255);
  const spec = {
    type: 'choice' as const,
    instructions: 'Which of these apps should handle this request?',
    criteria: Object.fromEntries(pick.map((c) => [c.id, c.description ? `${c.name}: ${c.description}` : c.name])),
  };
  const r = await p.adapter.decide({ model: decider.model, state: text, questions: { canvas: spec } });
  const a = r.answers.canvas;
  const chosen = pick.find((c) => a?.type === 'choice' && c.id === a.choice) ?? pick[0];
  return { canvasId: chosen.id, name: chosen.name, decision: { model: r.model, ms: r.ms, answers: [toView('canvas', a ?? { type: 'refusal' }, spec)], route: chosen.name } };
}
