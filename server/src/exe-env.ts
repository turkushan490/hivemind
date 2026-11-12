// Windows .exe only: set up a writable data folder and unpack the baked-in web UI, BEFORE anything reads config.
// Imported first by exe.ts, so these env vars are set before config.ts (and the rest of the server) load.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { appRelease, webAssets, webBuildId } from './web-assets.generated.js';

// The version the exe reports at /api/health (baked in at build time); real env wins if the user set it.
if (appRelease) {
  if (!process.env.APP_RELEASE) process.env.APP_RELEASE = appRelease;
  if (!process.env.APP_VERSION) process.env.APP_VERSION = appRelease;
}

// Data (database, encrypted keys, files) lives where a normal user may write — not next to the .exe (Program Files is read-only).
const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const dataDir = process.env.DATA_DIR || join(localAppData, 'HiveMind');
mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;

// Unpack the web UI to <dataDir>/web the first time (and again after an update, when the build id changes).
const webDir = join(dataDir, 'web');
const stamp = join(webDir, '.build-id');
const have = (() => {
  try {
    return readFileSync(stamp, 'utf8');
  } catch {
    return '';
  }
})();
if (webBuildId && have !== webBuildId) {
  for (const [rel, b64] of Object.entries(webAssets)) {
    const full = join(webDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.from(b64, 'base64'));
  }
  writeFileSync(stamp, webBuildId);
}
if (existsSync(webDir)) process.env.WEB_DIR = webDir;

// A desktop user expects a window: open the UI once the server is up (main.ts does it after it listens).
if (!process.env.HIVEMIND_OPEN_BROWSER) process.env.HIVEMIND_OPEN_BROWSER = 'app';
