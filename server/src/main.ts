import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedColibri, seedProviders } from './api/providers.js';
import { runScheduled } from './api/schedules.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { describe, logError } from './errors.js';
import { startScheduler } from './services/schedules.js';
import { seedBuiltinSkills } from './services/skills.js';
import { closeStaleRuns } from './events/runs.js';
import { resumeStoppedRuns } from './api/runs.js';
import { lockDataDir } from './services/build.js';
import { openBrowser } from './packaging.js';

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
const beating = setInterval(beat, 30_000);
beating.unref();

// Clean stop (docker stop, Unraid update, Ctrl+C): finish quickly and leave no crash marker.
// Node as container PID 1 ignores SIGTERM unless handled, which would make Docker wait 10 s and kill it.
const stop = async () => {
  // No heartbeat may write the marker again while closing, or a clean stop would show as a crash.
  clearInterval(beating);
  try {
    rmSync(marker, { force: true });
  } catch {}
  // Open live streams (a browser following a run) keep the server from closing: never wait past Docker's limit.
  // Running runs stop here and go on after the restart (their progress is stored after every block).
  setTimeout(() => process.exit(0), 5000).unref();
  await app.close().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

// Runs left on "running" by the previous process never finish: closed before the server takes requests.
closeStaleRuns();
// Project builds run as their own user: the data folder (database, secret key, files) is closed to it first.
lockDataDir();

const app = await buildApp();

seedProviders(config.ollamaUrl, config.comfyUrl, config.typesafeKey);
// The built-in colibri engine (when the image has it) gets its two providers once.
seedColibri();
seedBuiltinSkills();

await app.listen({ port: config.port, host: config.host });

// Windows .exe (or HIVEMIND_OPEN_BROWSER set): show the UI in a window. In Docker this env is unset, so nothing opens.
openBrowser(`http://localhost:${config.port}`);

// Runs a restart stopped (an update, a crash) go on where they were.
const resumed = resumeStoppedRuns();
if (resumed) console.log(`Went on with ${resumed} run${resumed === 1 ? '' : 's'} a restart had stopped`);

// Scheduled workflows: every minute, the ones that are due run like POST /api/runs, as their owner (local time, TZ).
startScheduler(runScheduled);
