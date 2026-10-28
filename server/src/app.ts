import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { authRoutes, viewerGuard } from './api/auth.js';
import { builderRoutes } from './api/builder.js';
import { exportRoutes } from './api/exports.js';
import { fileRoutes } from './api/files.js';
import { libraryRoutes } from './api/library.js';
import { memoryRoutes } from './api/memory.js';
import { problemRoutes } from './api/problems.js';
import { providerRoutes } from './api/providers.js';
import { runRoutes } from './api/runs.js';
import { scopeGuard } from './api/scope.js';
import { settingsRoutes } from './api/settings.js';
import { statsRoutes } from './api/stats.js';
import { v1Routes } from './api/v1.js';
import { voiceRoutes } from './api/voice.js';
import { config } from './config.js';
import { logError } from './errors.js';
import { FEATURES } from './features.js';

/** The whole web app without listening: main.ts starts it, tests inject requests into it. */
export async function buildApp(opts: { logger?: boolean; web?: boolean; onRoute?: (r: RouteOptions) => void } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });

  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  await app.register(cookie);

  // Unexpected errors in a request: logged with an id the UI can show.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status < 500) return reply.code(status).send({ error: err.message });
    const id = logError({ source: 'server', message: `${req.method} ${req.url.split('?')[0]}: ${err.message}`, detail: err.stack, userId: req.user?.id });
    req.log.error(err);
    return reply.code(500).send({ error: `Server error: ${err.message}`, problemId: id });
  });

  // Cookie auth + SameSite=Strict; also refuse cross-site form posts by requiring JSON on writes.
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.url.startsWith('/api/')) {
      const type = req.headers['content-type'] ?? '';
      const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'];
      // Raw bodies only where files are uploaded or imported.
      const upload =
        (req.url.startsWith('/api/files') && type.startsWith('application/octet-stream')) ||
        (req.url.startsWith('/api/import/') && type.startsWith('application/zip')) ||
        (req.url.startsWith('/api/voice/transcribe') && /^(audio\/|video\/|application\/octet-stream)/.test(type));
      if (hasBody && !upload && !type.startsWith('application/json')) return reply.code(415).send({ error: 'Send JSON' });
    }
  });

  // Viewers may only use canvases: every write outside their short list is refused here, in one place.
  app.addHook('onRequest', viewerGuard);
  // Limited API tokens: only their canvases, runs and memory keys.
  app.addHook('preHandler', scopeGuard);

  // features: what clients like DungeonMind can rely on (see features.ts).
  app.get('/api/health', async () => ({ ok: true, version: process.env.APP_VERSION || 'dev', features: [...FEATURES] }));

  authRoutes(app);
  providerRoutes(app);
  runRoutes(app);
  problemRoutes(app);
  memoryRoutes(app);
  libraryRoutes(app);
  settingsRoutes(app);
  builderRoutes(app);
  fileRoutes(app);
  exportRoutes(app);
  v1Routes(app);
  voiceRoutes(app);
  statsRoutes(app);

  if (opts.web !== false && existsSync(config.webDir)) {
    await app.register(staticFiles, {
      root: config.webDir,
      // Never cache the page itself, so after an update the browser loads the new script files.
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      },
    });
    // Single-page app: page routes get index.html; a missing file (old script after an update) is a real 404.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/') || path.startsWith('/v1/') || /\.[a-z0-9]+$/i.test(path)) return reply.code(404).send({ error: 'Not found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }

  return app;
}
