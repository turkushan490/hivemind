import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const dataDir = process.env.DATA_DIR || (existsSync('/data') ? '/data' : './data');
mkdirSync(dataDir, { recursive: true });

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
  /** Set to true behind HTTPS (e.g. Nginx Proxy Manager) so cookies get the Secure flag. */
  secureCookies: process.env.SECURE_COOKIES === 'true',
  webDir: resolve(process.env.WEB_DIR || 'web'),
};
