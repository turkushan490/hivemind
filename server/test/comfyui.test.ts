import { describe, expect, it } from 'vitest';
import { txt2imgWorkflow } from '../src/providers/comfyui.js';

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
});
