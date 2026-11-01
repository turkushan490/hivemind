import type { ProviderMemory } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { describe, logError } from '../errors.js';
import { cancelRun, isFullAdmin, liveRunsUsing, runEnded, sameModel } from '../events/runs.js';
import { requireUser } from './auth.js';
import { adapterFor, canEdit, rowFor, visibleRows } from './providers.js';

/** How long Unload waits for stopped runs to end, and for Ollama to really let the model go (tests make it short). */
export const unloadTiming = { runWaitMs: 5_000, goneWaitMs: 10_000, pollMs: 500 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function memoryRoutes(app: FastifyInstance) {
  /** What every local provider (Ollama) holds in RAM/VRAM right now, and the live runs using each model. */
  app.get('/api/memory', { preHandler: requireUser }, async (req): Promise<ProviderMemory[]> => {
    const user = req.user!;
    const rows = visibleRows(user).filter((r) => r.enabled && r.local);
    return Promise.all(
      rows.map(async (r) => {
        const base = { providerId: r.id, name: r.name, canUnload: canEdit(user, r) };
        try {
          const using = liveRunsUsing(r.id).filter((x) => x.ownerId === user.id || isFullAdmin(user));
          const models = ((await adapterFor(r).loaded?.()) ?? []).map((m) => {
            const runs = using.filter((x) => x.models.some((n) => sameModel(n, m.model))).map((x) => ({ runId: x.runId, canvasName: x.canvasName, state: x.state }));
            return runs.length ? { ...m, runs } : m;
          });
          return { ...base, models };
        } catch (err) {
          return { ...base, models: [], error: describe(err).message };
        }
      }),
    );
  });

  /**
   * Body: { providerId?, model? }. No providerId = every local provider; no model = everything loaded.
   * Live runs using (or waiting for) the model are stopped first: Ollama answers "ok" to an unload while a
   * request still uses the model, and keeps it. Afterwards the model must really be gone, else it is reported.
   */
  app.post('/api/memory/unload', { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;
    const body = (req.body ?? {}) as { providerId?: string; model?: string };
    const rows = body.providerId
      ? [rowFor(user, body.providerId)].filter((r) => !!r)
      : visibleRows(user).filter((r) => r.enabled && r.local);
    if (rows.length === 0) return reply.code(404).send({ error: 'Provider not found' });
    const unloaded: string[] = [];
    const failed: { model: string; error: string }[] = [];
    let stoppedRuns = 0;
    for (const r of rows) {
      if (!canEdit(user, r)) {
        failed.push({ model: r.name, error: 'Only an admin can unload shared providers' });
        continue;
      }
      const adapter = adapterFor(r);
      if (!adapter.loaded || !adapter.unload) continue;
      try {
        // 1. Stop the runs using or waiting for it (an admin anyone's, others only their own).
        const stopped: string[] = [];
        const kept: string[] = [];
        for (const run of liveRunsUsing(r.id, body.model)) {
          if (cancelRun(run.runId, user, 'Stopped by Unload')) {
            stopped.push(run.runId);
          } else {
            kept.push(...(body.model ? [body.model] : run.models));
            failed.push({ model: body.model ?? run.models.join(', '), error: `In use by a run of another user${run.canvasName ? ` (${run.canvasName})` : ''}` });
          }
        }
        stoppedRuns += stopped.length;
        // 2. Give them a moment to end and let go of the model.
        await Promise.all(stopped.map((id) => runEnded(id, unloadTiming.runWaitMs)));
        const models = (body.model ? [body.model] : (await adapter.loaded()).map((m) => m.model)).filter((m) => !kept.some((k) => sameModel(k, m)));
        for (const m of models) {
          try {
            // 3. keep_alive 0 …
            await adapter.unload(m);
            // 4. … and check it really is gone.
            let still = true;
            for (const until = Date.now() + unloadTiming.goneWaitMs; ; ) {
              still = (await adapter.loaded()).some((x) => sameModel(x.model, m));
              if (!still || Date.now() >= until) break;
              await sleep(unloadTiming.pollMs);
            }
            if (still) failed.push({ model: m, error: 'Still loaded: Ollama did not let it go' });
            else unloaded.push(m);
          } catch (err) {
            failed.push({ model: m, error: describe(err).message });
          }
        }
      } catch (err) {
        failed.push({ model: r.name, error: describe(err).message });
      }
    }
    for (const f of failed) logError({ source: 'provider', message: `Unload ${f.model} failed: ${f.error}`, userId: user.id });
    return { unloaded, failed, stoppedRuns };
  });
}
