import type { HfHardware, HfSettings } from '@hivemind/shared';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';
import { FIREBALL, FIREBALL_PAPER } from './hfImport.js';

/**
 * Hugging Face: cloud training on HF Jobs (paid per minute, for bigger GPUs than this server has), and publishing a
 * finished model to the Hub. One account per HiveMind (set by an admin), with a daily spending limit: a cloud job
 * starts only after its owner confirmed the estimate, and only while today's estimates stay within the limit.
 * The work is done by trainer/hf.py with huggingface_hub (part of the training stack in the image).
 */

interface Stored {
  tokenEnc?: string;
  user?: string;
  dailyBudgetUsd?: number;
}

const KEY = 'huggingface';
const DEFAULT_BUDGET = 5;

function load(): Stored {
  try {
    return JSON.parse(getSetting(KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** The stored token, or undefined (reading public datasets needs none). */
export const token = () => {
  const s = load();
  return s.tokenEnc ? decrypt(s.tokenEnc) : undefined;
};

/** Dollars of cloud training started today (by the estimates people confirmed). */
export function spentToday(): number {
  const rows = db.prepare("SELECT settings FROM lab_trains WHERE backend = 'hf-jobs' AND date(started_at) = date('now')").all() as { settings: string }[];
  return Math.round(rows.reduce((sum, r) => sum + (Number(JSON.parse(r.settings).estimateUsd) || 0), 0) * 100) / 100;
}

export function hfSettings(): HfSettings {
  const s = load();
  return { hasToken: !!s.tokenEnc, user: s.user, dailyBudgetUsd: s.dailyBudgetUsd ?? DEFAULT_BUDGET, spentTodayUsd: spentToday() };
}

/** Saves the token (checked with whoami) and the daily limit; an empty token removes it, undefined keeps it. */
export async function saveHfSettings(patch: { token?: string; dailyBudgetUsd?: number }): Promise<HfSettings> {
  const s = load();
  if (patch.token !== undefined) {
    const t = patch.token.trim();
    if (!t) {
      delete s.tokenEnc;
      delete s.user;
    } else {
      const who = await hfRun('whoami', [], t);
      s.tokenEnc = encrypt(t);
      s.user = String(who.name);
    }
  }
  if (patch.dailyBudgetUsd !== undefined) {
    const b = Number(patch.dailyBudgetUsd);
    if (!Number.isFinite(b) || b < 0 || b > 10_000) throw Object.assign(new Error('The daily limit is a number of dollars (0 = no cloud training)'), { statusCode: 400 });
    s.dailyBudgetUsd = b;
  }
  setSetting(KEY, JSON.stringify(s));
  return hfSettings();
}

type Runner = (cmd: string, args: string[], token: string | undefined) => Promise<Record<string, any>>;

const python = () => [process.env.TRAINER_PYTHON, '/opt/unsloth-venv/bin/python'].find((p) => p && existsSync(p));

/** Runs one hf.py command; the token goes in the environment, never on the command line. */
const spawnHf: Runner = (cmd, args, tok) =>
  new Promise((resolve, reject) => {
    const py = python();
    if (!py) return reject(new Error('Hugging Face needs the HiveMind image with the training stack'));
    const child = spawn(py, [join(config.dataDir, 'lab', 'trainer', 'hf.py'), cmd, ...args], {
      env: { ...process.env, ...(tok && { HF_TOKEN: tok }), HF_HOME: process.env.HF_HOME || join(config.dataDir, 'trainer-cache', 'huggingface') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
    child.on('close', () => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() ?? '';
      let data: Record<string, any> = {};
      try {
        data = JSON.parse(last);
      } catch {
        return reject(new Error(`Hugging Face helper failed: ${(err || out).trim().slice(-400)}`));
      }
      if (data.error) return reject(new Error(`Hugging Face: ${data.error}`));
      resolve(data);
    });
  });

let runner: Runner = spawnHf;
/** Tests replace hf.py with a fake. */
export const setHfRunner = (r?: Runner) => (runner = r ?? spawnHf);

export function hfRun(cmd: string, args: string[] = [], tok = token()) {
  return runner(cmd, args, tok);
}

/** The token, or a clear error when Hugging Face is not connected. */
export function requireHfToken(): string {
  const t = token();
  if (!t) throw Object.assign(new Error('Connect Hugging Face first (Settings → Hugging Face: an access token with write rights)'), { statusCode: 400 });
  return t;
}

// Rough speed of a training step compared with a Tesla T4 (the speeds in BASES are for a T4).
const SPEED: Record<string, number> = { T4: 1, L4: 2, A10G: 2.5, L40S: 4, A100: 5, 'RTX PRO 6000': 6, H200: 8 };

let cache: { at: number; list: HfHardware[] } | undefined;

/** Single-GPU machines HF Jobs rents (multi-GPU doesn't speed up this trainer), cheapest first. */
export async function hfHardware(): Promise<HfHardware[]> {
  if (cache && Date.now() - cache.at < 3_600_000) return cache.list;
  const data = await hfRun('hardware');
  const list = (data.hardware as (HfHardware & { count: number })[])
    .filter((h) => h.count === 1)
    .map(({ count: _count, ...h }) => ({ ...h, speed: SPEED[h.gpu] ?? 1 }))
    .sort((a, b) => a.usdPerHour - b.usdPerHour);
  cache = { at: Date.now(), list };
  return list;
}

/** Time and price of a cloud job: training steps at the machine's speed, plus about 15 minutes to set up and export. */
export function estimateCloud(steps: number, secPerStepT4: number, hw: HfHardware): { hours: number; usd: number } {
  const hours = (steps * secPerStepT4) / hw.speed / 3600 + 0.25;
  return { hours: Math.round(hours * 100) / 100, usd: Math.round(hours * hw.usdPerHour * 100) / 100 };
}

/** A model card for a published model; sources are the Hugging Face datasets its dataset imported (they need credit). */
export function modelCard(o: {
  name: string;
  repo: string;
  base: string;
  dataset: string;
  rows: number;
  kind: string;
  file: string;
  sources?: { repo: string; license: string | null; url: string }[];
}): string {
  const decision = o.kind === 'decision';
  const sources = o.sources ?? [];
  const training = sources.length
    ? `
## Training data

${sources
  .map(
    (s) =>
      `- [${s.repo}](${s.url}), license: ${s.license ?? 'none listed'}${s.repo.toLowerCase() === FIREBALL.toLowerCase() ? ` (paper: [FIREBALL](${FIREBALL_PAPER}))` : ''}`,
  )
  .join('\n')}
`
    : '';
  return `---
base_model: ${o.base}${sources.length ? `\ndatasets:\n${sources.map((s) => `  - ${s.repo}`).join('\n')}` : ''}
tags:
  - gguf
  - hivemind
  - unsloth${decision ? '\n  - decision\n  - systemone' : ''}
license: apache-2.0
---

# ${o.name}

${decision ? 'A decision model' : 'A fine-tuned model'} made with [HiveMind](https://github.com/turkushan490/hivemind): a LoRA fine-tune of [${o.base}](https://huggingface.co/${o.base}) with Unsloth on the dataset "${o.dataset}" (${o.rows} examples), merged and exported as \`${o.file}\` (GGUF).

## Use with Ollama

\`\`\`
ollama pull hf.co/${o.repo}
\`\`\`
${decision ? '\nIt answers typed questions through Ollama\'s `/v1/systemone` API (llama.cpp decision type `openjev`).\n' : ''}${training}`;
}
