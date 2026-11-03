import { describe, expect, it, vi } from 'vitest';
import { comfyAdapter, txt2imgWorkflow } from '../src/providers/comfyui.js';

describe('ComfyUI workflow', () => {
  it('uses SDXL defaults, and few steps for turbo / Z-Image models', () => {
    const sdxl = txt2imgWorkflow({ model: 'irl/epicrealismXL.safetensors', prompt: 'a cat', width: 1024, height: 1024 }, 1) as any;
    expect(sdxl['3'].inputs).toMatchObject({ steps: 25, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras' });
    expect(sdxl['10']).toBeUndefined();
    const turbo = txt2imgWorkflow({ model: 'zimaga/z-anime-distill-4step-aio-fp8.safetensors', prompt: 'a cat', width: 768, height: 768 }, 1) as any;
    expect(turbo['3'].inputs).toMatchObject({ steps: 8, cfg: 1 });
    expect(turbo['5'].inputs).toMatchObject({ width: 768, height: 768 });
  });

  it('puts a LoRA between the checkpoint and the prompts', () => {
    const w = txt2imgWorkflow({ model: 'm.safetensors', prompt: 'x', width: 512, height: 512, lora: 'style.safetensors', loraStrength: 0.7 }, 1) as any;
    expect(w['10'].inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0.7 });
    expect(w['3'].inputs.model).toEqual(['10', 0]);
    expect(w['6'].inputs.clip).toEqual(['10', 1]);
  });

  it('uses PreviewImage (ComfyUI temp) unless the keep-a-copy option is on', () => {
    const req = { model: 'm.safetensors', prompt: 'x', width: 512, height: 512 };
    expect((txt2imgWorkflow(req, 1) as any)['9']).toEqual({ class_type: 'PreviewImage', inputs: { images: ['8', 0] } });
    expect((txt2imgWorkflow(req, 1, true) as any)['9']).toEqual({ class_type: 'SaveImage', inputs: { filename_prefix: 'hivemind', images: ['8', 0] } });
  });

  it('the adapter sends PreviewImage, and SaveImage when the provider keeps images', async () => {
    const jobs: any[] = [];
    vi.stubGlobal('WebSocket', class { close() {} } as any);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/prompt')) {
        jobs.push(JSON.parse(String(init!.body)).prompt);
        return Response.json({ prompt_id: 'p1' });
      }
      if (url.includes('/history/p1')) return Response.json({ p1: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'hm_1.png', subfolder: '', type: 'temp' }] } } } });
      if (url.includes('/view?')) return new Response(Buffer.from('png'));
      return new Response('', { status: 404 });
    });
    const make = (keepImages?: boolean) =>
      comfyAdapter({ id: 'c', kind: 'comfyui', preset: 'comfyui', baseUrl: 'http://comfy.test', keepImages }).image!({ model: 'm', prompt: 'x', width: 512, height: 512 }, new AbortController().signal, () => {});
    expect(await make()).toHaveLength(1);
    await make(true);
    expect(jobs.map((j) => j['9'].class_type)).toEqual(['PreviewImage', 'SaveImage']);
    vi.unstubAllGlobals();
  });
});
