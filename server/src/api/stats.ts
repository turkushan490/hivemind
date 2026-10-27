import type { StatsReport } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { requireUser } from './auth.js';

type Row = Record<string, any>;

/** Cost, tokens and speed per day / provider / model, and the Judge/Vote leaderboard. */
export function statsReport(ownerId: string | undefined, days: number): StatsReport {
  const since = `-${days} days`;
  const who = ownerId ? 'AND owner_id = ?' : '';
  const args = ownerId ? [since, ownerId] : [since];
  const q = (sql: string) => db.prepare(sql).all(...args) as Row[];

  const [t] = q(
    `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
            COUNT(DISTINCT run_id) AS runs, COUNT(*) AS calls, COALESCE(SUM(cost IS NULL), 0) AS unpriced
     FROM run_usage WHERE at >= datetime('now', ?) ${who}`,
  );
  const byDay = q(
    `SELECT date(at) AS day, COALESCE(SUM(cost), 0) AS cost, SUM(input_tokens + output_tokens) AS tokens, COUNT(DISTINCT run_id) AS runs
     FROM run_usage WHERE at >= datetime('now', ?) ${who} GROUP BY date(at) ORDER BY day`,
  );
  const byProvider = q(
    `SELECT u.provider_id AS providerId, COALESCE(p.name, u.provider_id) AS name, COALESCE(SUM(u.cost), 0) AS cost,
            SUM(u.input_tokens) AS inputTokens, SUM(u.output_tokens) AS outputTokens, COUNT(*) AS calls
     FROM run_usage u LEFT JOIN providers p ON p.id = u.provider_id
     WHERE u.at >= datetime('now', ?) ${who.replace('owner_id', 'u.owner_id')} GROUP BY u.provider_id ORDER BY cost DESC, calls DESC`,
  );
  // Speed from the provider's own generation time; models that don't report it fall back to the remembered speed.
  const byModel = q(
    `SELECT u.provider_id AS providerId, u.model, COALESCE(SUM(u.cost), 0) AS cost, SUM(u.cost IS NULL) AS unpriced,
            SUM(u.input_tokens) AS inputTokens, SUM(u.output_tokens) AS outputTokens, COUNT(*) AS calls,
            SUM(CASE WHEN u.gen_ms > 0 THEN u.output_tokens END) * 1000.0 / SUM(CASE WHEN u.gen_ms > 0 THEN u.gen_ms END) AS tps,
            s.tokens_per_sec AS rememberedTps
     FROM run_usage u LEFT JOIN model_stats s ON s.provider_id = u.provider_id AND s.model = u.model
     WHERE u.at >= datetime('now', ?) ${who.replace('owner_id', 'u.owner_id')} GROUP BY u.provider_id, u.model ORDER BY cost DESC, calls DESC`,
  );

  const wins = q(
    `SELECT COALESCE(winner_model, winner_label) AS model, COUNT(*) AS wins FROM run_winners
     WHERE at >= datetime('now', ?) ${who} GROUP BY COALESCE(winner_model, winner_label)`,
  );
  const contests = q(
    `SELECT j.value AS model, COUNT(*) AS contests FROM run_winners w, json_each(w.contenders) j
     WHERE w.at >= datetime('now', ?) ${who.replace('owner_id', 'w.owner_id')} GROUP BY j.value`,
  );
  const winMap = new Map(wins.map((w) => [w.model as string, w.wins as number]));
  const leaderboard = contests
    .map((c) => ({ model: c.model as string, wins: winMap.get(c.model) ?? 0, contests: c.contests as number }))
    .map((r) => ({ ...r, winRate: r.contests ? r.wins / r.contests : 0 }))
    .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.contests - a.contests);

  return {
    days,
    totals: { cost: t.cost, inputTokens: t.input, outputTokens: t.output, runs: t.runs, calls: t.calls, unpricedCalls: t.unpriced },
    byDay: byDay.map((d) => ({ day: d.day, cost: d.cost, tokens: d.tokens, runs: d.runs })),
    byProvider: byProvider.map((p) => ({ providerId: p.providerId, name: p.name, cost: p.cost, inputTokens: p.inputTokens, outputTokens: p.outputTokens, calls: p.calls })),
    byModel: byModel.map((m) => ({
      providerId: m.providerId,
      model: m.model,
      cost: m.cost,
      priced: m.unpriced === 0,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      calls: m.calls,
      tokensPerSec: m.tps ?? m.rememberedTps ?? undefined,
    })),
    leaderboard,
  };
}

export function statsRoutes(app: FastifyInstance) {
  /** ?days=1..365 (default 30); admins may add ?scope=all for everyone's usage. */
  app.get('/api/stats', { preHandler: requireUser }, async (req) => {
    const { days, scope } = req.query as { days?: string; scope?: string };
    const n = Math.max(1, Math.min(365, Math.round(Number(days) || 30)));
    const all = scope === 'all' && req.user!.role === 'admin';
    return statsReport(all ? undefined : req.user!.id, n);
  });
}
