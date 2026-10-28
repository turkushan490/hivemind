import type { RunEvent } from '@hivemind/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import { comfyAdapter, txt2imgWorkflow } from '../src/providers/comfyui.js';
import { openaiAdapter } from '../src/providers/openai.js';
import { chain, node } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('image batch', () => {
  it('sets batch_size on the ComfyUI latent (1-8, default 1)', () => {
    const w = (batch?: number) => (txt2imgWorkflow({ model: 'm', prompt: 'x', width: 512, height: 512, batch }, 1) as any)['5'].inputs.batch_size;
    expect(w()).toBe(1);
    expect(w(4)).toBe(4);
    expect(w(99)).toBe(8);
  });

  it('a fake ComfyUI returning 4 images gives 4 pictures, with batch_size 4 in the job', async () => {
    let job: any;
    vi.stubGlobal('WebSocket', class { close() {} } as any);
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/prompt')) {
        job = JSON.parse(String(init!.body));
        return Response.json({ prompt_id: 'p1' });
      }
      if (url.includes('/history/p1'))
        return Response.json({ p1: { status: { status_str: 'success' }, outputs: { '9': { images: [0, 1, 2, 3].map((i) => ({ filename: `hm_${i}.png`, subfolder: '', type: 'output' })) } } } });
      if (url.includes('/view?')) return new Response(PNG);
      return new Response('not found', { status: 404 });
    });
    const images = await comfyAdapter({ id: 'c', kind: 'comfyui', preset: 'comfyui', baseUrl: 'http://comfy.test' }).image!(
      { model: 'm.safetensors', prompt: 'portrait', width: 512, height: 512, batch: 4 },
      new AbortController().signal,
      () => {},
    );
    expect(job.prompt['5'].inputs.batch_size).toBe(4);
    expect(images).toHaveLength(4);
  });

  it('OpenAI-compatible image APIs get n', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      bodies.push(b);
      return Response.json({ data: Array.from({ length: b.n }, () => ({ b64_json: PNG.toString('base64') })) });
    });
    const a = openaiAdapter({ id: 'o', kind: 'openai', preset: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'k' });
    expect(await a.image!({ model: 'gpt-image-1', prompt: 'x', width: 1024, height: 1024, batch: 3 }, new AbortController().signal, () => {})).toHaveLength(3);
    expect(bodies[0].n).toBe(3);
    // DALL·E 3 only makes one per request: three requests.
    bodies.length = 0;
    expect(await a.image!({ model: 'dall-e-3', prompt: 'x', width: 1024, height: 1024, batch: 3 }, new AbortController().signal, () => {})).toHaveLength(3);
    expect(bodies.map((b) => b.n)).toEqual([1, 1, 1]);
  });

  it('the Image block lists every picture as a file link', async () => {
    const saved: string[] = [];
    const provider: ResolvedProvider = {
      local: false,
      hostKey: 'h',
      modelInfo: async () => undefined,
      adapter: {
        listModels: async () => [],
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('no chat');
        },
        image: async (req) => Array.from({ length: req.batch ?? 1 }, () => ({ data: PNG, ext: 'png' })),
      },
    };
    const graph = chain(node('q', 'input'), node('img', 'image', { model: { providerId: 'c', model: 'm' }, batch: 4 }, 'portraits'), node('o', 'output'));
    const events: RunEvent[] = [];
    const r = await runGraph(
      graph,
      'an elf bard',
      {
        resolve: async () => provider,
        emit: (e) => events.push(e as RunEvent),
        services: { saveFile: (path) => (saved.push(path), { path, kind: 'image' }) },
      },
      new AbortController().signal,
    );
    expect(saved).toHaveLength(4);
    expect(r.final!.match(/!\[image\]\(hm-file:/g)).toHaveLength(4);
  });
});
