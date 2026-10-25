import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { authRoutes } from './api/auth.js';
import { providerRoutes, seedProviders } from './api/providers.js';
import { runRoutes } from './api/runs.js';
import { config } from './config.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: true, bodyLimit: 5 * 1024 * 1024 });

await app.register(cookie);

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
seedProviders(config.ollamaUrl);

if (existsSync(config.webDir)) {
  await app.register(staticFiles, { root: config.webDir, wildcard: false });
  // Single-page app: unknown non-API paths get index.html.
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

await app.listen({ port: config.port, host: config.host });
