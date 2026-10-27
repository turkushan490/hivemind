import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let app: FastifyInstance;
let db: typeof import('../src/db/index.js').db;
const token = 'hm_voicetoken';
const auth = { authorization: `Bearer ${token}` };
const audio = Buffer.alloc(2000, 1);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hm-voice-'));
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  ({ db } = await import('../src/db/index.js'));
  const { sha256, encrypt } = await import('../src/crypto.js');
  const { voiceRoutes } = await import('../src/api/voice.js');
  db.prepare("INSERT INTO users (id, username, pw_hash, role) VALUES ('u1', 'admin', 'x', 'admin')").run();
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES ('t1', 'u1', 'test', ?, 'hm_voic')").run(sha256(token));
  // A Groq provider: its key is reused for voice on the same address.
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, api_key_enc) VALUES ('groq', 'groq', 'openai', 'Groq', 'https://api.groq.com/openai/v1', ?)").run(
    encrypt('gsk_provider'),
  );
  app = Fastify();
  await app.register(cookie);
  voiceRoutes(app);
  await app.ready();
});
afterAll(() => app?.close());
afterEach(() => vi.unstubAllGlobals());

const put = (body: object) => app.inject({ method: 'PUT', url: '/api/settings/voice', headers: auth, payload: body });

describe('voice routes', () => {
  it('says clearly when speech to text is not set up, and logs it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { ...auth, 'content-type': 'audio/webm' }, payload: audio });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/not set up/);
    expect(res.json().problemId).toBeGreaterThan(0);
    const logged = db.prepare("SELECT message FROM error_log WHERE source = 'voice'").all() as { message: string }[];
    expect(logged.at(-1)!.message).toMatch(/Speech to text failed/);
  });

  it('saves settings without ever returning keys', async () => {
    const res = await put({ sttUrl: 'https://api.groq.com/openai/v1/', sttModel: 'whisper-large-v3-turbo', sttLanguage: 'nl', ttsMode: 'server', ttsUrl: 'http://kokoro:8880/v1', ttsVoice: 'af_bella', ttsKey: 'secret' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sttUrl: 'https://api.groq.com/openai/v1', sttReady: true, hasSttKey: false, ttsMode: 'server', hasTtsKey: true });
    expect(res.body).not.toContain('secret');
    expect((await put({ sttUrl: 'ftp://nope' })).statusCode).toBe(400);
  });

  it('sends the recording to /audio/transcriptions as multipart, with the provider key', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ text: ' turn on the lights ' })));
    vi.stubGlobal('fetch', fetch);
    const res = await app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { ...auth, 'content-type': 'audio/mp4' }, payload: audio });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'turn on the lights' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer gsk_provider');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBe('nl');
    expect((form.get('file') as File).name).toBe('speech.mp4');
    expect((form.get('file') as File).size).toBe(audio.length);
  });

  it('reports a failing speech server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    const res = await app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { ...auth, 'content-type': 'audio/webm' }, payload: audio });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/HTTP 401 — check the API key/);
  });

  it('speaks through /audio/speech without markdown', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetch);
    const res = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: auth, payload: { text: '## Hi **there**\n```js\nx()\n```' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://kokoro:8880/v1/audio/speech');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ voice: 'af_bella', model: 'tts-1' });
    expect(body.input).toBe('Hi there\n(code)');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('needs a login', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/voice/speak', payload: { text: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});
