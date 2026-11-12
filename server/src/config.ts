import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isPackaged } from './packaging.js';

const dataDir = process.env.DATA_DIR || (existsSync('/data') ? '/data' : './data');
mkdirSync(dataDir, { recursive: true });

/**
 * A plain-text log file of problems, crashes and start/stop, so the exe (where there is no `docker logs`) leaves
 * something to send when it misbehaves. On by default for the packaged exe; elsewhere set LOG_FILE to switch it on
 * (a path, or "1"/"true" for the default location). Docker keeps logging to stdout as before.
 */
function logFilePath(): string | undefined {
  const env = process.env.LOG_FILE;
  if (env && env !== '1' && env !== 'true' && env !== 'false' && env !== '0') return resolve(env);
  if (env === 'false' || env === '0') return undefined;
  if (env || isPackaged()) return join(dataDir, 'hivemind.log');
  return undefined;
}

/** SECRET_KEY encrypts stored API keys; without it one is generated once and kept in the data dir. */
function secretKey(): Buffer {
  const env = process.env.SECRET_KEY;
  if (env) return createHash('sha256').update(env).digest();
  const file = join(dataDir, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export const config = {
  port: Number(process.env.PORT || 4820),
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  secretKey: secretKey(),
  /** Seeded as the first Ollama provider on a fresh install. */
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  /** Optional: your ComfyUI, added once as an image provider. */
  comfyUrl: process.env.COMFYUI_URL || '',
  /** Optional: ComfyUI's own folder mounted into HiveMind (input, output, models), for training image LoRAs. */
  comfyDir: process.env.COMFYUI_DIR || (existsSync('/comfyui/models') ? '/comfyui' : ''),
  /** Optional: a TypeSafe key, added once as the Jev decision provider. */
  typesafeKey: process.env.TYPESAFE_API_KEY || '',
  /** Set to true behind HTTPS (e.g. Nginx Proxy Manager) so cookies get the Secure flag. */
  secureCookies: process.env.SECURE_COOKIES === 'true',
  webDir: resolve(process.env.WEB_DIR || 'web'),
  /** Plain-text log file for problems/crashes/lifecycle, or undefined when off (see logFilePath). */
  logFile: logFilePath(),
};
