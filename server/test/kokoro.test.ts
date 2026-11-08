import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let app: FastifyInstance;
const token = 'hm_kokorotoken';
const auth = { authorization: `Bearer ${token}` };
let kokoro: typeof import('../src/services/kokoro.js');
const port = 18880 + Math.floor(Math.random() * 500);

/** A stand-in for server/kokoro/serve.py: answers what it was asked for, so the test sees the voice and format. */
const FAKE = `
const http = require('node:http');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"ok":true}');
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b);
    res.setHeader('content-type', j.response_format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    res.end('AUDIO:' + j.voice + ':' + j.input);
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-kokoro-'));
  process.env.DATA_DIR = dir;
  const fake = join(dir, 'fake-kokoro.cjs');
  writeFileSync(fake, FAKE);
  kokoro = await import('../src/services/kokoro.js');
  kokoro.configureKokoro({ port, launch: (p) => ({ cmd: process.execPath, args: [fake, String(p)] }) });
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { db } = await import('../src/db/index.js');
  const { sha256 } = await import('../src/crypto.js');
  const { voiceRoutes } = await import('../src/api/voice.js');
  db.prepare("INSERT INTO users (id, username, pw_hash, role) VALUES ('u1', 'admin', 'x', 'admin')").run();
  db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES ('t1', 'u1', 'test', ?, 'hm_koko')").run(sha256(token));
  app = Fastify();
  await app.register(cookie);
  voiceRoutes(app);
  await app.ready();
});
afterAll(async () => {
  await kokoro?.stopKokoro();
  await app?.close();
});

const speak = (body: object) => app.inject({ method: 'POST', url: '/api/voice/speak', headers: auth, payload: body });

describe('built-in voice (Kokoro)', () => {
  it('is offered in the settings with its voices', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/voice', headers: auth });
    expect(res.json()).toMatchObject({ builtinTts: true });
    expect(res.json().builtinVoices).toContain('bm_george');
  });

  it('speaks for an app with no speech server set, with the character voice', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: auth, payload: { appVoices: { jarvis: 'bm_george' } } });
    const res = await speak({ text: 'Good evening, sir.', voice: 'jarvis' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('AUDIO:bm_george:Good evening, sir.');
  });

  it('is the voice for everyone when chosen in Settings, and an unknown voice name falls back to its default', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: auth, payload: { ttsMode: 'builtin' } });
    const res = await speak({ text: 'Hi', voice: 'alloy', format: 'wav' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
    expect(res.body).toBe('AUDIO:af_heart:Hi');
  });
});
