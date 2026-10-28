import { db } from '../db/index.js';
import { DM_SCHEMA, DM_SYSTEM } from './sim.js';
import { ERROR_TYPES, type ErrorType } from './judge.js';

/** Datasets and the scoreboard of the Lab, from lab_turns. */

interface TurnRow {
  id: number;
  run_id: string;
  model: string;
  prompt_version: string;
  input: string;
  output: string;
  json_valid: number;
  error_types: string;
  story_score: number | null;
  jev_story: number | null;
  tokens_per_s: number | null;
  ms: number | null;
  corrected: string | null;
  review: string | null;
}

/** The system prompt the DM saw (JSON mode adds the shape to it). */
export const SFT_SYSTEM = `${DM_SYSTEM}\n\nReply with only valid JSON, no other text.\nThe JSON must have this shape:\n${DM_SCHEMA}`;

/**
 * JSONL in chat format for fine-tuning: good turns as they were, bad turns only once their correction was
 * accepted (then the corrected answer is the one to learn).
 */
export function exportJsonl(ownerId: string, runId?: string): string {
  const rows = db
    .prepare(
      `SELECT t.* FROM lab_turns t JOIN lab_runs r ON r.id = t.run_id WHERE r.owner_id = ? ${runId ? 'AND t.run_id = ?' : ''}
       AND ((t.review = 'accepted' AND t.corrected IS NOT NULL) OR (t.review IS NULL AND t.json_valid = 1 AND t.error_types = '[]')) ORDER BY t.id`,
    )
    .all(...(runId ? [ownerId, runId] : [ownerId])) as unknown as TurnRow[];
  return rows
    .map((r) =>
      JSON.stringify({
        messages: [
          { role: 'system', content: SFT_SYSTEM },
          { role: 'user', content: r.input },
          { role: 'assistant', content: r.review === 'accepted' && r.corrected ? r.corrected : r.output },
        ],
      }),
    )
    .join('\n');
}

export interface ScoreRow {
  model: string;
  promptVersion: string;
  turns: number;
  jsonValidPct: number;
  /** Rule and number errors (roll, number, contradiction) per 100 turns. */
  rulesPer100: number;
  /** Missed or overspent resources per 100 turns. */
  resourcesPer100: number;
  story?: number;
  jevStory?: number;
  tokensPerSec?: number;
  msPerTurn?: number;
  vramBytes?: number;
  errors: Record<ErrorType, number>;
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : undefined;
};

export function scoreboard(ownerId: string, runId?: string): ScoreRow[] {
  const rows = db
    .prepare(
      `SELECT t.model, t.prompt_version, t.json_valid, t.error_types, t.story_score, t.jev_story, t.tokens_per_s, t.ms FROM lab_turns t
       JOIN lab_runs r ON r.id = t.run_id WHERE r.owner_id = ? ${runId ? 'AND t.run_id = ?' : ''} ORDER BY t.id DESC LIMIT 100000`,
    )
    .all(...(runId ? [ownerId, runId] : [ownerId])) as unknown as TurnRow[];
  const groups = new Map<string, TurnRow[]>();
  for (const r of rows) groups.set(`${r.model}\n${r.prompt_version}`, [...(groups.get(`${r.model}\n${r.prompt_version}`) ?? []), r]);
  return [...groups.entries()]
    .map(([k, list]) => {
      const [model, promptVersion] = k.split('\n');
      const errors = Object.fromEntries(ERROR_TYPES.map((t) => [t, 0])) as Record<ErrorType, number>;
      for (const r of list) for (const t of JSON.parse(r.error_types) as ErrorType[]) if (t in errors) errors[t]++;
      const per100 = (n: number) => Math.round((n / list.length) * 1000) / 10;
      return {
        model,
        promptVersion,
        turns: list.length,
        jsonValidPct: per100(list.filter((r) => r.json_valid).length),
        rulesPer100: per100(errors.roll + errors.number + errors.contradiction),
        resourcesPer100: per100(errors.resource),
        story: avg(list.map((r) => r.story_score)),
        jevStory: avg(list.map((r) => r.jev_story)),
        tokensPerSec: avg(list.map((r) => r.tokens_per_s)),
        msPerTurn: avg(list.map((r) => r.ms)),
        errors,
      };
    })
    .sort((a, b) => a.rulesPer100 + a.resourcesPer100 - (b.rulesPer100 + b.resourcesPer100) || b.jsonValidPct - a.jsonValidPct);
}
