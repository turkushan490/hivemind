import type { DecisionQuestionSpec, DecisionResult } from '../providers/decisions.js';

/**
 * The rules-checker. A fast first pass with Jev yes/no questions per DM turn (~0.1 s, a fraction of a cent);
 * the full LLM judge only runs on turns Jev flags (p ≥ 0.5) and on a random 10% sample. Both verdicts are stored.
 */

export const ERROR_TYPES = ['json', 'roll', 'resource', 'number', 'contradiction'] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const ERROR_TEXT: Record<ErrorType, string> = {
  json: 'invalid JSON',
  roll: 'missing roll request',
  resource: 'spent resource not tracked',
  number: 'invented number',
  contradiction: 'contradicts the campaign or party',
};

/** Jev nouls, one per error type, plus a story score for the scoreboard. */
export const FAST_PASS: Record<string, DecisionQuestionSpec> = {
  roll: {
    type: 'noul',
    instructions: 'In `dm_turn`, does the DM decide the outcome of an attack, spell or risky action without asking for a roll and without using `dice_results`?',
  },
  resource: {
    type: 'noul',
    instructions:
      'In `dm_turn`, does a character use a limited resource (a spell slot, Channel Divinity, Action Surge, Bardic Inspiration, an item) that is missing from its "resources" list, or that `party` shows at 0?',
  },
  number: { type: 'noul', instructions: 'Does the narration in `dm_turn` state a number (damage, HP, a roll result) that is not in `dice_results` or `party`?' },
  contradiction: { type: 'noul', instructions: 'Does `dm_turn` contradict `party` or `recent`?' },
  story: { type: 'score', instructions: 'How good is the narration in `dm_turn` as dark-fantasy storytelling?', criteria: ['Flat or broken', 'Plain', 'Good', 'Vivid and gripping'] },
};

export const FLAG_AT = 0.5;

export interface FastVerdict {
  /** Probability per error type. */
  p: Partial<Record<ErrorType, number>>;
  flagged: ErrorType[];
  /** 1-10, from the Jev score. */
  story?: number;
  model: string;
  ms: number;
}

export function readFastPass(r: DecisionResult): FastVerdict {
  const p: FastVerdict['p'] = {};
  for (const t of ['roll', 'resource', 'number', 'contradiction'] as const) {
    const a = r.answers[t];
    if (a?.type === 'noul') p[t] = a.p;
  }
  const s = r.answers.story;
  return {
    p,
    flagged: (Object.keys(p) as ErrorType[]).filter((t) => (p[t] ?? 0) >= FLAG_AT),
    ...(s?.type === 'score' && { story: Math.round((1 + (s.score / 3) * 9) * 10) / 10 }),
    model: r.model,
    ms: r.ms,
  };
}

export const JUDGE_SYSTEM =
  'You are a strict D&D 5e rules referee checking one turn of an AI Dungeon Master. The server owns all numbers: the DM must ask for rolls before resolving uncertain actions, ' +
  'use only the given dice results, list every limited resource it lets a character spend, never let a character spend a resource the party state shows at 0, and never invent numbers. ' +
  'Reply with JSON only.';

export const JUDGE_SCHEMA =
  '{"errors":[{"type":"json|roll|resource|number|contradiction","detail":"what is wrong"}],"story":1-10,"corrected":{"narration":"","rolls":[],"resources":[],"hp":[],"conditions":[],"xp":0}} — "corrected" only when there are errors: the same turn done right.';

export interface Verdict {
  errors: { type: ErrorType; detail: string }[];
  /** 1-10 */
  story?: number;
  /** The turn done right (JSON text), when the judge wrote one. */
  corrected?: string;
}

const SYNONYMS: [RegExp, ErrorType][] = [
  [/json|format|parse/i, 'json'],
  [/roll|dice|check|save/i, 'roll'],
  [/resource|slot|counter|divinity|surge|track|spent|spend/i, 'resource'],
  [/number|invent|hp|damage|math/i, 'number'],
  [/contradict|campaign|contin|consisten/i, 'contradiction'],
];

const typeOf = (s: string): ErrorType | undefined => (ERROR_TYPES as readonly string[]).includes(s) ? (s as ErrorType) : SYNONYMS.find(([re]) => re.test(s))?.[1];

/** Reads the judge's answer, forgiving fences, chatter, strings instead of objects and loose type names. */
export function parseVerdict(text: string): Verdict {
  const t = text.trim();
  const body = t.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  let raw: any;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(`The judge's verdict is not JSON: ${t.slice(0, 120)}`);
  }
  const errors: Verdict['errors'] = [];
  for (const e of Array.isArray(raw?.errors) ? raw.errors : []) {
    const type = typeof e === 'string' ? typeOf(e) : typeOf(String(e?.type ?? '')) ?? typeOf(String(e?.detail ?? ''));
    if (!type) continue;
    errors.push({ type, detail: String(typeof e === 'string' ? e : (e.detail ?? e.type)).slice(0, 500) });
  }
  const story = Number(raw?.story ?? raw?.story_score ?? raw?.storyScore);
  const corrected = raw?.corrected && errors.length ? (typeof raw.corrected === 'string' ? raw.corrected : JSON.stringify(raw.corrected)) : undefined;
  return { errors, ...(Number.isFinite(story) && story > 0 && { story: Math.max(1, Math.min(10, story)) }), ...(corrected && { corrected }) };
}
