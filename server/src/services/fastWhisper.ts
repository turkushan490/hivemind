// Fast built-in speech to text with faster-whisper (MIT) in HiveMind's voice worker: the model stays loaded between
// recordings and runs on the GPU when it has room (CPU int8 otherwise), so bigger, more accurate models (large-v3-turbo)
// are usable. whisper.cpp (whisper.ts) stays as the engine for the Windows .exe and the fallback.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { newId } from '../crypto.js';
import { logError } from '../errors.js';
import { appendLog } from '../logfile.js';
import { fastSttAvailable, voiceEngineSettings, voiceWorkerStatus, workerTranscribe } from './voiceTraining.js';

/** Hard limit on one transcription once the model is loaded (STT_TIMEOUT_S, like whisper.cpp). */
const STT_TIMEOUT_MS = Math.max(5, Number(process.env.STT_TIMEOUT_S) || 20) * 1000;
/** The first recording also starts the worker and loads the model: that gets more time, once. */
const LOAD_TIMEOUT_MS = 180_000;

export interface FastWhisperModel {
  id: string;
  name: string;
  /** Hugging Face repository with the CTranslate2 files. */
  repo: string;
  sizeMb: number;
  note: string;
  /** Recommended (shown first in the UI). */
  pick?: boolean;
}

/** The models offered in Settings → Voice (download any, use one at a time). */
export const FAST_WHISPER_MODELS: FastWhisperModel[] = [
  { id: 'large-v3-turbo', name: 'Large v3 Turbo', repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', sizeMb: 1620, note: 'Best choice with a GPU: near large-v3 accuracy, many languages (Dutch too), fast.', pick: true },
  { id: 'small', name: 'Small', repo: 'Systran/faster-whisper-small', sizeMb: 485, note: 'Good and quick on the CPU. Many languages.' },
  { id: 'medium', name: 'Medium', repo: 'Systran/faster-whisper-medium', sizeMb: 1530, note: 'More accurate; fine on the GPU, slow on the CPU. Many languages.' },
  { id: 'large-v3', name: 'Large v3', repo: 'Systran/faster-whisper-large-v3', sizeMb: 3090, note: 'Most accurate, needs about 4 GB of GPU memory. Many languages.' },
  { id: 'distil-large-v3', name: 'Distil Large v3 (English)', repo: 'Systran/faster-distil-whisper-large-v3', sizeMb: 1510, note: 'Large-v3 quality at turbo speed, English only.' },
  { id: 'base', name: 'Base', repo: 'Systran/faster-whisper-base', sizeMb: 145, note: 'Small and fast, for clear speech. Many languages.' },
  { id: 'tiny', name: 'Tiny', repo: 'Systran/faster-whisper-tiny', sizeMb: 75, note: 'Fastest, lowest quality. Many languages.' },
];

/** Hugging Face, swappable in tests. */
const hub = { base: 'https://huggingface.co' };
export const configureFastWhisper = (o: Partial<typeof hub>) => Object.assign(hub, o);

const modelsDir = () => join(config.dataDir, 'whisper', 'fast');
const modelDir = (id: string) => join(modelsDir(), id);
/** A model counts as downloaded once every file arrived (the folder is renamed from .part at the end). */
const isDownloaded = (id: string) => existsSync(join(modelDir(id), 'model.bin')) && existsSync(join(modelDir(id), 'config.json'));

const downloads = new Map<string, { got: number; total: number }>();

export function fastWhisperStatus(selected?: string) {
  return {
    available: fastSttAvailable(),
    models: FAST_WHISPER_MODELS.map((m) => ({
      ...m,
      downloaded: isDownloaded(m.id),
      ...(downloads.has(m.id) && { downloading: downloads.get(m.id)! }),
      selected: m.id === selected,
    })),
  };
}

export const fastWhisperReady = (id: string) => fastSttAvailable() && isDownloaded(id);

/** Downloads every file of the model's repository into data/whisper/fast/<id> (via <id>.part), with progress. */
export async function downloadFastWhisperModel(id: string): Promise<void> {
  const m = FAST_WHISPER_MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`No fast Whisper model "${id}"`);
  if (isDownloaded(id) || downloads.has(id)) return;
  const part = `${modelDir(id)}.part`;
  downloads.set(id, { got: 0, total: m.sizeMb * 1024 * 1024 });
  try {
    const list = await fetch(`${hub.base}/api/models/${m.repo}`);
    if (!list.ok) throw new Error(`Hugging Face answered HTTP ${list.status} for ${m.repo}`);
    const files = (((await list.json()) as { siblings?: { rfilename: string }[] }).siblings ?? [])
      .map((f) => f.rfilename)
      .filter((f) => !f.includes('/') && !/^\.|\.md$/i.test(f));
    if (!files.includes('model.bin')) throw new Error(`${m.repo} has no model.bin`);
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    let got = 0;
    for (const f of files) {
      const res = await fetch(`${hub.base}/${m.repo}/resolve/main/${encodeURIComponent(f)}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${f}`);
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on('data', (c: Buffer) => {
        got += c.length;
        downloads.set(id, { got, total: Math.max(got, m.sizeMb * 1024 * 1024) });
      });
      await pipeline(body, createWriteStream(join(part, f)));
      const want = Number(res.headers.get('content-length'));
      if (want && statSync(join(part, f)).size !== want) throw new Error(`the download of ${f} was cut short`);
    }
    rmSync(modelDir(id), { recursive: true, force: true });
    renameSync(part, modelDir(id));
  } catch (err) {
    rmSync(part, { recursive: true, force: true });
    throw err;
  } finally {
    downloads.delete(id);
  }
}

export function deleteFastWhisperModel(id: string): void {
  if (!FAST_WHISPER_MODELS.some((m) => m.id === id)) return;
  rmSync(modelDir(id), { recursive: true, force: true });
}

/** Transcribes any audio with the chosen model in the voice worker. Returns the text. */
export async function fastWhisperTranscribe(audio: Buffer, modelId: string, language?: string): Promise<string> {
  if (!fastSttAvailable()) throw new Error('The fast speech engine is not in this build');
  if (!isDownloaded(modelId)) throw new Error(`The "${modelId}" model is not downloaded yet (Settings → Voice)`);
  const warm = (await voiceWorkerStatus())?.stt === modelId;
  const file = join(tmpdir(), `hm-fstt-${newId()}`);
  writeFileSync(file, audio);
  const t0 = Date.now();
  try {
    let r: Awaited<ReturnType<typeof workerTranscribe>>;
    try {
      r = await workerTranscribe({ file, model: modelDir(modelId), name: modelId, language, device: voiceEngineSettings().device }, warm ? STT_TIMEOUT_MS : LOAD_TIMEOUT_MS);
    } catch (err) {
      if (/took too long|TimeoutError|aborted/i.test((err as Error).message)) throw new Error(`Speech to text took too long (over ${Math.round((warm ? STT_TIMEOUT_MS : LOAD_TIMEOUT_MS) / 1000)} s) — say it again`);
      throw err;
    }
    const totalMs = Date.now() - t0;
    const line = `STT fast ${modelId}: ${r.seconds.toFixed(1)}s audio, ${r.text.length} letters, engine ${r.ms}ms, total ${totalMs}ms (${r.device}${warm ? '' : ', model loaded first'})`;
    appendLog('voice', line);
    // The GPU was meant to be used but failed: a Problem, so a missing CUDA library doesn't stay a silent slowdown.
    if (r.note) logError({ source: 'voice', message: `Fast speech to text: ${r.note}`, detail: line });
    else if (warm && totalMs > 10_000) logError({ source: 'voice', message: `Speech to text was slow: ${(totalMs / 1000).toFixed(1)} s`, detail: `${line}. A busy CPU or GPU, or a big model on the CPU, slows it down; a smaller model is faster.` });
    return r.text.replace(/\s+/g, ' ').trim();
  } finally {
    rmSync(file, { force: true });
  }
}
