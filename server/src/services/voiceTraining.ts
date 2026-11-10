import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { db, getSetting, setSetting } from '../db/index.js';
import { logError } from '../errors.js';
import { addItems, ensureDataset } from '../lab/datasets.js';
import { filesDir, ownPath, safePath, setOwner, type FileUser } from './files.js';

/**
 * Voice training for HiveBot's characters: recordings (mp3/mp4/wav/m4a) → clean clips → a voice dataset (what is said
 * in each clip) → a cloned voice (Qwen3-TTS, Apache 2.0) that /api/voice/speak uses as "clone:<name>". Everything
 * runs inside this container: a Python worker (server/voice/worker.py) started on demand, models in
 * /data/models/voice. Clips are files of the person who ran it (files/voices/<name>/), voices live in
 * /data/voices/<name>/voice.json; the previous version is kept for 7 days.
 */

export interface VoiceEngineSettings {
  enabled: boolean;
  /** auto: the GPU when it has 4 GB free (never pushing ComfyUI or Ollama out), else the CPU. */
  device: 'auto' | 'cpu';
  /** Minutes the voice model stays loaded after the last sentence. */
  keepMin: number;
}
const KEY = 'voice.engines';
export function voiceEngineSettings(): VoiceEngineSettings {
  try {
    const s = JSON.parse(getSetting(KEY) ?? '{}') as Partial<VoiceEngineSettings>;
    return { enabled: s.enabled !== false, device: s.device === 'cpu' ? 'cpu' : 'auto', keepMin: Number.isFinite(s.keepMin) ? Math.max(1, Math.min(1440, s.keepMin!)) : 10 };
  } catch {
    return { enabled: true, device: 'auto', keepMin: 10 };
  }
}
export function saveVoiceEngineSettings(p: Partial<VoiceEngineSettings>): VoiceEngineSettings {
  const next = { ...voiceEngineSettings(), ...p };
  next.enabled = !!next.enabled;
  next.device = next.device === 'cpu' ? 'cpu' : 'auto';
  next.keepMin = Math.max(1, Math.min(1440, Math.round(Number(next.keepMin) || 10)));
  setSetting(KEY, JSON.stringify(next));
  return next;
}

const state = {
  lib: process.env.VOICE_LIB || '/opt/voice-lib',
  extraLib: process.env.KOKORO_LIB || '/opt/kokoro-lib',
  port: Number(process.env.VOICE_PORT) || 8881,
  voicesDir: resolve(config.dataDir, 'voices'),
  modelsDir: resolve(config.dataDir, 'models', 'voice'),
  /** Tests: a stand-in for the Python worker. */
  launch: undefined as undefined | ((port: number) => { cmd: string; args: string[] }),
};
export function configureVoiceTraining(o: Partial<typeof state>) {
  Object.assign(state, o);
}

const here = dirname(fileURLToPath(import.meta.url));
const script = () => [resolve(here, '../voice/worker.py'), resolve(here, '../../voice/worker.py')].find((p) => existsSync(p));
const python = () => [process.env.VOICE_PYTHON, '/opt/unsloth-venv/bin/python', '/usr/bin/python3'].find((p) => p && existsSync(p)) ?? 'python3';

/** The image has the voice engine (or a test stands in for it). */
export const voiceEngineAvailable = () => !!state.launch || (existsSync(join(state.lib, 'qwen_tts')) && !!script());

let proc: ChildProcess | undefined;
let starting: Promise<string> | undefined;
let idle: NodeJS.Timeout | undefined;
let lastOut = '';

let inFlight = 0; // voice jobs waiting on or running in the engine: it is never stopped for being idle under them

function touch() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => (inFlight > 0 ? touch() : void stopVoiceWorker()), voiceEngineSettings().keepMin * 60_000);
  idle.unref();
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

function ensureWorker(): Promise<string> {
  if (!voiceEngineAvailable()) return Promise.reject(new Error('This HiveMind image has no voice engine (Qwen3-TTS)'));
  if (!voiceEngineSettings().enabled) return Promise.reject(new Error('The voice engine is off (Settings → Voice → Voice engine)'));
  touch();
  const base = `http://127.0.0.1:${state.port}`;
  if (proc && proc.exitCode === null) return starting ?? Promise.resolve(base);
  starting = (async () => {
    mkdirSync(state.modelsDir, { recursive: true });
    const { cmd, args } = state.launch ? state.launch(state.port) : { cmd: python(), args: [script()!, String(state.port), state.modelsDir] };
    const child = spawn(cmd, args, {
      env: { ...process.env, PYTHONPATH: [state.lib, state.extraLib].join(':'), PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc = child;
    lastOut = '';
    const keep = (d: Buffer) => (lastOut = (lastOut + d.toString()).slice(-6000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('exit', (code) => {
      if (proc === child) proc = undefined;
      if (code) logError({ source: 'voice', message: `The voice engine stopped with exit code ${code}`, detail: lastOut.slice(-1500) });
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      if (child.exitCode !== null) throw new Error(`The voice engine would not start: ${lastOut.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'no output'}`);
      if (await healthy()) return base;
      await new Promise((r) => setTimeout(r, 300));
    }
    child.kill('SIGKILL');
    throw new Error('The voice engine took more than 2 minutes to start');
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function stopVoiceWorker() {
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

async function call(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const base = await ensureWorker();
  inFlight++;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // The engine does one job at a time; "fetch failed" alone said nothing.
    const why = (err as Error).name === 'TimeoutError' ? 'took too long' : proc ? 'was busy too long with other voice jobs, or stopped' : 'stopped';
    throw new Error(`The voice engine ${why} (${(err as Error).message})`);
  } finally {
    inFlight--;
  }
  touch();
  if (!res.ok) throw new Error(`Voice engine: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`}`);
  return res;
}

// ---- names ----

/** A voice or character name: letters, digits, - and _ (it becomes a folder). */
export function voiceName(raw: string): string {
  const n = raw
    .trim()
    .toLowerCase()
    .replace(/^(clone|ft):/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!n) throw new Error('Say which character (or voice) this is: e.g. "Jarvis"');
  return n;
}

const KNOWN = ['jev', 'jarvis', 'ultron', 'vision'];
/** The character a run is about: vars.character, else a known name in the question, else the question's first word. */
export function characterOf(vars: Record<string, string> | undefined, question: string): string {
  if (vars?.character) return voiceName(vars.character);
  const text = question.replace(/\[[^\]]*\]\(hm-file:[^)]+\)|!\[[^\]]*\]\(hm-file:[^)]+\)/g, ' ').toLowerCase();
  const known = KNOWN.find((k) => new RegExp(`\\b${k}\\b`).test(text));
  if (known) return known;
  const word = text.match(/[a-z][a-z0-9_-]{1,39}/)?.[0];
  if (!word) throw new Error('Say which character the recordings are for (e.g. type "Jarvis" with the files)');
  return voiceName(word);
}

/** Audio and video files linked in the question ([name](hm-file:path)), and the files of a folder. */
const AUDIO = /\.(mp3|mp4|m4a|wav|ogg|flac|webm|aac|mov|mkv)$/i;
export function audioFilesOf(user: FileUser, question: string, folder?: string): string[] {
  const out = new Set<string>();
  // Encoded links (x%20%282%29.mp3) and older raw ones with spaces / brackets in the name (x (2).mp3).
  for (const m of question.matchAll(/!?\[[^\]]*\]\(hm-file:([^\n]+?)\)(?=\s|$)/g)) {
    let rel = m[1];
    try {
      rel = decodeURIComponent(rel);
    } catch {}
    if (AUDIO.test(rel)) out.add(rel);
  }
  if (folder?.trim()) {
    const dir = safePath(folder.trim().replace(/\/+$/, ''));
    if (existsSync(dir))
      for (const name of readdirSync(dir)) {
        const rel = relative(filesDir, join(dir, name)).split(sep).join('/');
        if (AUDIO.test(name) && statSync(join(dir, name)).isFile()) out.add(rel);
      }
  }
  // Only the runner's own files (an admin may use any).
  return [...out].filter((rel) => {
    try {
      ownPath(user, rel);
      return true;
    } catch {
      return false;
    }
  });
}

// ---- prep, dataset, clone, speak ----

export interface Clip {
  /** In the files folder: voices/<name>/clip_0001.wav */
  path: string;
  seconds: number;
  db: number;
  source: string;
}

/** Cuts recordings into clean 3–15 s clips under files/voices/<name>/ (owned by the runner). */
export async function prepAudio(user: FileUser, files: string[], name: string, opts: { minSec?: number; maxSec?: number } = {}) {
  if (!files.length) throw new Error('No recordings: attach mp3 / mp4 / wav / m4a files to the question (or set the block\'s folder)');
  const relDir = `voices/${name}`;
  const dir = safePath(relDir);
  mkdirSync(dir, { recursive: true });
  // Numbers go on after the clips that are already there.
  const start = readdirSync(dir).filter((f) => /^clip_\d+\.wav$/.test(f)).length + 1;
  const res = await call('/prep', { inputs: files.map((f) => ownPath(user, f)), outDir: dir, prefix: 'clip', start, minSec: opts.minSec ?? 3, maxSec: opts.maxSec ?? 15 }, 60 * 60_000);
  const out = (await res.json()) as { clips: (Omit<Clip, 'path'> & { path: string })[]; dropped: Record<string, number>; files: { file: string; minutes: number; clips: number }[] };
  const clips = out.clips.map((c) => {
    const rel = relative(filesDir, c.path).split(sep).join('/');
    setOwner(rel, user.id);
    return { ...c, path: rel };
  });
  return { character: name, clips, dropped: out.dropped, files: out.files };
}

const hashOf = (full: string) => createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 32);

/**
 * Adds clips to the voice dataset (kind "voice"), each with what is said in it; a clip already in it (same audio)
 * is skipped, so a second run only adds what is new. Also writes an LJSpeech-style metadata.csv next to the clips.
 */
export async function addToVoiceDataset(
  user: FileUser,
  dataset: string,
  name: string,
  clips: Clip[],
  transcribe: (audio: Buffer) => Promise<string>,
  progress: (note: string) => void,
  signal?: AbortSignal,
) {
  const ds = ensureDataset(user.id, dataset, 'voice');
  const have = new Set((db.prepare('SELECT ref FROM dataset_items WHERE dataset_id = ? AND ref IS NOT NULL').all(ds.id) as { ref: string }[]).map((r) => r.ref));
  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < clips.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const c = clips[i];
    const full = ownPath(user, c.path);
    const ref = hashOf(full);
    if (have.has(ref)) {
      skipped++;
      rmSync(full, { force: true });
      continue;
    }
    progress(`Writing down what is said: clip ${i + 1} of ${clips.length}`);
    let text = '';
    for (let attempt = 0; attempt < 4 && !text; attempt++) {
      try {
        text = (await transcribe(readFileSync(full))).trim();
        if (!text) break;
      } catch (err) {
        // Speech-to-text services limit requests per minute: wait and try again.
        if (attempt < 3 && /429|rate|limit/i.test((err as Error).message)) await new Promise((r) => setTimeout(r, 20_000));
        else {
          if (!failed) progress(`Speech to text failed: ${(err as Error).message.slice(0, 200)}`);
          break;
        }
      }
    }
    if (!text) {
      failed++;
      continue;
    }
    addItems(ds.id, 'block', [{ input: text, output: '', files: [c.path], ref, meta: { seconds: c.seconds, db: c.db, source: c.source } }]);
    have.add(ref);
    added++;
  }
  const rows = db.prepare('SELECT input, files, meta FROM dataset_items WHERE dataset_id = ?').all(ds.id) as { input: string; files: string | null; meta: string | null }[];
  const items = rows.map((r) => ({ text: r.input, file: (JSON.parse(r.files ?? '[]') as string[])[0], seconds: Number((JSON.parse(r.meta ?? '{}') as { seconds?: number }).seconds ?? 0) }));
  writeFileSync(safePath(`voices/${name}/metadata.csv`), items.map((it) => `${(it.file ?? '').split('/').pop()?.replace(/\.wav$/, '')}|${it.text.replace(/[|\n]+/g, ' ')}`).join('\n'));
  setOwner(`voices/${name}/metadata.csv`, user.id);
  const minutes = items.reduce((n, it) => n + it.seconds, 0) / 60;
  return { character: name, dataset: ds.name, added, skipped, failed, clips: items.length, minutes: Math.round(minutes * 10) / 10 };
}

export interface VoiceDef {
  id: string;
  name: string;
  engine: 'qwen3-tts';
  model: string;
  refs: { audio: string; text: string; seconds: number }[];
  created: string;
  minutes: number;
  dataset: string;
}

const voiceFile = (name: string) => join(state.voicesDir, voiceName(name), 'voice.json');

/** Builds (or rebuilds) a cloned voice from the best clips of a voice dataset: clean, 6–12 s, with the most words. */
export function buildVoice(user: FileUser, dataset: string, name: string, count = 3): VoiceDef {
  const ds = ensureDataset(user.id, dataset, 'voice');
  const rows = db.prepare("SELECT input, files, meta FROM dataset_items WHERE dataset_id = ? AND (review IS NULL OR review = 'accepted')").all(ds.id) as { input: string; files: string | null; meta: string | null }[];
  if (!rows.length) throw new Error(`The voice dataset "${dataset}" is empty: run the recordings through Audio prep and Voice dataset first`);
  const items = rows
    .map((r) => {
      const meta = JSON.parse(r.meta ?? '{}') as { seconds?: number; db?: number };
      return { text: r.input, file: (JSON.parse(r.files ?? '[]') as string[])[0], seconds: meta.seconds ?? 0, db: meta.db ?? -30 };
    })
    .filter((it) => it.file && existsSync(safePath(it.file)));
  const score = (it: (typeof items)[0]) => (it.seconds >= 6 && it.seconds <= 12 ? 10 : 0) - Math.abs(it.db + 20) * 0.3 + Math.min(it.text.split(/\s+/).length, 30) * 0.2;
  // Varied: no two refs from the same source file when there is a choice.
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const picked: typeof items = [];
  for (const it of sorted) if (picked.length < count && !picked.some((p) => p.file === it.file)) picked.push(it);
  const dir = join(state.voicesDir, voiceName(name));
  mkdirSync(dir, { recursive: true });
  // The previous version stays 7 days ("Use previous voice").
  const file = join(dir, 'voice.json');
  if (existsSync(file)) {
    const n = readdirSync(dir).filter((f) => /^voice\.v\d+\.json$/.test(f)).length + 1;
    renameSync(file, join(dir, `voice.v${n}.json`));
    for (const f of readdirSync(dir)) if (/^voice\.v\d+\.json$/.test(f) && Date.now() - statSync(join(dir, f)).mtimeMs > 7 * 86400_000) rmSync(join(dir, f), { force: true });
  }
  // The reference clips are copied next to the voice, so deleting files in Files can't break it.
  const refs = picked.map((it, i) => {
    const to = join(dir, `ref_${i + 1}.wav`);
    copyFileSync(safePath(it.file), to);
    return { audio: to, text: it.text, seconds: it.seconds };
  });
  const minutes = Math.round((items.reduce((n, it) => n + it.seconds, 0) / 60) * 10) / 10;
  const def: VoiceDef = { id: `clone:${voiceName(name)}`, name: voiceName(name), engine: 'qwen3-tts', model: 'Qwen3-TTS-12Hz-0.6B-Base', refs, created: new Date().toISOString(), minutes, dataset: ds.name };
  writeFileSync(file, JSON.stringify(def, null, 2));
  return def;
}

/** Goes back to the voice before the last build. */
export function previousVoice(name: string): VoiceDef {
  const dir = join(state.voicesDir, voiceName(name));
  const versions = existsSync(dir) ? readdirSync(dir).filter((f) => /^voice\.v\d+\.json$/.test(f)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])) : [];
  if (!versions.length) throw new Error(`There is no earlier version of the voice ${name}`);
  renameSync(join(dir, versions[0]), join(dir, 'voice.json'));
  return JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8')) as VoiceDef;
}

/** Every cloned voice. */
export function listClonedVoices(): { id: string; name: string; engine: string; created: string; minutes: number; versions: number }[] {
  if (!existsSync(state.voicesDir)) return [];
  return readdirSync(state.voicesDir).flatMap((n) => {
    try {
      const v = JSON.parse(readFileSync(join(state.voicesDir, n, 'voice.json'), 'utf8')) as VoiceDef;
      const versions = readdirSync(join(state.voicesDir, n)).filter((f) => /^voice\.v\d+\.json$/.test(f)).length;
      return [{ id: v.id, name: v.name, engine: v.engine, created: v.created, minutes: v.minutes, versions }];
    } catch {
      return [];
    }
  });
}

export const isCloneVoice = (voice: string) => /^(clone|ft):/i.test(voice.trim());

/** One sentence (or a few) in a cloned voice: WAV. */
export async function speakClone(text: string, voice: string, opts: { speed?: number } = {}): Promise<{ audio: Buffer; type: string; device: string }> {
  const file = voiceFile(voice);
  if (!existsSync(file)) throw new Error(`There is no voice "${voice}" yet: build it with the HiveBot · Voice trainer workflow`);
  const res = await call('/speak', { text, voiceFile: file, device: voiceEngineSettings().device, ...(opts.speed && { speed: opts.speed }) }, 10 * 60_000);
  return { audio: Buffer.from(await res.arrayBuffer()), type: 'audio/wav', device: res.headers.get('x-voice-device') ?? '' };
}
