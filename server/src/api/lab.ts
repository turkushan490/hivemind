import type { FastifyInstance } from 'fastify';
import { db, setSetting } from '../db/index.js';
import { logError } from '../errors.js';
import { hfHardware, hfSettings, saveHfSettings } from '../lab/hf.js';
import {
  cancelTrain,
  cloudEstimate,
  deleteTrain,
  getTrain,
  installTrainerScripts,
  overview,
  pauseTrain,
  publishTrain,
  resumeTrain,
  resumeTrains,
  startBuiltinTrainer,
  startTrain,
  trainFollower,
  type TrainDeps,
} from '../lab/train.js';
import { saveWindow, trainingWindow } from '../lab/window.js';
import { requireAdmin, requireUser, type User } from './auth.js';
import { deleteLocalModel } from './library.js';
import { trainDepsFor } from './providers.js';

/**
 * The Training Lab: make new models from datasets (local GPU, Hugging Face Jobs, ComfyUI LoRAs), follow them live,
 * and the training window for nightly jobs. Simulating and scoring D&D games is DungeonMind's job, not HiveMind's.
 */
export function labRoutes(app: FastifyInstance) {
  // ---- New model (fine-tune on a dataset; everyone but viewers, each controls their own jobs) ----
  const trainDeps = (user: User): TrainDeps => trainDepsFor(user);
  try {
    installTrainerScripts();
    startBuiltinTrainer();
    resumeTrains((ownerId) => trainDeps((db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(ownerId) as unknown as User) ?? { id: ownerId, username: '?', role: 'admin' }));
  } catch (err) {
    logError({ source: 'server', message: `Lab: trainer setup failed: ${(err as Error).message}` });
  }

  // A limited token sees only the jobs it started.
  app.get('/api/lab/train', { preHandler: requireUser }, async (req) => overview(req.user!.id, req.user!.scope ? (req.user!.tokenId ?? '-') : undefined));

  app.get('/api/lab/train/:id', { preHandler: requireUser }, async (req, reply) => getTrain((req.params as { id: string }).id, req.user!.id) ?? reply.code(404).send({ error: 'Job not found' }));

  /** The training window: nightly jobs (and jobs started by a scheduled run) only train while it is open. */
  app.get('/api/lab/window', { preHandler: requireUser }, async () => trainingWindow());

  app.put('/api/settings/training', { preHandler: requireAdmin }, async (req) => saveWindow((req.body ?? {}) as { start?: unknown; end?: unknown }));

  app.put('/api/lab/train/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const url = String((req.body as { url?: string } | undefined)?.url ?? '').trim();
    if (url && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) return reply.code(400).send({ error: 'The trainer address looks like http://192.168.1.10:8765' });
    setSetting('lab.trainerUrl', url);
    return overview(req.user!.id);
  });

  app.post('/api/lab/train', { preHandler: requireUser }, async (req) => {
    const body = (req.body ?? {}) as {
      base?: string;
      name?: string;
      providerId?: string;
      datasetId?: string;
      epochs?: number;
      maxSeqLength?: number;
      maxSteps?: number;
      allowSmall?: boolean;
      flavor?: string;
      confirmUsd?: number;
      nightly?: boolean;
    };
    return startTrain(
      req.user!.id,
      {
        base: String(body.base ?? ''),
        name: String(body.name ?? '').trim().toLowerCase(),
        providerId: String(body.providerId ?? ''),
        datasetId: body.datasetId,
        epochs: body.epochs,
        maxSeqLength: body.maxSeqLength,
        maxSteps: body.maxSteps,
        allowSmall: body.allowSmall,
        ...(body.flavor && { flavor: String(body.flavor), confirmUsd: body.confirmUsd === undefined ? undefined : Number(body.confirmUsd) }),
        nightly: body.nightly === true,
        tokenId: req.user!.tokenId,
      },
      trainDeps(req.user!),
    );
  });

  // ---- Hugging Face: cloud training (HF Jobs) and publishing ----
  app.get('/api/hf', { preHandler: requireUser }, async () => {
    const s = hfSettings();
    if (!s.hasToken) return { settings: s, hardware: [] };
    try {
      return { settings: s, hardware: await hfHardware() };
    } catch (err) {
      return { settings: s, hardware: [], error: (err as Error).message };
    }
  });

  app.put('/api/settings/huggingface', { preHandler: requireAdmin }, async (req) => saveHfSettings((req.body ?? {}) as { token?: string; dailyBudgetUsd?: number }));

  app.post('/api/lab/train/estimate', { preHandler: requireUser }, async (req) => {
    const b = (req.body ?? {}) as { flavor?: string; base?: string; datasetId?: string; epochs?: number; maxSteps?: number };
    return cloudEstimate(req.user!.id, { flavor: b.flavor, base: String(b.base ?? ''), datasetId: b.datasetId, epochs: b.epochs, maxSteps: b.maxSteps });
  });

  app.post('/api/lab/train/:id/publish', { preHandler: requireUser }, async (req) => {
    const b = (req.body ?? {}) as { repo?: string; private?: boolean };
    return publishTrain((req.params as { id: string }).id, req.user!.id, { repo: b.repo, private: b.private !== false });
  });

  // Everyone except viewers may train (the viewer guard blocks their writes); each controls their own jobs.
  app.post('/api/lab/train/:id/cancel', { preHandler: requireUser }, async (req, reply) =>
    cancelTrain((req.params as { id: string }).id, req.user!.id) ? { ok: true } : reply.code(404).send({ error: 'That job is not running' }),
  );

  app.post('/api/lab/train/:id/pause', { preHandler: requireUser }, async (req, reply) =>
    pauseTrain((req.params as { id: string }).id, req.user!.id) ? { ok: true } : reply.code(404).send({ error: 'That job is not running here (cloud jobs can only be cancelled)' }),
  );

  app.post('/api/lab/train/:id/resume', { preHandler: requireUser }, async (req, reply) =>
    resumeTrain((req.params as { id: string }).id, req.user!.id, trainDeps(req.user!)) ? { ok: true } : reply.code(409).send({ error: 'Only a paused job can be resumed' }),
  );

  /** Removes a finished, failed, cancelled or paused job (and its files); ?model=1 also deletes the model it made from its Ollama. */
  app.delete('/api/lab/train/:id', { preHandler: requireUser }, async (req) => {
    const q = req.query as { model?: string };
    return deleteTrain((req.params as { id: string }).id, req.user!.id, {
      deleteModel: q.model === '1' || q.model === 'true',
      removeModel: (providerId, model) => deleteLocalModel(req.user!, providerId, model),
    });
  });

  /** Server-Sent Events: state, progress, loss per step, log lines and the sample answer, live; ends with "end". */
  app.get('/api/lab/train/:id/events', { preHandler: requireUser }, (req, reply) => {
    const follow = trainFollower((req.params as { id: string }).id, req.user!.id);
    const first = follow();
    if (!first) return reply.code(404).send({ error: 'Job not found' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let closed = false;
    const send = (events: ReturnType<typeof follow>) => {
      for (const ev of events ?? [{ event: 'end' as const, data: { state: 'cancelled' as const } }]) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        if (ev.event === 'end') return stop();
      }
    };
    const timer = setInterval(() => send(follow()), Math.min(1000, Number(process.env.TRAIN_POLL_MS) || 1000));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    function stop() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearInterval(ping);
      res.end();
    }
    req.raw.on('close', stop);
    send(first);
  });
}
