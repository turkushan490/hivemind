import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logError } from '../errors.js';

/**
 * Built-in text to speech: Kokoro (82M, open weights) inside this container, behind the OpenAI /audio/speech API.
 * The image carries the Python package (/opt/kokoro-lib); the model files (~350 MB) are downloaded into
 * /data/kokoro the first time a voice is needed. The server starts on demand and stops after 30 minutes without
 * requests, so it costs nothing while nobody talks.
 */

const state = {
  lib: process.env.KOKORO_LIB || '/opt/kokoro-lib',
  dir: process.env.KOKORO_DIR || join(config.dataDir, 'kokoro'),
  port: Number(process.env.KOKORO_PORT) || 8880,
  /** Tests: a stand-in for the Python server (cmd + args), and the model download. */
  launch: undefined as undefined | ((port: number) => { cmd: string; args: string[] }),
  download: undefined as undefined | ((url: string, file: string) => Promise<void>),
};

export function configureKokoro(o: Partial<typeof state>) {
  Object.assign(state, o);
}

const FILES = [
  { name: 'kokoro-v1.0.onnx', url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx', min: 300e6 },
  { name: 'voices-v1.0.bin', url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin', min: 20e6 },
];

/** The voices Kokoro has for English, for the settings page (American a*, British b*). */
export const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

const here = dirname(fileURLToPath(import.meta.url));
const script = () => [resolve(here, '../kokoro/serve.py'), resolve(here, '../../kokoro/serve.py')].find((p) => existsSync(p));
const python = () => [process.env.KOKORO_PYTHON, '/opt/unsloth-venv/bin/python', '/usr/bin/python3'].find((p) => p && existsSync(p)) ?? 'python3';

/** The image has the built-in voice (or a test stands in for it). */
export const kokoroAvailable = () => !!state.launch || (existsSync(join(state.lib, 'kokoro_onnx')) && !!script());

export const kokoroBase = () => `http://127.0.0.1:${state.port}/v1`;

let proc: ChildProcess | undefined;
let starting: Promise<string> | undefined;
let idle: NodeJS.Timeout | undefined;
const IDLE_MS = 30 * 60_000;

async function fetchFile(url: string, file: string) {
  if (state.download) return state.download(url, file);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Downloading ${url}: HTTP ${res.status}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  renameSync(part, file);
}

/** The model files, downloaded once into /data/kokoro. */
async function modelFiles(): Promise<{ model: string; voices: string }> {
  mkdirSync(state.dir, { recursive: true });
  for (const f of FILES) {
    const file = join(state.dir, f.name);
    const ok = existsSync(file) && (state.download || statSync(file).size >= f.min);
    if (!ok) {
      rmSync(file, { force: true });
      await fetchFile(f.url, file);
    }
  }
  return { model: join(state.dir, FILES[0].name), voices: join(state.dir, FILES[1].name) };
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

function touch() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void stopKokoro(), IDLE_MS);
  idle.unref();
}

/** Starts the built-in voice when needed and returns its OpenAI-compatible base URL. */
export function ensureKokoro(): Promise<string> {
  if (!kokoroAvailable()) return Promise.reject(new Error('This HiveMind image has no built-in voice (Kokoro)'));
  touch();
  if (proc && proc.exitCode === null) return starting ?? Promise.resolve(kokoroBase());
  starting = (async () => {
    let cmd: string;
    let args: string[];
    if (state.launch) ({ cmd, args } = state.launch(state.port));
    else {
      const files = await modelFiles();
      cmd = python();
      args = [script()!, String(state.port), files.model, files.voices];
    }
    let out = '';
    const child = spawn(cmd, args, { env: { ...process.env, PYTHONPATH: state.lib, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = child;
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-4000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('exit', (code) => {
      if (proc === child) proc = undefined;
      if (code) logError({ source: 'server', message: `The built-in voice (Kokoro) stopped with exit code ${code}`, detail: out.slice(-1500) });
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      if (child.exitCode !== null) throw new Error(`The built-in voice (Kokoro) would not start: ${out.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'no output'}`);
      if (await healthy()) return kokoroBase();
      await new Promise((r) => setTimeout(r, 300));
    }
    child.kill('SIGKILL');
    throw new Error('The built-in voice (Kokoro) took more than 2 minutes to start');
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function stopKokoro() {
  if (idle) clearTimeout(idle);
  const p = proc;
  proc = undefined;
  if (p && p.exitCode === null) {
    const gone = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  }
}

process.once('exit', () => proc?.kill('SIGTERM'));
