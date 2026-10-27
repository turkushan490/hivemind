import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedProviders } from './api/providers.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { describe, logError } from './errors.js';

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

const app = await buildApp();

seedProviders(config.ollamaUrl, config.comfyUrl);

await app.listen({ port: config.port, host: config.host });
