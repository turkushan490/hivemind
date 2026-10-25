import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authRoutes } from './api/auth.js';
import { providerRoutes, seedProviders } from './api/providers.js';
import { runRoutes } from './api/runs.js';
import { config } from './config.js';
import { describe, logError } from './errors.js';
import { problemRoutes } from './api/problems.js';
import { memoryRoutes } from './api/memory.js';
import { libraryRoutes } from './api/library.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });

// A crash is never silent: it is stored, shown in the Problems tab after the restart, then the process exits so Docker restarts it.
process.on('uncaughtException', (err) => {
  logError({ source: 'crash', ...describe(err), message: `Server crashed: ${describe(err).message}` });
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logError({ source: 'server', ...describe(err) });
  console.error(err);
});

// Hard crashes (native aborts, out-of-memory kills, power loss) skip every handler above.
// A marker file that only a clean stop removes catches those at the next start.
const marker = join(config.dataDir, 'running.json');
if (existsSync(marker)) {
  let last = 'unknown';
  try {
    last = new Date((JSON.parse(readFileSync(marker, 'utf8')) as { alive: number }).alive).toISOString();
  } catch {}
  logError({
    source: 'crash',
    message: 'HiveMind stopped unexpectedly last time (no error could be recorded)',
    detail: `Last seen alive: ${last}. Usually a hard crash, the container being killed (out of memory), or the server losing power.`,
  });
}
const beat = () => {
  try {
    writeFileSync(marker, JSON.stringify({ pid: process.pid, alive: Date.now() }));
  } catch {}
};
beat();
setInterval(beat, 30_000).unref();

// Clean stop (docker stop, Unraid update, Ctrl+C): finish quickly and leave no crash marker.
// Node as container PID 1 ignores SIGTERM unless handled, which would make Docker wait 10 s and kill it.
const stop = async () => {
  try {
    rmSync(marker, { force: true });
  } catch {}
  await app.close().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

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
    if (hasBody && !type.startsWith('application/json')) return reply.code(415).send({ error: 'Send JSON' });
  }
});

app.get('/api/health', async () => ({ ok: true, version: process.env.APP_VERSION || 'dev' }));

authRoutes(app);
providerRoutes(app);
runRoutes(app);
problemRoutes(app);
memoryRoutes(app);
libraryRoutes(app);
seedProviders(config.ollamaUrl);

if (existsSync(config.webDir)) {
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
    if (path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(path)) return reply.code(404).send({ error: 'Not found' });
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
}

await app.listen({ port: config.port, host: config.host });
