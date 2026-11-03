import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runGraph, type ResolvedProvider } from '../src/engine/run.js';
import { bearer, chain, edge, fakeDecider, fakeProvider, node, runAndWait, testApp } from './helpers.js';

/**
 * Settings → Access: what a user and an API token may see and use, checked in the lists and on the server
 * (start of a run, and every call during it).
 */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let runScheduled: typeof import('../src/api/schedules.js').runScheduled;

const CLOUD = ['gpt-x', 'gpt-y'];
const CHECKPOINTS = ['sdxl.safetensors', 'dnd/hero.safetensors'];
const LORAS = ['dnd/elf.safetensors', 'dnd\\orc.safetensors', 'other/x.safetensors'];

/** Fake providers: a cloud API, Ollama and ComfyUI. */
function stubProviders() {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url === 'https://api.cloud.test/v1/models') return Response.json({ data: CLOUD.map((id) => ({ id })) });
    if (url === 'http://gpu.test:11434/api/tags') return Response.json({ models: [{ name: 'llama3:latest', size: 4e9 }, { name: 'qwen3:4b', size: 3e9 }] });
    if (url === 'http://gpu.test:11434/api/ps') return Response.json({ models: [{ name: 'llama3:latest', size: 4e9, size_vram: 4e9 }] });
    if (url === 'http://gpu.test:8188/object_info/CheckpointLoaderSimple') return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [CHECKPOINTS] } } } });
    if (url === 'http://gpu.test:8188/object_info/LoraLoader') return Response.json({ LoraLoader: { input: { required: { lora_name: [LORAS] } } } });
    return new Response('not found', { status: 404 });
  });
}

const as = (who: string) => ({ headers: bearer(who) });
const get = (url: string, who: string) => app.inject({ method: 'GET', url, ...as(who) });
const post = (url: string, who: string, payload: object) => app.inject({ method: 'POST', url, ...as(who), payload });
const put = (url: string, who: string, payload: object) => app.inject({ method: 'PUT', url, ...as(who), payload });

const ollamaGraph = (): CanvasGraph => chain(node('q', 'input'), node('m', 'llm', { model: { providerId: 'ollama', model: 'llama3:latest' } }), node('o', 'output'));
const echo = (): CanvasGraph => chain(node('q', 'input'), node('t', 'template', { prompt: 'echo {{question}}' }), node('o', 'output'));

beforeAll(async () => {
  ({ app, db } = await testApp('access', [
    ['u1', 'admin'],
    ['u2', 'user'],
    ['u3', 'user'],
  ]));
  ({ runScheduled } = await import('../src/api/schedules.js'));
  stubProviders();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, api_key_enc, local) VALUES ('cloud', 'openai', 'openai', 'Cloud', 'https://api.cloud.test/v1', NULL, 0)").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('comfy', 'comfyui', 'comfyui', 'ComfyUI', 'http://gpu.test:8188', 1)").run();
  // Basic: the cloud provider with all its models, nothing local (as the migration makes it for existing installs).
  expect((await put('/api/access/profiles/basic', 'u1', { providers: { cloud: { models: 'all' } } })).statusCode).toBe(200);
  expect((await put('/api/canvases/admin-ollama', 'u1', { name: 'Admin Ollama', shared: true, ...ollamaGraph() })).statusCode).toBe(200);
});
afterAll(() => {
  vi.unstubAllGlobals();
  return app?.close();
});

describe('lists show only what is allowed', () => {
  it('a user with Basic sees no ComfyUI, no Ollama and no LoRAs in any list', async () => {
    const providers = (await get('/api/providers', 'u2')).json() as { id: string }[];
    expect(providers.map((p) => p.id)).toEqual(['cloud']);
    const models = (await get('/api/models', 'u2')).json() as { models: { providerId: string; model: string }[] };
    expect(models.models.map((m) => `${m.providerId}|${m.model}`)).toEqual(['cloud|gpt-x', 'cloud|gpt-y']);
    expect((await get('/api/providers/ollama/models', 'u2')).statusCode).toBe(404);
    expect((await get('/api/providers/comfy/models', 'u2')).statusCode).toBe(404);
    expect((await get('/api/providers/comfy/loras', 'u2')).statusCode).toBe(404);
    expect((await get('/api/memory', 'u2')).json()).toEqual([]);
  });

  it('an admin keeps everything', async () => {
    const providers = (await get('/api/providers', 'u1')).json() as { id: string }[];
    expect(providers.map((p) => p.id).sort()).toEqual(['cloud', 'comfy', 'ollama']);
    expect((await get('/api/providers/comfy/loras', 'u1')).json()).toEqual(LORAS);
    const memory = (await get('/api/memory', 'u1')).json() as { providerId: string; models: { model: string }[] }[];
    expect(memory.find((m) => m.providerId === 'ollama')?.models.map((m) => m.model)).toEqual(['llama3:latest']);
  });

  it('a profile with chosen models and a LoRA folder glob lists only those', async () => {
    const res = await post('/api/access/profiles', 'u1', {
      name: 'Players',
      providers: { cloud: { models: ['gpt-x'] }, comfy: { models: ['dnd/*'], loras: ['dnd/*'] } },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;
    expect((await put(`/api/access/users/u3`, 'u1', { profileId: id })).statusCode).toBe(200);
    expect(((await get('/api/providers', 'u3')).json() as { id: string }[]).map((p) => p.id)).toEqual(['cloud', 'comfy']);
    const models = (await get('/api/models', 'u3')).json() as { models: { providerId: string; model: string }[] };
    expect(models.models.map((m) => `${m.providerId}|${m.model}`)).toEqual(['cloud|gpt-x', 'comfy|dnd/hero.safetensors']);
    // The Windows-style "dnd\orc" is in the folder too.
    expect((await get('/api/providers/comfy/loras', 'u3')).json()).toEqual(['dnd/elf.safetensors', 'dnd\\orc.safetensors']);
  });
});

describe('runs are checked on the server', () => {
  it('a disallowed model in a block is refused with 403', async () => {
    const res = await post('/api/runs', 'u2', { question: 'hi', graph: ollamaGraph() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("You can't use llama3:latest (ask the admin to add it to your access)");
  });

  it('a disallowed model in the models override is refused with 403', async () => {
    const res = await post('/api/runs', 'u2', { question: 'hi', graph: chain(node('q', 'input'), node('m', 'llm', { model: { providerId: 'cloud', model: 'gpt-x' } }), node('o', 'output')), models: { m: { providerId: 'ollama', model: 'qwen3:4b' } } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/You can't use qwen3:4b/);
  });

  it('a shared canvas of an admin is checked with the caller’s access', async () => {
    const res = await post('/api/runs', 'u2', { question: 'hi', canvasId: 'admin-ollama' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/You can't use llama3:latest/);
    const batch = await post('/api/batch', 'u2', { canvasId: 'admin-ollama', questions: ['a'], times: 1 });
    expect(batch.statusCode).toBe(403);
  });

  it('through /v1 too', async () => {
    const res = await post('/v1/chat/completions', 'u2', { model: 'admin-ollama', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/You can't use llama3:latest/);
  });

  it('and through a schedule', async () => {
    expect(() => runScheduled({ canvasId: 'admin-ollama', ownerId: 'u2', time: '03:00' })).toThrow(/You can't use llama3:latest/);
  });

  it('an Image block with a disallowed LoRA is refused, an allowed one is not', async () => {
    const image = (lora: string) => chain(node('q', 'input'), node('i', 'image', { model: { providerId: 'comfy', model: 'dnd/hero.safetensors' }, lora }), node('o', 'output'));
    const bad = await post('/api/runs', 'u3', { question: 'an elf', graph: image('other/x.safetensors') });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toMatch(/You can't use the LoRA other\/x\.safetensors/);
    const res = await post('/api/runs', 'u3', { question: 'an elf', graph: image('dnd/elf.safetensors') });
    expect(res.statusCode).toBe(200);
  });

  it('an admin may run anything', async () => {
    const res = await post('/api/runs', 'u1', { question: 'hi', canvasId: 'admin-ollama' });
    expect(res.statusCode).toBe(200);
  });
});

describe('API tokens with a profile of their own', () => {
  it('get only what both the token and its user allow', async () => {
    // u3 (Players: cloud gpt-x, comfy dnd/*); the token's own profile allows cloud gpt-x and gpt-y and Ollama.
    const own = (await post('/api/access/profiles', 'u1', { name: 'Wide', providers: { cloud: { models: 'all' }, ollama: { models: 'all' } } })).json().id as string;
    const t = await post('/api/tokens', 'u3', { name: 'app', profileId: own });
    expect(t.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${t.json().token}` };
    const models = (await app.inject({ method: 'GET', url: '/api/models', headers: auth })).json() as { models: { providerId: string; model: string }[] };
    expect(models.models.map((m) => `${m.providerId}|${m.model}`)).toEqual(['cloud|gpt-x']);
    expect((await app.inject({ method: 'POST', url: '/api/runs', headers: auth, payload: { question: 'hi', graph: ollamaGraph() } })).statusCode).toBe(403);
  });

  it('an admin token with a profile is limited to it; without one it has everything', async () => {
    const dm = (await post('/api/access/profiles', 'u1', { name: 'DungeonMind', providers: { cloud: { models: ['gpt-y'] }, comfy: { models: ['sdxl.safetensors'], loras: ['dnd/*'] } } })).json().id as string;
    const t = (await post('/api/tokens', 'u1', { name: 'DungeonMind', profileId: dm })).json() as { id: string; token: string };
    const auth = { authorization: `Bearer ${t.token}` };
    const models = (await app.inject({ method: 'GET', url: '/api/models', headers: auth })).json() as { models: { model: string }[] };
    expect(models.models.map((m) => m.model)).toEqual(['gpt-y', 'sdxl.safetensors']);
    expect((await app.inject({ method: 'GET', url: '/api/providers/comfy/loras', headers: auth })).json()).toEqual(['dnd/elf.safetensors', 'dnd\\orc.safetensors']);
    // The admin's own token (no profile) still has everything.
    expect(((await get('/api/models', 'u1')).json() as { models: unknown[] }).models).toHaveLength(6);
    // Taking the profile off the token gives it its user's access again.
    expect((await put(`/api/access/tokens/${t.id}`, 'u1', { profileId: null })).statusCode).toBe(200);
    expect(((await app.inject({ method: 'GET', url: '/api/models', headers: auth })).json() as { models: unknown[] }).models).toHaveLength(6);
  });

  it('a limited (scoped) token may read its lists', async () => {
    const t = (await post('/api/tokens', 'u3', { name: 'dm', canvases: ['dnd-*'], memory: [] })).json() as { token: string };
    const res = await app.inject({ method: 'GET', url: '/api/models', headers: { authorization: `Bearer ${t.token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('Settings → Access', () => {
  it('is for admins only, and Everything is built in', async () => {
    expect((await get('/api/access', 'u2')).statusCode).toBe(403);
    const overview = (await get('/api/access', 'u1')).json() as { profiles: { id: string; builtin?: boolean }[]; newUsers: string; users: { id: string; profileId: string }[]; keepComfyCopy: boolean };
    expect(overview.profiles[0]).toMatchObject({ id: 'everything', builtin: true });
    expect(overview.newUsers).toBe('basic');
    expect(overview.keepComfyCopy).toBe(false);
    expect(overview.users.find((u) => u.id === 'u1')?.profileId).toBe('everything');
    expect((await put('/api/access/profiles/everything', 'u1', { providers: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/access/profiles/everything', ...as('u1') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/access/profiles/basic', ...as('u1') })).statusCode).toBe(400);
  });

  it('the keep-a-copy option switches the ComfyUI workflow to SaveImage', async () => {
    const { adapterFor, rowFor } = await import('../src/api/providers.js');
    const admin = { id: 'u1', username: 'user_u1', role: 'admin' as const };
    const sent: string[] = [];
    const make = async () => {
      vi.stubGlobal('WebSocket', class { close() {} } as any);
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.endsWith('/prompt')) {
          sent.push(JSON.parse(String(init!.body)).prompt['9'].class_type);
          return Response.json({ prompt_id: 'p' });
        }
        if (url.includes('/history/p')) return Response.json({ p: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'temp' }] } } } });
        return new Response('png');
      });
      await adapterFor(rowFor(admin, 'comfy')!).image!({ model: 'sdxl.safetensors', prompt: 'x', width: 64, height: 64 }, new AbortController().signal, () => {});
    };
    expect((await put('/api/access/settings', 'u2', { keepComfyCopy: true })).statusCode).toBe(403);
    await make();
    expect((await put('/api/access/settings', 'u1', { keepComfyCopy: true })).json()).toMatchObject({ keepComfyCopy: true });
    await make();
    await put('/api/access/settings', 'u1', { keepComfyCopy: false });
    expect(sent).toEqual(['PreviewImage', 'SaveImage']);
    vi.unstubAllGlobals();
    stubProviders();
  });

  it('new users get the chosen profile', async () => {
    const res = await post('/api/users', 'u1', { username: 'newbie', password: 'password123' });
    const users = (await get('/api/users', 'u1')).json() as { id: string; profileId: string }[];
    expect(users.find((u) => u.id === res.json().id)?.profileId).toBe('basic');
  });
});

describe('the engine checks every call', () => {
  const allowOnly = (...models: string[]) => ({ model: (_p: string, m: string) => models.includes(m), lora: () => false });

  it('Auto model never picks a disallowed model', async () => {
    const jev = { providerId: 'ts', model: 'jev' };
    // The decider wants "large", which this user may not use: medium is the biggest allowed size.
    const decider = fakeDecider((req) => {
      const sizes = Object.keys((req.questions.route as { criteria: Record<string, string> }).criteria);
      return { route: { type: 'choice', choice: 'large', probabilities: Object.fromEntries(sizes.map((s) => [s, s === 'large' ? 0.9 : 0.05])) } };
    });
    const chat = fakeProvider();
    const graph: CanvasGraph = {
      nodes: [
        node('q', 'input'),
        node('a', 'llm', { auto: { decider: jev, small: { providerId: 'c', model: 'small-1' }, medium: { providerId: 'c', model: 'medium-1' }, large: { providerId: 'c', model: 'large-1' } } }),
        node('o', 'output'),
      ],
      edges: [edge('q', 'a'), edge('a', 'o')],
    };
    const r = await runGraph(graph, 'hard question', { resolve: async (id) => (id === 'ts' ? decider : chat) as ResolvedProvider, emit: () => {}, access: allowOnly('jev', 'small-1', 'medium-1') }, new AbortController().signal);
    expect(chat.calls.map((c) => c.model)).toEqual(['medium-1']);
    expect(Object.keys((decider.calls[0].questions.route as { criteria: object }).criteria)).toEqual(['small', 'medium']);
    expect(r.status).toBe('done');
  });

  it('a Router (or any block) asking for a disallowed model during the run fails that block', async () => {
    const events: RunEvent[] = [];
    const chat = fakeProvider();
    const graph = chain(node('q', 'input'), node('m', 'llm', { model: { providerId: 'c', model: 'secret' } }), node('o', 'output'));
    const r = await runGraph(graph, 'x', { resolve: async () => chat, emit: (e) => events.push(e as RunEvent), access: allowOnly('other') }, new AbortController().signal);
    expect(r.status).toBe('error');
    expect(events.find((e) => e.type === 'error')?.error).toMatch(/You can't use secret/);
    expect(chat.calls).toHaveLength(0);
  });

  it('an Image block with a disallowed LoRA fails', async () => {
    const events: RunEvent[] = [];
    let made = 0;
    const comfy: ResolvedProvider = {
      local: false,
      hostKey: 'gpu',
      modelInfo: async () => undefined,
      adapter: {
        listModels: async () => [],
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('no chat');
        },
        image: async () => {
          made++;
          return [{ data: Buffer.from('x'), ext: 'png' }];
        },
      },
    };
    const graph = chain(node('q', 'input'), node('i', 'image', { model: { providerId: 'comfy', model: 'sdxl' }, lora: 'other/x.safetensors' }), node('o', 'output'));
    const r = await runGraph(
      graph,
      'x',
      { resolve: async () => comfy, emit: (e) => events.push(e as RunEvent), access: { model: () => true, lora: (_p, l) => l.startsWith('dnd/') }, services: { saveFile: (p) => ({ path: p, kind: 'image' }) } },
      new AbortController().signal,
    );
    expect(r.status).toBe('error');
    expect(events.find((e) => e.type === 'error')?.error).toMatch(/You can't use the LoRA other\/x\.safetensors/);
    expect(made).toBe(0);
  });
});

describe('globs', () => {
  it('know only *, ignore case, Windows slashes and :latest', async () => {
    const { globMatch } = await import('../src/services/access.js');
    expect(globMatch('dnd/*', 'dnd/sub/elf.safetensors')).toBe(true);
    expect(globMatch('dnd/*', 'dnd\\elf.safetensors')).toBe(true);
    expect(globMatch('dnd/*', 'dndx/elf.safetensors')).toBe(false);
    expect(globMatch('llama3', 'llama3:latest')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(globMatch('GPT-*', 'gpt-4o')).toBe(true);
  });
});

describe('echo canvas still runs for a user with Basic', () => {
  it('blocks without models need no access', async () => {
    const run = await runAndWait(app, { question: 'hi', graph: echo() }, 'u2');
    expect(run.final).toBe('echo hi');
  });
});
