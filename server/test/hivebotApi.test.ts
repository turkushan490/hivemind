import type { CanvasGraph } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, edge, node, testApp } from './helpers.js';

/** What the HiveBot app needs, over the API: warm models, a voice per request, managed canvases, feature flags. */

describe('over the API', () => {
  let app: FastifyInstance;
  let db: Awaited<ReturnType<typeof testApp>>['db'];
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    ({ app, db } = await testApp('hivebot', [
      ['u1', 'admin'],
      ['u2', 'user'],
    ]));
    const add = db.prepare('INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES (?, ?, ?, ?, ?, ?)');
    add.run('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1);
    add.run('dec', 'ollama-decisions', 'decision', 'Ollama decision models', 'http://gpu.test:11434', 1);
    add.run('cloud', 'groq', 'openai', 'Groq', 'https://cloud.test/v1', 0);
    const graph: CanvasGraph = {
      nodes: [
        node('q', 'input'),
        node('a', 'llm', { auto: { decider: { providerId: 'dec', model: 'clef-flash' }, small: { providerId: 'ollama', model: 'gemma4:e2b' }, medium: { providerId: 'ollama', model: 'omnicoder' }, large: { providerId: 'cloud', model: 'big' } }, keepAlive: '30m' }),
        node('o', 'output'),
      ],
      edges: [edge('q', 'a'), edge('a', 'o')],
    };
    db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('hivebot-jev', 'u1', 'HiveBot: Jev', ?)").run(JSON.stringify(graph));
  });
  afterAll(() => app?.close());
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });
  const stub = () =>
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: u, body });
      if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
      if (u.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [] }));
      if (u.endsWith('/audio/speech')) return new Response(Buffer.from('ID3fake'), { headers: { 'content-type': 'audio/mpeg' } });
      return new Response('{}');
    });

  it('S2 — /warm loads the decider, small and medium (not the cloud model), with the block keep_alive', async () => {
    stub();
    const res = await app.inject({ method: 'POST', url: '/api/canvases/hivebot-jev/warm', headers: bearer() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().warmed.sort()).toEqual(['clef-flash', 'gemma4:e2b', 'omnicoder']);
    const loads = calls.filter((c) => c.url.endsWith('/api/generate'));
    expect(loads.map((c) => [c.body.model, c.body.keep_alive])).toEqual(expect.arrayContaining([['gemma4:e2b', '30m'], ['omnicoder', '30m'], ['clef-flash', '30m']]));
    expect(calls.some((c) => c.url.includes('cloud.test'))).toBe(false);
  });

  it('S2 — a limited token for other canvases may not warm this one', async () => {
    db.prepare('UPDATE api_tokens SET scope = ? WHERE id = ?').run(JSON.stringify({ canvases: ['dnd-*'], memory: [] }), 't-u2');
    const res = await app.inject({ method: 'POST', url: '/api/canvases/hivebot-jev/warm', headers: bearer('u2') });
    expect(res.statusCode).toBe(403);
    db.prepare('UPDATE api_tokens SET scope = NULL WHERE id = ?').run('t-u2');
  });

  it('S2 — keepAlive goes to Ollama on chat calls', async () => {
    const { keepAlive } = await import('../src/providers/ollama.js');
    expect([keepAlive('30m'), keepAlive('1h'), keepAlive('-1'), keepAlive('soon'), keepAlive(undefined)]).toEqual(['30m', '1h', '-1', undefined, undefined]);
  });

  it('S3 — a voice per request; app voice names; apps get the server voice also in browser mode', async () => {
    stub();
    expect((await app.inject({ method: 'POST', url: '/api/voice/speak', headers: bearer(), payload: { text: 'Hello' } })).json()).toMatchObject({ code: 'tts_not_configured' });
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { ttsMode: 'browser', ttsUrl: 'http://tts.test/v1', ttsVoice: 'af_heart', appVoices: { Jarvis: 'bm_george' } } });
    let res = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: bearer(), payload: { text: 'Hello sir', voice: 'jarvis', speed: 1.1 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.at(-1)!.body).toMatchObject({ voice: 'bm_george', input: 'Hello sir', speed: 1.1, response_format: 'mp3' });
    res = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: bearer(), payload: { text: 'Hi', voice: 'am_onyx', format: 'wav' } });
    expect(calls.at(-1)!.body).toMatchObject({ voice: 'am_onyx', response_format: 'wav' });
    await app.inject({ method: 'POST', url: '/api/voice/speak', headers: bearer(), payload: { text: 'Hi' } });
    expect(calls.at(-1)!.body.voice).toBe('af_heart');
    expect((await app.inject({ method: 'GET', url: '/api/settings/voice', headers: bearer() })).json().appVoices).toEqual({ jarvis: 'bm_george' });
  });

  it('S5 — managedBy is kept until someone saves without it', async () => {
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/canvases/hivebot-ultron', headers: bearer(), payload: { name: 'HiveBot: Ultron', nodes: [node('q', 'input')], edges: [], ...payload } });
    expect((await put({ managedBy: 'hivebot' })).json().managedBy).toBe('hivebot');
    expect((await put({})).json().managedBy).toBe('hivebot');
    expect((await put({ managedBy: null })).json().managedBy).toBeUndefined();
    expect((await put({ managedBy: 'bad name!' })).statusCode).toBe(400);
  });

  it('S6 — the features list says what this HiveMind supports', async () => {
    const { features } = (await app.inject({ method: 'GET', url: '/api/health' })).json() as { features: string[] };
    expect(features).toEqual(expect.arrayContaining(['hivebot', 'warm', 'ttsVoiceOverride', 'autoFallback', 'routeInfo', 'managedBy']));
  });
});
