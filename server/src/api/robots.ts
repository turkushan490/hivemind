import { createReadStream, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSetting, setSetting } from '../db/index.js';
import { githubToken } from '../services/git.js';
import {
  deleteInstallerVersion,
  FIRMWARE_APP,
  fetchGithubRelease,
  installerFilePath,
  latestFile,
  listInstallers,
  putInstallerFile,
  setGithubRepo,
} from '../services/installers.js';
import { changePin, createRobot, deleteRobot, heartbeat, listRobots, newRobotToken, robotById, robotConfig, robotEvent, updateRobot, type RobotRow } from '../services/robots.js';
import { getJob, jobsDone, jobView, listJobs, markSeen, moveJob, resumeCheckpoint } from '../services/robotJobs.js';
import { cancelRun, startRun } from '../events/runs.js';
import { gpuFreerFor, resolverFor, trainingFor } from './providers.js';
import { sourceOf } from './runs.js';
import { db } from '../db/index.js';
import type { User } from './auth.js';
import { requireAdmin, requireUser } from './auth.js';

async function safe(reply: FastifyReply, fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (!code) throw e;
    return reply.code(code).send({ error: (e as Error).message });
  }
}

/** The robot firmware app in Installers, and its files per board: "<board>-bootloader.bin" and so on. */
export { FIRMWARE_APP };
const PARTS = [
  { part: 'bootloader', offset: 0x0 },
  { part: 'partitions', offset: 0x8000 },
  { part: 'ota_data_initial', offset: 0xf000 },
  { part: 'firmware', offset: 0x20000 },
  // CoreS3 from firmware 0.9.1: the on-chip speech model (partition "model") for the offline commands.
  { part: 'srmodels', offset: 0x620000 },
];

/** The firmware a robot of this board should run: the target version, else the newest there is. */
function firmwareFor(board: string | null, target: string | null) {
  if (!board) return undefined;
  const app = listInstallers().find((a) => a.app === FIRMWARE_APP);
  const versions = app?.versions ?? [];
  const v = (target && versions.find((x) => x.version === target)) || versions.find((x) => x.files.some((f) => f.name === `${board}-firmware.bin`));
  const f = v?.files.find((x) => x.name === `${board}-firmware.bin`);
  if (!v || !f) return undefined;
  return { version: v.version, url: `/api/installers/${FIRMWARE_APP}/${encodeURIComponent(v.version)}/${encodeURIComponent(f.name)}`, ...(f.sha256 && { sha256: f.sha256 }) };
}

/** The robot a request comes from (its own token), or a 403. */
function robotOf(req: FastifyRequest, reply: FastifyReply): RobotRow | undefined {
  const id = req.user?.scope?.robot;
  const r = id ? robotById(id) : undefined;
  if (!r) {
    void reply.code(403).send({ error: 'Only a robot token may call this (Settings → Robots → Add robot)' });
    return undefined;
  }
  return r;
}

/** Settings → Robots (HiveBot devices), the robot API, and Installers. */
export function robotRoutes(app: FastifyInstance) {
  // ---- the owner ----
  app.get('/api/robots', { preHandler: requireAdmin }, async (req) => ({ robots: listRobots(req.user!.id), urls: robotUrls() }));
  app.post('/api/robots', { preHandler: requireAdmin }, async (req, reply) => safe(reply, () => createRobot(req.user!.id, (req.body ?? {}) as Record<string, unknown>)));
  app.patch('/api/robots/:id', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => updateRobot(req.user!.id, (req.params as { id: string }).id, (req.body ?? {}) as Record<string, unknown>)),
  );
  app.delete('/api/robots/:id', { preHandler: requireAdmin }, async (req, reply) => safe(reply, () => (deleteRobot(req.user!.id, (req.params as { id: string }).id), { ok: true })));
  /** A new token for a robot (the old one stops working); shown once. */
  app.post('/api/robots/:id/token', { preHandler: requireAdmin }, async (req, reply) => safe(reply, () => ({ token: newRobotToken(req.user!.id, (req.params as { id: string }).id) })));
  /** The addresses robots use: at home (LAN) and away (HTTPS). */
  app.put('/api/settings/robot-urls', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { home?: unknown; public?: unknown };
    const ok = (v: unknown) => v === undefined || v === '' || (typeof v === 'string' && /^https?:\/\/[^\s]+$/.test(v) && v.length < 200);
    if (!ok(b.home) || !ok(b.public)) return reply.code(400).send({ error: 'Addresses start with http:// or https://' });
    const next = { ...robotUrls(), ...(b.home !== undefined && { home: String(b.home) || undefined }), ...(b.public !== undefined && { public: String(b.public) || undefined }) };
    setSetting('robot.urls', JSON.stringify(next));
    return next;
  });

  // ---- the robot itself (its own token) ----
  app.post('/api/robot/heartbeat', { preHandler: requireUser }, async (req, reply) => {
    const r = robotOf(req, reply);
    if (!r) return;
    heartbeat(r, (req.body ?? {}) as Record<string, unknown>, req.ip);
    const now = robotById(r.id)!;
    return { configVersion: now.config_version, config: robotConfig(now, firmwareFor), jobsDone: jobsDone(r.owner_id, r.id) };
  });

  /** A new unlock PIN over the air: { pin } (4-8 digits); the robot gets only a salt and a hash. */
  app.post('/api/robots/:id/pin', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => changePin(req.user!.id, (req.params as { id: string }).id, (req.body as { pin?: unknown } | undefined)?.pin)),
  );

  // ---- background jobs (the robot, the app, or the owner) ----
  const robotIdOf = (u: User) => u.scope?.robot;
  app.get('/api/robot/jobs', { preHandler: requireUser }, async (req) => listJobs(req.user!.id, robotIdOf(req.user!)));
  app.get('/api/robot/jobs/:id', { preHandler: requireUser }, async (req, reply) => {
    const j = getJob(req.user!.id, (req.params as { id: string }).id);
    return j ? jobView(j, true) : reply.code(404).send({ error: 'No such job' });
  });
  app.post('/api/robot/jobs/:id/seen', { preHandler: requireUser }, async (req, reply) =>
    markSeen(req.user!.id, (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'No such job' }),
  );
  app.post('/api/robot/jobs/:id/cancel', { preHandler: requireUser }, async (req, reply) => {
    const j = getJob(req.user!.id, (req.params as { id: string }).id);
    if (!j) return reply.code(404).send({ error: 'No such job' });
    cancelRun(j.run_id, req.user!, 'Cancelled by the robot');
    return { ok: true };
  });
  /** Starts the job again from one block (after a failed step was fixed); what came before it is kept. */
  app.post('/api/robot/jobs/:id/resume', { preHandler: requireUser }, async (req, reply) =>
    safe(reply, () => {
      const u = req.user!;
      const j = getJob(u.id, (req.params as { id: string }).id);
      if (!j) throw Object.assign(new Error('No such job'), { statusCode: 404 });
      const from = String((req.body as { fromNode?: unknown } | undefined)?.fromNode ?? '');
      const r = resumeCheckpoint(j, from);
      // The workflow as it is saved now (the step may have been fixed), else as it ran.
      const saved = j.canvas_id ? (db.prepare('SELECT graph FROM canvases WHERE id = ? AND owner_id = ?').get(j.canvas_id, u.id) as { graph: string } | undefined) : undefined;
      const graph = saved ? JSON.parse(saved.graph) : r.graph;
      const runId = startRun({
        ownerId: u.id,
        user: u,
        canvasId: j.canvas_id ?? undefined,
        graph,
        question: r.question,
        vars: r.vars,
        resolve: resolverFor(u),
        freeGpu: gpuFreerFor(u),
        training: trainingFor(u),
        source: sourceOf(u, '/v1'),
        timeLimitMin: 60,
        resumable: { userId: u.id, providerUserId: u.id },
        startFrom: r.checkpoint,
      });
      moveJob(j.id, runId);
      return { jobId: j.id, runId, status: 'queued' };
    }),
  );
  app.get('/api/robot/config', { preHandler: requireUser }, async (req, reply) => {
    const r = robotOf(req, reply);
    if (!r) return;
    return robotConfig(r, firmwareFor);
  });
  app.post('/api/robot/event', { preHandler: requireUser }, async (req, reply) => {
    const r = robotOf(req, reply);
    if (!r) return;
    return safe(reply, () => robotEvent(r, (req.body ?? {}) as { type?: unknown; character?: unknown }));
  });

  // ---- Installers ----
  app.get('/api/installers', { preHandler: requireAdmin }, async () => ({ apps: listInstallers(), firmwareApp: FIRMWARE_APP }));

  /** A release file, uploaded by the app's build script (a token with the "installers" permission) or an admin. */
  app.put('/api/installers/:app/:version/:file', { preHandler: requireUser, bodyLimit: 200 * 1024 * 1024 }, async (req, reply) => {
    const u = req.user!;
    const allowed = u.scope ? u.scope.installers === true : u.role === 'admin';
    if (!allowed) return reply.code(403).send({ error: 'Uploading installers needs an admin, or a token with the installers permission' });
    const p = req.params as { app: string; version: string; file: string };
    if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'Send the file itself (content-type application/octet-stream)' });
    return safe(reply, () => putInstallerFile(p.app, p.version, p.file, req.body as Buffer));
  });

  /** Downloads a release file: admins, and a robot for its own firmware (OTA update). */
  app.get('/api/installers/:app/:version/:file', { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    const p = req.params as { app: string; version: string; file: string };
    const robotFirmware = !!u.scope?.robot && p.app === FIRMWARE_APP && p.file.endsWith('.bin');
    if (!robotFirmware && (u.scope || u.role !== 'admin')) return reply.code(403).send({ error: 'Installers are for admins' });
    return safe(reply, () => {
      const full = installerFilePath(p.app, p.version, p.file);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', statSync(full).size)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(p.file)}`)
        .send(createReadStream(full));
    });
  });

  app.delete('/api/installers/:app/:version', { preHandler: requireAdmin }, async (req, reply) => {
    const p = req.params as { app: string; version: string };
    return safe(reply, () => (deleteInstallerVersion(p.app, p.version), { ok: true }));
  });

  app.put('/api/installers/:app/repo', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => {
      const repo = (req.body as { repo?: unknown } | undefined)?.repo;
      setGithubRepo((req.params as { app: string }).app, typeof repo === 'string' && repo.trim() ? repo.trim() : null);
      return { ok: true };
    }),
  );

  /** Fetches the latest GitHub release of the app (private repositories with your GitHub token). */
  app.post('/api/installers/:app/github', { preHandler: requireAdmin }, async (req, reply) =>
    safe(reply, () => fetchGithubRelease((req.params as { app: string }).app, githubToken(req.user!.id))),
  );

  /** The manifest Espressif's esp-web-tools reads to flash a robot from the browser (Web Serial). */
  app.get('/api/installers/firmware-manifest', { preHandler: requireAdmin }, async (req, reply) => {
    const board = String((req.query as { board?: string }).board ?? '');
    if (!/^[\w.-]{1,40}$/.test(board)) return reply.code(400).send({ error: 'board is required' });
    const fw = latestFile(FIRMWARE_APP, (n) => n === `${board}-firmware.bin`);
    if (!fw) return reply.code(404).send({ error: `No firmware for ${board} yet: upload a release to Installers (${FIRMWARE_APP})` });
    const have = new Set(listInstallers().find((a) => a.app === FIRMWARE_APP)!.versions.find((v) => v.version === fw.version)!.files.map((f) => f.name));
    const parts = PARTS.filter((p) => have.has(`${board}-${p.part}.bin`)).map((p) => ({ path: `/api/installers/${FIRMWARE_APP}/${encodeURIComponent(fw.version)}/${board}-${p.part}.bin`, offset: p.offset }));
    return { name: `HiveBot robot (${board})`, version: fw.version, new_install_prompt_erase: true, builds: [{ chipFamily: 'ESP32-S3', parts }] };
  });
}

function robotUrls(): { home?: string; public?: string } {
  try {
    return JSON.parse(getSetting('robot.urls') ?? '{}') as { home?: string; public?: string };
  } catch {
    return {};
  }
}

