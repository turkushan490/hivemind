import type { DecideQuestion, DecisionView } from '@hivemind/shared';
import type { DecisionAnswer, DecisionQuestionSpec, DecisionResult } from '../providers/decisions.js';
import { answers, fill, labelled, type NodeContext, type NodeDefinition } from './index.js';

/**
 * Decide block: a decision model (Jev, OpenAI Decisions, Nimble…) answers typed questions about the text wired in.
 * The answers go on as JSON; blocks wired after it whose name is an answer ("yes", "no", a choice option,
 * "spam: yes", "fallback") only run when that answer won. The rule from the Jev guide: the model makes the
 * judgment call, this code decides what to do when it is unsure (threshold).
 */

export const DEFAULT_THRESHOLD = 0.6;

/** A question name as the APIs accept it (letters, digits, _ . -). */
export const questionKey = (name: string) => name.trim().replace(/[^\w.-]+/g, '_').slice(0, 100) || 'q';

export function questionSpec(q: DecideQuestion): DecisionQuestionSpec {
  if (q.type === 'choice') return { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries((q.options ?? []).filter((o) => o.name.trim()).map((o) => [o.name.trim(), o.description?.trim() || o.name.trim()])) };
  if (q.type === 'score') return { type: 'score', instructions: q.instructions, criteria: (q.levels ?? []).map((l) => l.trim()).filter(Boolean) };
  return { type: q.type, instructions: q.instructions };
}

/** The answer as the block's bars show it. */
export function toView(name: string, a: DecisionAnswer, spec?: DecisionQuestionSpec): DecisionView {
  switch (a.type) {
    case 'noul':
      return { name, type: 'noul', p: a.p };
    case 'choice':
      return { name, type: 'choice', pick: a.choice, probabilities: a.probabilities, confidence: a.confidence };
    case 'score': {
      const levels = Array.isArray(spec?.criteria) ? spec.criteria : undefined;
      const best = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0];
      return { name, type: 'score', score: a.score, levels, probabilities: a.probabilities, pick: best !== undefined ? (levels?.[Number(best)] ?? best) : undefined, confidence: a.confidence };
    }
    case 'box':
      return { name, type: 'box', box: a.box, confidence: a.confidence };
    default:
      return { name, type: 'refusal' };
  }
}

/** "spam 96% · wants: promote (100%) · positive 1.58/2" */
export function summaryLine(views: DecisionView[]): string {
  return views
    .map((v) => {
      if (v.type === 'noul') return `${v.name} ${Math.round((v.p ?? 0) * 100)}%`;
      if (v.type === 'choice') return `${v.name}: ${v.pick} (${Math.round((v.probabilities?.[v.pick ?? ''] ?? 0) * 100)}%)`;
      if (v.type === 'score') return `${v.name} ${(v.score ?? 0).toFixed(2)}/${Math.max(1, (v.levels?.length ?? 2) - 1)}`;
      if (v.type === 'box') return `${v.name}: found`;
      return `${v.name}: refused`;
    })
    .join(' · ');
}

const YES = new Set(['yes', 'true', 'ja']);
const NO = new Set(['no', 'false', 'nee']);
const norm = (s: string) => s.trim().toLowerCase();

/** What each question decided: "yes"/"no", the option, or "fallback" (choice under the threshold with a fallback branch). */
export function picks(questions: DecideQuestion[], result: DecisionResult, threshold: number, hasFallback: (q: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const a = result.answers[questionKey(q.name)];
    if (!a) continue;
    if (a.type === 'noul') out[q.name] = a.p >= threshold ? 'yes' : 'no';
    if (a.type === 'choice') {
      const top = a.probabilities[a.choice] ?? 0;
      const safe = q.safe && (q.options ?? []).some((o) => o.name === q.safe) ? q.safe : undefined;
      out[q.name] = top >= threshold ? a.choice : hasFallback(q.name) ? 'fallback' : (safe ?? a.choice);
    }
  }
  return out;
}

/**
 * Which outgoing blocks run. A block named after an answer of the branching question ("yes", "promote",
 * "fallback", or "wants: promote" for another question) runs only when that answer won; others always run.
 */
export function branches(questions: DecideQuestion[], outgoing: { id: string; label: string }[], decide: (hasFallback: (q: string) => boolean) => Record<string, string>) {
  const branchy = questions.filter((q) => q.type === 'noul' || q.type === 'choice');
  const main = branchy[0];
  const valuesOf = (q: DecideQuestion) => new Set(q.type === 'noul' ? [...YES, ...NO, 'fallback'] : [...(q.options ?? []).map((o) => norm(o.name)), 'fallback']);
  const target = outgoing.map((o) => {
    const m = o.label.match(/^\s*([^:=]+?)\s*[:=]\s*(.+)$/);
    const q = m ? branchy.find((x) => norm(x.name) === norm(m[1])) : undefined;
    const question = q ?? main;
    const value = norm(q ? m![2] : o.label);
    return { id: o.id, question, value: question && valuesOf(question).has(value) ? value : undefined };
  });
  const picked = decide((name) => target.some((t) => t.question?.name === name && t.value === 'fallback'));
  const runs = target
    .filter((t) => {
      if (!t.question || t.value === undefined) return true;
      const p = norm(picked[t.question.name] ?? '');
      if (t.question.type === 'noul') return YES.has(t.value) ? p === 'yes' : NO.has(t.value) ? p === 'no' : p === t.value;
      return p === t.value;
    })
    .map((t) => t.id);
  return { runs, picked, route: main ? picked[main.name] : undefined, branched: target.some((t) => t.value !== undefined) };
}

/** Pictures in the text wired in: ![image](hm-file:outputs/x.png) */
const imageLinks = (text: string) => [...text.matchAll(/hm-file:([^)\s]+\.(?:png|jpe?g|webp))/gi)].map((m) => m[1]);

export const DECIDE_NODE: NodeDefinition = {
  usesModel: true,
  async execute(ctx: NodeContext) {
    const c = ctx.node.config;
    const questions = (c.questions ?? []).filter((q) => q.name?.trim() && q.instructions?.trim());
    if (!questions.length) throw new Error('Add at least one question to this Decide block');
    for (const q of questions) {
      if (q.type === 'choice' && (q.options ?? []).filter((o) => o.name.trim()).length < 2) throw new Error(`"${q.name}" needs at least 2 options`);
      if (q.type === 'score' && (q.levels ?? []).filter((l) => l.trim()).length < 2) throw new Error(`"${q.name}" needs at least 2 levels`);
    }
    const prev = answers(ctx.inputs);
    const wired = prev.map((p) => p.text).join('\n\n');
    let state = (c.state ? fill(c.state, ctx, labelled(prev)) : wired || ctx.question).trim();
    // Box questions judge the picture the block before made (or found).
    const image = questions.some((q) => q.type === 'box') ? imageLinks(wired)[0] : undefined;
    let images: { data: Buffer; ext: string }[] | undefined;
    if (image) {
      if (!ctx.services.readFile) throw new Error('Reading images is not available here');
      images = [{ data: ctx.services.readFile(image), ext: image.split('.').pop()! }];
      state = state.replace(/!\[[^\]]*\]\(hm-file:[^)]+\)/g, '').trim() || 'An image.';
    }
    if (!state) throw new Error('Nothing to decide on: the state is empty');
    const threshold = c.threshold ?? DEFAULT_THRESHOLD;
    const specs = Object.fromEntries(questions.map((q) => [questionKey(q.name), questionSpec(q)]));
    ctx.progress('Deciding…');
    const result = await ctx.decide({ state: state.slice(0, 200_000), questions: specs, ...(images && { images }) });
    const views = questions.map((q) => toView(q.name, result.answers[questionKey(q.name)] ?? { type: 'refusal' }, specs[questionKey(q.name)]));
    const { runs, picked, route, branched } = branches(questions, ctx.outgoing, (hasFallback) => picks(questions, result, threshold, hasFallback));
    if (branched) ctx.choose(runs);
    const summary = summaryLine(views);
    ctx.progress(route ? `${summary} → ${route}` : summary, { model: result.model, ms: result.ms, answers: views, threshold, ...(route && { route }), ...(image && { image }) });
    const out: Record<string, unknown> = {};
    for (const v of views) {
      const { name, ...rest } = v;
      out[name] = { ...rest, ...(picked[name] && { decision: picked[name] }) };
    }
    return JSON.stringify({ answers: out, ...(route && { decision: route }), summary, model: result.model, ms: result.ms });
  },
};
