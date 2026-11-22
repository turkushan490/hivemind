import type { ProviderMemory } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { describe, logError } from '../errors.js';
import { cancelRun, isFullAdmin, liveRunsUsing, runEnded, sameModel } from '../events/runs.js';
import { requireUser } from './auth.js';
import { adapterFor, canEdit, originOf, rowFor, usableRows, visibleRows, type ProviderRow } from './providers.js';
import { allowedFor } from '../services/access.js';
import { warmInfo } from '../services/keepWarm.js';

/** H36.3: providers that point at the same server, together (three Ollama providers are one Ollama). */
function byServer(rows: ProviderRow[], user: Parameters<typeof canEdit>[0]): ProviderRow[][] {
  const groups = new Map<string, ProviderRow[]>();
  for (const r of rows) {
    const k = `${r.kind === 'decision' ? 'ollama' : r.kind}|${originOf(r.base_url)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  // One this user may unload leads, then the plain (GPU) one: its name and id stand for the server.
  const rank = (r: ProviderRow) => (canEdit(user, r) ? 0 : 2) + (r.cpu_only ? 1 : 0);
  return [...groups.values()].map((g) => [...g].sort((a, b) => rank(a) - rank(b)));
}

/** How long Unload waits for stopped runs to end, and for Ollama to really let the model go (tests make it short). */
export const unloadTiming = { runWaitMs: 5_000, goneWaitMs: 10_000, pollMs: 500 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function memoryRoutes(app: FastifyInstance) {
  /** What every local provider (Ollama) holds in RAM/VRAM right now, and the live runs using each model. */
  app.get('/api/memory', { preHandler: requireUser }, async (req): Promise<ProviderMemory[]> => {
    const user = req.user!;
    // Only providers and models this user may use (Settings → Access): the names of the others stay hidden.
    const access = allowedFor(user);
    const rows = usableRows(user, access).filter((r) => r.enabled && r.local && adapterFor(r).loaded);
    return Promise.all(
      byServer(rows, user).map(async (group) => {
        const r = group[0];
        const name = group.length > 1 ? `${r.name} (${originOf(r.base_url)})` : r.name;
        const base = { providerId: r.id, name, canUnload: canEdit(user, r), ...(group.length > 1 && { usedBy: group.map((g) => g.name) }) };
        try {
          const using = group.flatMap((g) => liveRunsUsing(g.id)).filter((x) => x.ownerId === user.id || isFullAdmin(user));
          const models = ((await adapterFor(r).loaded?.()) ?? []).filter((m) => group.some((g) => access.model(g.id, m.model))).map((m) => {
            const runs = using.filter((x) => x.models.some((n) => sameModel(n, m.model))).map((x) => ({ runId: x.runId, canvasName: x.canvasName, state: x.state }));
            const keptWarm = warmInfo(r.base_url, m.model);
            return { ...m, ...(runs.length && { runs }), ...(keptWarm && { keptWarm }) };
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
    const local = visibleRows(user).filter((r) => r.enabled && r.local);
    const picked = body.providerId ? [rowFor(user, body.providerId)].filter((r) => !!r) : local;
    if (picked.length === 0) return reply.code(404).send({ error: 'Provider not found' });
    // One call per server (H36.3); the runs of every provider pointing at it are stopped.
    const groups = byServer(local, user).filter((g) => g.some((r) => picked.some((p) => p.id === r.id)));
    if (body.providerId && !groups.length) groups.push(picked);
    const rows = groups.map((g) => g[0]);
    const groupOf = (r: ProviderRow) => groups.find((g) => g[0].id === r.id) ?? [r];
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
        for (const run of groupOf(r).flatMap((g) => liveRunsUsing(g.id, body.model))) {
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
