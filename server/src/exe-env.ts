// Windows .exe only: set up a writable data folder and unpack the baked-in web UI, BEFORE anything reads config.
// Imported first by exe.ts, so these env vars are set before config.ts (and the rest of the server) load.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { appRelease, webAssets, webBuildId } from './web-assets.generated.js';
import { whisperBin, whisperBinId } from './whisper-bin.generated.js';

// Mark this process as the packaged exe, so the server treats container-only features as "absent, expected" and writes a log file.
process.env.HIVEMIND_PACKAGED = '1';

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

// Unpack the built-in whisper.cpp engine (the Windows binary baked in) to <dataDir>/whisper, the first time / after an update.
if (whisperBinId) {
  const whisperDir = join(dataDir, 'whisper');
  const wStamp = join(whisperDir, '.bin-id');
  let haveW = '';
  try {
    haveW = readFileSync(wStamp, 'utf8');
  } catch {}
  if (haveW !== whisperBinId) {
    mkdirSync(whisperDir, { recursive: true });
    for (const [name, b64] of Object.entries(whisperBin)) writeFileSync(join(whisperDir, name), Buffer.from(b64, 'base64'));
    writeFileSync(wStamp, whisperBinId);
  }
}

// A desktop user expects a window: open the UI once the server is up (main.ts does it after it listens).
if (!process.env.HIVEMIND_OPEN_BROWSER) process.env.HIVEMIND_OPEN_BROWSER = 'app';
