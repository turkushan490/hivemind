import type { CanvasGraph, ModelRef } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { db, setSetting } from '../db/index.js';
import { logError } from '../errors.js';
import { exportJsonl, scoreboard } from '../lab/data.js';
import { migrateLabTurns, syncLabTurn } from '../lab/datasets.js';
import { setCanvasModel } from '../lab/services.js';
import { activeLab, recoverLab, startLab, type LabConfig } from '../lab/runner.js';
import { cancelTrain, installTrainerScripts, overview, pauseTrain, resumeTrain, resumeTrains, startBuiltinTrainer, startTrain, type TrainDeps } from '../lab/train.js';
import { memoryFor } from '../services/memory.js';
import { requireAdmin, requireUser, type User } from './auth.js';
import { adapterFor, gpuFreerFor, resolverFor, trainDepsFor, visibleRows } from './providers.js';

const isRef = (m: unknown): m is ModelRef => !!m && typeof (m as ModelRef).providerId === 'string' && typeof (m as ModelRef).model === 'string';

/** The Lab (D&D only): simulated games, datasets, review queue, JSONL export and the scoreboard. */
export function labRoutes(app: FastifyInstance) {
  recoverLab();
  try {
    migrateLabTurns();
  } catch (err) {
    logError({ source: 'server', message: `Lab: moving Lab turns into the DungeonMind DM dataset failed: ${(err as Error).message}` });
  }

  // ---- New model (fine-tune on the Lab dataset; admin only, it takes the GPU for hours) ----
  const trainDeps = (user: User): TrainDeps => trainDepsFor(user);
  try {
    installTrainerScripts();
    startBuiltinTrainer();
    resumeTrains((ownerId) => trainDeps((db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(ownerId) as unknown as User) ?? { id: ownerId, username: '?', role: 'admin' }));
  } catch (err) {
    logError({ source: 'server', message: `Lab: trainer setup failed: ${(err as Error).message}` });
  }

  app.get('/api/lab/train', { preHandler: requireUser }, async (req) => overview(req.user!.id));

  app.put('/api/lab/train/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const url = String((req.body as { url?: string } | undefined)?.url ?? '').trim();
    if (url && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) return reply.code(400).send({ error: 'The trainer address looks like http://192.168.1.10:8765' });
    setSetting('lab.trainerUrl', url);
    return overview(req.user!.id);
  });

  app.post('/api/lab/train', { preHandler: requireUser }, async (req) => {
    const body = (req.body ?? {}) as { base?: string; name?: string; providerId?: string; datasetId?: string; epochs?: number; maxSeqLength?: number; maxSteps?: number; allowSmall?: boolean };
    return startTrain(req.user!.id, { base: String(body.base ?? ''), name: String(body.name ?? '').trim().toLowerCase(), providerId: String(body.providerId ?? ''), datasetId: body.datasetId, epochs: body.epochs, maxSeqLength: body.maxSeqLength, maxSteps: body.maxSteps, allowSmall: body.allowSmall }, trainDeps(req.user!));
  });

  // Everyone except viewers may train (the viewer guard blocks their writes); each controls their own jobs.
  app.post('/api/lab/train/:id/cancel', { preHandler: requireUser }, async (req, reply) =>
    cancelTrain((req.params as { id: string }).id, req.user!.id) ? { ok: true } : reply.code(404).send({ error: 'That job is not running' }),
  );

  app.post('/api/lab/train/:id/pause', { preHandler: requireUser }, async (req, reply) =>
    pauseTrain((req.params as { id: string }).id, req.user!.id) ? { ok: true } : reply.code(404).send({ error: 'That job is not running' }),
  );

  app.post('/api/lab/train/:id/resume', { preHandler: requireUser }, async (req, reply) =>
    resumeTrain((req.params as { id: string }).id, req.user!.id, trainDeps(req.user!)) ? { ok: true } : reply.code(409).send({ error: 'Only a paused job can be resumed' }),
  );

  app.get('/api/lab', { preHandler: requireUser }, async (req) => {
    const a = activeLab();
    return {
      active: a && a.ownerId === req.user!.id ? a.status : null,
      runs: db
        .prepare(
          `SELECT r.id, r.name, r.status, r.error, r.started_at AS startedAt, r.stopped_at AS stoppedAt, r.config,
             (SELECT COUNT(*) FROM lab_turns t WHERE t.run_id = r.id) AS turns,
             (SELECT COUNT(*) FROM lab_turns t WHERE t.run_id = r.id AND t.review = 'pending') AS pending
           FROM lab_runs r WHERE r.owner_id = ? ORDER BY r.started_at DESC LIMIT 50`,
        )
        .all(req.user!.id)
        .map((r) => {
          const { config, ...rest } = r as Record<string, unknown>;
          return { ...rest, config: JSON.parse(String(config)) };
        }),
    };
  });

  app.post('/api/lab/start', { preHandler: requireUser }, async (req, reply) => {
    const cfg = (req.body ?? {}) as LabConfig;
    if (!Array.isArray(cfg.dm) || !cfg.dm.length || !cfg.dm.every(isRef)) return reply.code(400).send({ error: 'Pick at least one DM model' });
    if (!isRef(cfg.players)) return reply.code(400).send({ error: 'Pick a model for the fake players' });
    if (cfg.judge !== undefined && !isRef(cfg.judge)) return reply.code(400).send({ error: 'The judge must be a model' });
    if (cfg.jev !== undefined && !isRef(cfg.jev)) return reply.code(400).send({ error: 'The fast checker must be a decision model' });
    if (!cfg.judge && !cfg.jev) return reply.code(400).send({ error: 'Pick a rules-checker: a judge model, Jev, or both' });
    try {
      const run = startLab(req.user!.id, cfg, {
        resolve: resolverFor(req.user!),
        services: { memory: memoryFor(req.user!.id), freeGpu: gpuFreerFor(req.user!) },
        record: {
          usage: (u) =>
            db
              .prepare('INSERT INTO run_usage (run_id, owner_id, node_id, node_type, provider_id, model, input_tokens, output_tokens, cost, gen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(`lab:${run.id}`, req.user!.id, u.nodeId, u.nodeType, u.providerId, u.model, u.inputTokens, u.outputTokens, u.cost ?? null, u.genMs ?? null),
          winner: () => {},
        },
      });
      return run.status;
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post('/api/lab/stop', { preHandler: requireUser }, async (req, reply) => {
    const a = activeLab();
    if (!a || !a.status.running || a.ownerId !== req.user!.id) return reply.code(404).send({ error: 'No simulation is running' });
    a.stop();
    await a.done;
    return a.status;
  });

  /** Turns of a run, or the review queue (pending=1): the bad turns waiting for accept / edit / reject. */
  app.get('/api/lab/turns', { preHandler: requireUser }, async (req) => {
    const q = req.query as { runId?: string; pending?: string; limit?: string };
    const where = ['r.owner_id = ?'];
    const args: (string | number)[] = [req.user!.id];
    if (q.runId) where.push('t.run_id = ?') && args.push(q.runId);
    if (q.pending === '1') where.push("t.review = 'pending'");
    args.push(Math.max(1, Math.min(500, Number(q.limit) || 100)));
    return (
      db
        .prepare(`SELECT t.* FROM lab_turns t JOIN lab_runs r ON r.id = t.run_id WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ?`)
        .all(...args) as Record<string, any>[]
    ).map((t) => ({
      ...t,
      json_valid: !!t.json_valid,
      error_types: JSON.parse(t.error_types),
      verdict: t.verdict ? JSON.parse(t.verdict) : null,
      jev_verdict: t.jev_verdict ? JSON.parse(t.jev_verdict) : null,
    }));
  });

  /** Review: accept (with the correction, edited or not) or reject a turn. */
  app.patch('/api/lab/turns/:id', { preHandler: requireUser }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { review?: string; corrected?: string };
    const row = db.prepare('SELECT t.id, t.corrected FROM lab_turns t JOIN lab_runs r ON r.id = t.run_id WHERE t.id = ? AND r.owner_id = ?').get(id, req.user!.id) as
      | { id: number; corrected: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'Turn not found' });
    if (body.review !== 'accepted' && body.review !== 'rejected') return reply.code(400).send({ error: 'review must be "accepted" or "rejected"' });
    const corrected = body.corrected ?? row.corrected;
    if (body.review === 'accepted') {
      if (!corrected?.trim()) return reply.code(400).send({ error: 'Write the corrected turn before accepting it' });
      try {
        JSON.parse(corrected);
      } catch (err) {
        return reply.code(400).send({ error: `The corrected turn is not valid JSON: ${(err as Error).message}` });
      }
    }
    db.prepare('UPDATE lab_turns SET review = ?, corrected = ? WHERE id = ?').run(body.review, corrected ?? null, id);
    syncLabTurn(req.user!.id, id);
    return { ok: true };
  });

  app.get('/api/lab/export.jsonl', { preHandler: requireUser }, async (req, reply) => {
    const runId = (req.query as { runId?: string }).runId;
    reply.header('content-type', 'application/jsonl; charset=utf-8').header('content-disposition', `attachment; filename="dungeonmind-dm${runId ? `-${runId}` : ''}.jsonl"`);
    return exportJsonl(req.user!.id, runId);
  });

  /** Per model and prompt version; VRAM from what the local AI servers report right now. */
  app.get('/api/lab/scoreboard', { preHandler: requireUser }, async (req) => {
    const rows = scoreboard(req.user!.id, (req.query as { runId?: string }).runId);
    const loaded = new Map<string, number>();
    await Promise.allSettled(
      visibleRows(req.user!)
        .filter((r) => r.enabled && r.local)
        .map(async (r) => {
          for (const m of (await adapterFor(r).loaded?.()) ?? []) loaded.set(`${r.id}|${m.model}`, m.vramBytes);
        }),
    );
    return rows.map((r) => ({ ...r, ...(loaded.has(r.model) && { vramBytes: loaded.get(r.model) }) }));
  });

  /** "Set as DungeonMind default": the winning model goes into the AI model blocks of your dnd-* canvases. */
  app.post('/api/lab/default', { preHandler: requireUser }, async (req, reply) => {
    const model = (req.body as { model?: unknown } | undefined)?.model;
    if (!isRef(model)) return reply.code(400).send({ error: 'Send the model' });
    const { canvases, blocks } = setCanvasModel(req.user!.id, 'dnd-*', model);
    if (!canvases) {
      logError({ source: 'server', message: 'Lab: no dnd-* canvases to set the default model on (install them from DungeonMind first)', userId: req.user!.id });
      return reply.code(404).send({ error: 'No DungeonMind canvases (dnd-*) yet: DungeonMind installs them on its first start' });
    }
    return { canvases, blocks };
  });
}
