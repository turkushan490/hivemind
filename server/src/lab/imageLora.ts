import type { TrainState } from '@hivemind/shared';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { withHostLock } from '../engine/run.js';
import { safePath } from '../services/files.js';

/**
 * Image LoRAs, trained by your own ComfyUI with its built-in training nodes (no extra trainer in HiveMind): HiveMind
 * writes the pictures and captions into ComfyUI's input folder, queues a training workflow, and copies the finished
 * LoRA into ComfyUI's models/loras, where Image blocks find it. ComfyUI runs it in its own queue, after the work it
 * already has, so nothing of yours is interrupted. Needs ComfyUI's folder mounted into HiveMind (COMFYUI_DIR).
 *
 * Settings follow what works on a 16 GB Tesla T4: 512 px, rank 32, learning rate 1e-4, bf16 (float16 gives NaN),
 * gradient checkpointing and no offloading.
 */

export interface ImageJobSettings {
  kind: 'image';
  checkpoint: string;
  steps: number;
  rank: number;
  learningRate: number;
  resolution: number;
  trigger?: string;
  promptId?: string;
}

/** About 3.8 s per step at 512 px on a T4 (bf16 is emulated there). */
export const IMAGE_SEC_PER_STEP = 3.8;

export const comfyDir = () => process.env.COMFYUI_DIR || config.comfyDir;

export function checkComfyDir() {
  const dir = comfyDir();
  if (!dir || !existsSync(join(dir, 'models')) || !existsSync(join(dir, 'input')))
    throw Object.assign(
      new Error("Image LoRAs need ComfyUI's folder in HiveMind: add a path to the container (the ComfyUI folder with input, output and models) at /comfyui"),
      { statusCode: 400 },
    );
  return dir;
}

/** A checkpoint name as ComfyUI lists it ("irl/epicrealismXL.safetensors"), never a path out of its folder. */
export const validCheckpoint = (name: string) => /^[\w .()+-]+(\/[\w .()+-]+)*\.(safetensors|ckpt)$/i.test(name) && !name.split('/').includes('..');

/** The LoRA's file name: the model name made safe for a file. */
const loraName = (name: string) => name.replace(/[^a-z0-9._-]+/gi, '-');

/** Writes the training pictures (and their captions, trigger word first) into ComfyUI's input folder. */
export function writeImageDataset(id: string, datasetId: string, trigger?: string): number {
  const dir = join(checkComfyDir(), 'input', 'hivemind', id);
  mkdirSync(dir, { recursive: true });
  const rows = db.prepare("SELECT output, files FROM dataset_items WHERE dataset_id = ? AND (review IS NULL OR review = 'accepted') AND files IS NOT NULL ORDER BY id").all(datasetId) as {
    output: string;
    files: string;
  }[];
  let n = 0;
  for (const r of rows) {
    const file = (JSON.parse(r.files) as string[])[0];
    let src: string;
    try {
      src = safePath(file);
    } catch {
      continue;
    }
    if (!existsSync(src)) continue;
    n++;
    const stem = `img_${String(n).padStart(4, '0')}`;
    copyFileSync(src, join(dir, `${stem}${extname(src).toLowerCase()}`));
    const caption = [trigger?.trim(), r.output.trim()].filter(Boolean).join(', ');
    writeFileSync(join(dir, `${stem}.txt`), caption);
  }
  return n;
}

/** The ComfyUI workflow (API format), filled in from ComfyUI's own node list so a newer ComfyUI's extra inputs get their defaults. */
async function workflow(base: string, id: string, name: string, s: ImageJobSettings) {
  const res = await fetch(`${base}/object_info/TrainLoraNode`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ComfyUI has no LoRA training nodes (HTTP ${res.status}): update ComfyUI`);
  const info = (await res.json()) as { TrainLoraNode?: { input: { required?: Record<string, [unknown, { default?: unknown }?]>; optional?: Record<string, unknown> } } };
  const req = info.TrainLoraNode?.input.required;
  if (!req) throw new Error('ComfyUI has no TrainLoraNode: update ComfyUI');
  const train: Record<string, unknown> = {};
  for (const [k, [type, opts]] of Object.entries(req)) {
    if (Array.isArray(type)) train[k] = opts?.default ?? type[0];
    else if (opts?.default !== undefined) train[k] = opts.default;
  }
  Object.assign(train, {
    model: ['1', 0],
    latents: ['5', 0],
    positive: ['5', 1],
    batch_size: 1,
    grad_accumulation_steps: 1,
    steps: s.steps,
    learning_rate: s.learningRate,
    rank: s.rank,
    optimizer: 'AdamW',
    loss_function: 'MSE',
    seed: 0,
    training_dtype: 'bf16',
    lora_dtype: 'bf16',
    algorithm: 'LoRA',
    gradient_checkpointing: true,
    checkpoint_depth: 2,
    offloading: false,
    existing_lora: '[None]',
  });
  for (const k of Object.keys(train)) if (!(k in req)) delete train[k];
  const px = s.resolution;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: s.checkpoint } },
    '2': { class_type: 'LoadImageTextDataSetFromFolder', inputs: { folder: `hivemind/${id}` } },
    '3': { class_type: 'ResizeImagesByShorterEdge', inputs: { images: ['2', 0], shorter_edge: px } },
    '4': { class_type: 'CenterCropImages', inputs: { images: ['3', 0], width: px, height: px } },
    '5': { class_type: 'MakeTrainingDataset', inputs: { images: ['4', 0], vae: ['1', 2], clip: ['1', 1], texts: ['2', 1] } },
    '6': { class_type: 'TrainLoraNode', inputs: train },
    '7': { class_type: 'SaveLoRA', inputs: { lora: ['6', 0], prefix: `loras/hivemind/${loraName(name)}`, steps: ['6', 2] } },
  };
}

type Update = (id: string, state: TrainState, progress?: Record<string, unknown>, error?: string) => unknown;

interface ComfyJob {
  id: string;
  name: string;
  settings: string;
  datasetId: string;
  comfyUrl: string;
  hostKey: string;
  freeGpu: () => Promise<void>;
  save: (patch: Record<string, unknown>) => void;
}

const pollMs = () => Number(process.env.TRAIN_POLL_MS) || 5000;

/** Queues the training in ComfyUI (once its queue is empty) and follows it until the LoRA is in models/loras. */
export async function runComfyJob(job: ComfyJob, mode: 'new' | 'follow' | 'resume', signal: AbortSignal, update: Update) {
  const base = job.comfyUrl.replace(/\/+$/, '');
  let s = JSON.parse(job.settings) as ImageJobSettings;
  const comfy = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`ComfyUI ${path} answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return res.json() as Promise<any>;
  };
  const cancel = async () => {
    if (!s.promptId) return;
    const q = await comfy('/queue').catch(() => ({}));
    if (q.queue_running?.some((r: unknown[]) => r[1] === s.promptId)) await comfy('/interrupt', { method: 'POST', body: '{}' }).catch(() => {});
    else await comfy('/queue', { method: 'POST', body: JSON.stringify({ delete: [s.promptId] }) }).catch(() => {});
  };

  if (!s.promptId || mode !== 'follow') {
    // Wait until ComfyUI's queue is empty: your own images and videos go first.
    for (;;) {
      if (signal.aborted) return update(job.id, 'cancelled', { note: 'Cancelled while waiting for ComfyUI' });
      const q = await comfy('/queue');
      const busy = (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
      if (!busy) break;
      update(job.id, 'waiting', { note: `ComfyUI is busy (${busy} job${busy === 1 ? '' : 's'} in its queue) — training starts when it's free` });
      await new Promise((r) => setTimeout(r, pollMs() * 6));
    }
  }

  return withHostLock(job.hostKey, async () => {
    if (!s.promptId || mode !== 'follow') {
      update(job.id, 'starting', { note: 'Writing the pictures into ComfyUI and queueing the training' });
      await job.freeGpu().catch(() => {});
      const n = writeImageDataset(job.id, job.datasetId, s.trigger);
      if (n === 0) throw new Error('None of the pictures in this dataset are in the files folder any more');
      const r = await comfy('/prompt', { method: 'POST', body: JSON.stringify({ prompt: await workflow(base, job.id, job.name, s) }) });
      if (r.node_errors && Object.keys(r.node_errors).length) throw new Error(`ComfyUI refused the training workflow: ${JSON.stringify(r.node_errors).slice(0, 400)}`);
      s = { ...s, promptId: r.prompt_id };
      job.save({ promptId: r.prompt_id });
    }
    const t0 = Date.now();
    for (;;) {
      if (signal.aborted) {
        await cancel();
        return update(job.id, 'cancelled', { note: 'Cancelled (stopped in ComfyUI)' });
      }
      const h = (await comfy(`/history/${s.promptId}`).catch(() => ({}))) as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: [string, any][] } }>;
      const done = h[s.promptId!];
      if (done?.status?.status_str === 'error') {
        const why = done.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message ?? 'unknown error';
        throw new Error(`ComfyUI training failed: ${String(why).trim().slice(0, 500)}`);
      }
      if (done?.status?.completed) break;
      const elapsed = (Date.now() - t0) / 1000;
      const step = Math.min(s.steps, Math.floor(elapsed / IMAGE_SEC_PER_STEP));
      update(job.id, 'training', { step, totalSteps: s.steps, etaS: Math.max(0, Math.round((s.steps - step) * IMAGE_SEC_PER_STEP)), note: 'Training in ComfyUI (progress is estimated)' });
      await new Promise((r) => setTimeout(r, pollMs() * 6));
    }
    update(job.id, 'importing', { note: 'Putting the LoRA into ComfyUI models/loras' });
    const dir = comfyDir();
    const outDir = join(dir, 'output', 'loras', 'hivemind');
    const stem = loraName(job.name);
    const made = existsSync(outDir)
      ? readdirSync(outDir)
          .filter((f) => f.startsWith(stem) && f.endsWith('.safetensors'))
          .map((f) => join(outDir, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      : undefined;
    if (!made) throw new Error(`ComfyUI finished, but the LoRA is not in ${outDir}`);
    const target = join(dir, 'models', 'loras', 'hivemind');
    mkdirSync(target, { recursive: true });
    copyFileSync(made, join(target, `${stem}.safetensors`));
    rmSync(join(dir, 'input', 'hivemind', job.id), { recursive: true, force: true });
    job.save({ lora: `hivemind/${stem}.safetensors` });
    return update(job.id, 'done', { step: s.steps, totalSteps: s.steps, etaS: 0, note: `Ready: pick hivemind/${stem}.safetensors as the LoRA in an Image block` });
  });
}

const PICTURE = /\.(png|jpe?g|webp)$/i;

/**
 * Adds every picture in a folder of the files folder to an image dataset; a .txt file with the same name is its
 * caption. Adding the folder again updates the pictures instead of doubling them.
 */
export function picturesFromFolder(folder: string): { file: string; caption: string }[] {
  const dir = safePath(folder.replace(/\/+$/, ''));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw Object.assign(new Error(`No folder "${folder}" in Files`), { statusCode: 404 });
  const rel = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return readdirSync(dir)
    .filter((f) => PICTURE.test(f))
    .sort()
    .map((f) => {
      const txt = join(dir, f.replace(/\.[^.]+$/, '.txt'));
      return { file: `${rel}/${f}`, caption: existsSync(txt) ? readFileSync(txt, 'utf8').trim() : '' };
    });
}

/**
 * Captions pictures that have none with a vision model in Ollama (e.g. gemma4 or qwen3.5), a few per call so the
 * page can show progress. Returns how many were captioned and how many still have no caption.
 */
export async function captionPictures(datasetId: string, opts: { ollamaUrl: string; model: string; max?: number }): Promise<{ captioned: number; left: number }> {
  const todo = db.prepare("SELECT id, files FROM dataset_items WHERE dataset_id = ? AND files IS NOT NULL AND trim(output) = '' ORDER BY id LIMIT ?").all(datasetId, opts.max ?? 3) as {
    id: number;
    files: string;
  }[];
  let captioned = 0;
  for (const it of todo) {
    const file = safePath((JSON.parse(it.files) as string[])[0]);
    const res = await fetch(`${opts.ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: 160 },
        messages: [
          {
            role: 'user',
            content:
              'Write a caption for training an image model on this picture: one sentence naming the subject, clothing, pose, setting, lighting and style. Only the caption, no preamble.',
            images: [readFileSync(file).toString('base64')],
          },
        ],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: { content?: string }; error?: string };
    if (!res.ok || data.error) throw new Error(`Ollama could not caption with ${opts.model}: ${data.error ?? `HTTP ${res.status}`} (pick a model that can see pictures)`);
    const caption = (data.message?.content ?? '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ');
    if (!caption) continue;
    db.prepare('UPDATE dataset_items SET output = ? WHERE id = ?').run(caption, it.id);
    captioned++;
  }
  const left = (db.prepare("SELECT COUNT(*) AS n FROM dataset_items WHERE dataset_id = ? AND files IS NOT NULL AND trim(output) = ''").get(datasetId) as { n: number }).n;
  return { captioned, left };
}
