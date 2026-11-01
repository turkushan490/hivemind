import type { RunLimits } from '@hivemind/shared';
import { getSetting, setSetting } from '../db/index.js';
import { DEFAULT_LIMITS } from '../engine/run.js';

export { DEFAULT_LIMITS };

/**
 * Settings → Run limits: how long one model call may take, and the answer length and context size local models
 * get when a block sets none. A looping local model can't hold the GPU for long.
 */

const KEY = 'run.limits';

const RANGES: Record<keyof RunLimits, [number, number, string]> = {
  maxSeconds: [10, 86400, 'The time limit must be 10 to 86400 seconds'],
  maxTokens: [16, 32768, 'The token limit must be 16 to 32768'],
  numCtx: [2048, 131072, 'The context size must be 2048 to 131072 tokens'],
};

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function runLimits(): RunLimits {
  try {
    const s = JSON.parse(getSetting(KEY) ?? '{}') as Partial<Record<keyof RunLimits, unknown>>;
    return {
      maxSeconds: positive(s.maxSeconds) ? s.maxSeconds : DEFAULT_LIMITS.maxSeconds,
      maxTokens: positive(s.maxTokens) ? Math.round(s.maxTokens) : DEFAULT_LIMITS.maxTokens,
      numCtx: positive(s.numCtx) ? Math.round(s.numCtx) : DEFAULT_LIMITS.numCtx,
    };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

/** PUT /api/settings/run-limits: only the fields sent change. */
export function saveRunLimits(body: Partial<Record<keyof RunLimits, unknown>>): RunLimits {
  const next = runLimits();
  for (const k of Object.keys(RANGES) as (keyof RunLimits)[]) {
    const v = body[k];
    if (v === undefined) continue;
    const [min, max, message] = RANGES[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw Object.assign(new Error(message), { statusCode: 400 });
    next[k] = Math.round(v);
  }
  setSetting(KEY, JSON.stringify(next));
  return next;
}
