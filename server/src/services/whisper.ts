// Built-in local speech-to-text with whisper.cpp — the same engine in the Docker image and the Windows .exe.
// HiveMind ships a whisper binary (Docker: /opt/whisper; exe: unpacked next to the data dir), downloads the ggml model
// files on demand (the owner picks which one to use, like the model library), and runs it per transcription.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { config } from '../config.js';
import { newId } from '../crypto.js';

/** One Whisper model the owner can download and use. Sizes are the ggml download size. */
export interface WhisperModel {
  id: string;
  name: string;
  /** Rough download size, for the UI. */
  sizeMb: number;
  note: string;
  url: string;
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
/** The models offered in the GUI (download any, use one at a time). ".en" models are English-only and a bit sharper on English. */
export const WHISPER_MODELS: WhisperModel[] = [
  { id: 'tiny', name: 'Tiny', sizeMb: 75, note: 'Fastest, lowest quality. Many languages.', url: `${HF}/ggml-tiny.bin` },
  { id: 'tiny.en', name: 'Tiny (English)', sizeMb: 75, note: 'Fastest, English only.', url: `${HF}/ggml-tiny.en.bin` },
  { id: 'base', name: 'Base', sizeMb: 142, note: 'Fast, good for clear speech. Many languages.', url: `${HF}/ggml-base.bin` },
  { id: 'base.en', name: 'Base (English)', sizeMb: 142, note: 'Fast, English only.', url: `${HF}/ggml-base.en.bin` },
  { id: 'small', name: 'Small', sizeMb: 466, note: 'More accurate, still OK on CPU. Many languages.', url: `${HF}/ggml-small.bin` },
  { id: 'small.en', name: 'Small (English)', sizeMb: 466, note: 'More accurate, English only.', url: `${HF}/ggml-small.en.bin` },
  { id: 'medium', name: 'Medium', sizeMb: 1530, note: 'Best accuracy that still runs on CPU. Slower, big download.', url: `${HF}/ggml-medium.bin` },
  { id: 'medium.en', name: 'Medium (English)', sizeMb: 1530, note: 'Best English accuracy on CPU. Slower, big download.', url: `${HF}/ggml-medium.en.bin` },
];

const here = dirname(fileURLToPath(import.meta.url));
/** Where the models live (per install), and the temp dir for a request's wav/json. */
const modelsDir = () => join(config.dataDir, 'whisper', 'models');
const modelFile = (id: string) => join(modelsDir(), `ggml-${id}.bin`);

/**
 * The whisper binary: WHISPER_BIN, else the Docker image's /opt/whisper, else next to the exe's data dir (unpacked by
 * exe-env), else a local build. Undefined when no build ships with this install.
 */
export function whisperBin(): string | undefined {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const candidates = [
    process.env.WHISPER_BIN,
    join('/opt/whisper', exe),
    join(config.dataDir, 'whisper', exe),
    resolve(here, '../whisper', exe),
    resolve(here, '../../whisper', exe),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p));
}

/** Is the built-in engine present in this build (a binary ships here)? */
export const whisperAvailable = () => !!whisperBin();

const downloads = new Map<string, { got: number; total: number }>();

/** Which models are downloaded, which is downloading (with progress), and whether the engine ships here. */
export function whisperStatus(selected?: string) {
  return {
    available: whisperAvailable(),
    models: WHISPER_MODELS.map((m) => ({
      ...m,
      downloaded: existsSync(modelFile(m.id)),
      ...(downloads.has(m.id) && { downloading: downloads.get(m.id)! }),
      selected: m.id === selected,
    })),
  };
}

/** Downloads a model file into the data dir (to a .part, then renamed), with progress for the status endpoint. */
export async function downloadWhisperModel(id: string): Promise<void> {
  const m = WHISPER_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`No Whisper model "${id}"`);
  if (existsSync(modelFile(id)) || downloads.has(id)) return;
  mkdirSync(modelsDir(), { recursive: true });
  const part = `${modelFile(id)}.part`;
  downloads.set(id, { got: 0, total: m.sizeMb * 1024 * 1024 });
  try {
    const res = await fetch(m.url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${m.name}`);
    const total = Number(res.headers.get('content-length')) || m.sizeMb * 1024 * 1024;
    let got = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (c: Buffer) => {
      got += c.length;
      downloads.set(id, { got, total });
    });
    await pipeline(body, createWriteStream(part));
    if (statSync(part).size < m.sizeMb * 1024 * 1024 * 0.5) throw new Error('the download was cut short');
    renameSync(part, modelFile(id));
  } catch (err) {
    try {
      rmSync(part, { force: true });
    } catch {}
    throw err;
  } finally {
    downloads.delete(id);
  }
}

/** Deletes a downloaded model. */
export function deleteWhisperModel(id: string): void {
  try {
    rmSync(modelFile(id), { force: true });
  } catch {}
}

/**
 * Transcribes a 16 kHz mono WAV (the browser resamples before upload) with the chosen model. Returns the text.
 * Spawns whisper-cli with a per-request output file, reads its JSON, cleans up.
 */
export async function whisperTranscribe(wav: Buffer, modelId: string, language?: string): Promise<string> {
  const bin = whisperBin();
  if (!bin) throw new Error('The built-in speech engine is not in this build');
  if (!existsSync(modelFile(modelId))) throw new Error(`The "${modelId}" model is not downloaded yet (Settings → Voice)`);
  const base = join(tmpdir(), `hm-stt-${newId()}`);
  const wavPath = `${base}.wav`;
  const jsonPath = `${base}.json`;
  mkdirSync(dirname(wavPath), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  // whisper.cpp reads only WAV. The browser sends one, but the robot, Home Assistant and /v1 clients may send webm,
  // ogg, mp3 or m4a: ffmpeg turns those into a 16 kHz mono WAV first.
  const isWav = wav.length > 12 && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 8, 12) === 'WAVE';
  const inPath = isWav ? wavPath : `${base}.in`;
  writeFileSync(inPath, wav);
  const args = ['-m', modelFile(modelId), '-f', wavPath, '-oj', '-of', base, '-nt', '-l', language || 'auto'];
  try {
    if (!isWav) await toWav(inPath, wavPath);
    const errText = await runBin(bin, args, 120_000);
    // whisper-cli ends with exit code 0 even when it could not read the audio: then there is no JSON.
    if (!existsSync(jsonPath)) {
      const why = errText.split('\n').filter((l) => /^error/i.test(l.trim())).join(' ').trim();
      throw new Error(`Whisper could not read the recording${why ? `: ${why.slice(0, 300)}` : ''}`);
    }
    const out = JSON.parse(readFileSync(jsonPath, 'utf8')) as { transcription?: { text?: string }[] };
    return (out.transcription ?? []).map((t) => t.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
  } finally {
    for (const f of [wavPath, jsonPath, `${base}.in`]) {
      try {
        rmSync(f, { force: true });
      } catch {}
    }
  }
}

/** Any audio file → 16 kHz mono 16-bit WAV with ffmpeg (in the Docker image; the exe needs ffmpeg on the PATH). */
async function toWav(src: string, dest: string): Promise<void> {
  try {
    await runBin('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', dest], 60_000);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('This recording is not a WAV file, and ffmpeg is not installed to convert it — send a 16 kHz WAV');
    throw new Error(`Could not convert the recording to WAV: ${(err as Error).message.replace(/^whisper /, 'ffmpeg ')}`);
  }
}

/** Runs the binary, failing on a non-zero exit or a timeout; returns what it wrote to stderr. */
function runBin(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve_, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (c: Buffer) => (err += c.toString()));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`whisper timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve_(err);
      else reject(new Error(`whisper exited with code ${code}${err ? `: ${err.replace(/\s+/g, ' ').slice(-300)}` : ''}`));
    });
  });
}
