// A tiny plain-text log file (config.logFile), for the exe where there is no `docker logs`. Best-effort, never throws.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const MAX_BYTES = 5 * 1024 * 1024;
let ready = false;

/** Appends one timestamped line (plus optional detail) to the log file, rotating it once it passes ~5 MB. */
export function appendLog(level: string, message: string, detail?: string): void {
  const file = config.logFile;
  if (!file) return;
  try {
    if (!ready) {
      mkdirSync(dirname(file), { recursive: true });
      ready = true;
    }
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {}
    const line = `${new Date().toISOString()} [${level}] ${message}${detail ? `\n${detail}` : ''}\n`;
    appendFileSync(file, line);
  } catch {
    // Logging must never break the server.
  }
}
