import type { ModelInfo } from '@hivemind/shared';
import { randomUUID } from 'node:crypto';
import { checkResponse, ProviderError, type GeneratedImage, type ImageRequest, type ProviderAdapter, type ProviderConfig } from './types.js';

/** Sensible defaults per model family: distilled/turbo models want few steps and low guidance. */
function defaults(model: string) {
  if (/z-?image|zimage|turbo|distill|lightning|lcm|hyper|4step|8step/i.test(model)) return { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' };
  return { steps: 25, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras' };
}

/** A plain text-to-image workflow (checkpoint → optional LoRA → prompts → sampler → decode → save). */
export function txt2imgWorkflow(req: ImageRequest, seed: number) {
  const d = defaults(req.model);
  const lora = req.lora ? { '10': { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: req.lora, strength_model: req.loraStrength ?? 1, strength_clip: req.loraStrength ?? 1 } } } : {};
  const model = req.lora ? ['10', 0] : ['4', 0];
  const clip = req.lora ? ['10', 1] : ['4', 1];
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: req.model } },
    ...lora,
    '6': { class_type: 'CLIPTextEncode', inputs: { text: req.prompt, clip } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: req.negative ?? 'lowres, blurry, bad anatomy, watermark, text', clip } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: req.width, height: req.height, batch_size: 1 } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: req.steps ?? d.steps,
        cfg: req.cfg ?? d.cfg,
        sampler_name: d.sampler,
        scheduler: d.scheduler,
        denoise: 1,
        model,
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'hivemind', images: ['8', 0] } },
  };
}

/** Your own ComfyUI: its checkpoints are image models; images are made with a standard workflow. */
export function comfyAdapter(cfg: ProviderConfig): ProviderAdapter & { loras(): Promise<string[]> } {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const options = async (node: string, input: string): Promise<string[]> => {
    const res = await fetch(`${base}/object_info/${node}`);
    await checkResponse(res, `ComfyUI ${node}`);
    const data = (await res.json()) as Record<string, { input: { required: Record<string, [string[]]> } }>;
    return data[node]?.input.required[input]?.[0] ?? [];
  };

  return {
    async listModels(): Promise<ModelInfo[]> {
      const names = await options('CheckpointLoaderSimple', 'ckpt_name');
      return names.map((n) => ({ providerId: cfg.id, model: n, name: n.split('/').pop()!.replace(/\.(safetensors|ckpt|pt)$/i, ''), free: true, kind: 'image' as const }));
    },

    loras: () => options('LoraLoader', 'lora_name'),

    // eslint-disable-next-line require-yield
    async *stream() {
      throw new ProviderError('This is an image model: use it in an Image block');
    },

    async freeMemory() {
      await fetch(`${base}/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
    },

    async image(req, signal, onProgress): Promise<GeneratedImage[]> {
      const clientId = randomUUID();
      // Live step progress over ComfyUI's websocket; the result itself is read from /history.
      let ws: WebSocket | undefined;
      try {
        ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
        ws.onmessage = (m) => {
          if (typeof m.data !== 'string') return;
          const msg = JSON.parse(m.data) as { type: string; data: { value?: number; max?: number } };
          if (msg.type === 'progress' && msg.data.max) onProgress(`Step ${msg.data.value}/${msg.data.max}`);
        };
      } catch {}
      try {
        onProgress('Loading the image model…');
        const res = await fetch(`${base}/prompt`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: txt2imgWorkflow(req, Math.floor(Math.random() * 2 ** 31)), client_id: clientId }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new ProviderError(`ComfyUI refused the job: ${body.slice(0, 400)}`, res.status);
        }
        const { prompt_id } = (await res.json()) as { prompt_id: string };
        const stop = () => fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => {});
        signal.addEventListener('abort', stop, { once: true });
        const t0 = Date.now();
        while (Date.now() - t0 < 15 * 60_000) {
          if (signal.aborted) throw new Error('Cancelled');
          await new Promise((r) => setTimeout(r, 1000));
          const h = (await (await fetch(`${base}/history/${prompt_id}`, { signal })).json()) as Record<
            string,
            { status?: { status_str?: string; messages?: [string, { exception_message?: string }][] }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }
          >;
          const job = h[prompt_id];
          if (!job) continue;
          if (job.status?.status_str === 'error') {
            const why = job.status.messages?.find((m) => m[0] === 'execution_error')?.[1].exception_message ?? 'unknown error';
            throw new ProviderError(`ComfyUI failed: ${why.trim()}`);
          }
          const images = Object.values(job.outputs ?? {}).flatMap((o) => o.images ?? []);
          if (!images.length) continue;
          return Promise.all(
            images.map(async (img) => {
              const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
              const r = await fetch(`${base}/view?${q}`, { signal });
              await checkResponse(r, 'ComfyUI image download');
              return { data: Buffer.from(await r.arrayBuffer()), ext: img.filename.split('.').pop() || 'png' };
            }),
          );
        }
        throw new ProviderError('ComfyUI took longer than 15 minutes');
      } finally {
        ws?.close();
      }
    },
  };
}
