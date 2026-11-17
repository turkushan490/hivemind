import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let dataDir: string;
let hub: Server;
let hubUrl = '';
const port = 20401 + Math.floor(Math.random() * 400);

/**
 * A stand-in for the voice worker's speech to text: /transcribe answers "<name>|<device>|<file there>|<model folder>",
 * or fails when the language is "fail" (like a GPU library missing on a CPU-less fallback). /health says what is loaded.
 */
const FAKE = `
const http = require('node:http');
const fs = require('node:fs');
let loaded = null;
http.createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, stt: loaded }));
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url === '/transcribe') {
      if (b.language === 'fail') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'cuda boom' })); }
      loaded = b.name;
      const text = [b.name, b.device, fs.existsSync(b.file), fs.existsSync(b.model + '/model.bin')].join('|');
      return res.end(JSON.stringify({ text, device: 'cpu', seconds: 1.5, ms: 40, ...(b.name === 'small' && { note: 'the GPU did not work (no cuBLAS), used the CPU' }) }));
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

/** A 16 kHz mono 16-bit WAV with a bit of sound, as the browser sends. */
function wav16k(seconds = 1): Buffer {
  const data = Buffer.alloc(16000 * 2 * seconds, 7);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

beforeAll(async () => {
  ({ app } = await testApp('fastwhisper'));
  dataDir = process.env.DATA_DIR!;
  const dir = mkdtempSync(join(tmpdir(), 'hm-fwfake-'));
  writeFileSync(join(dir, 'fake.cjs'), FAKE);
  const vt = await import('../src/services/voiceTraining.js');
  vt.configureVoiceTraining({ port, launch: (p) => ({ cmd: process.execPath, args: [join(dir, 'fake.cjs'), String(p)] }) });
  // Cloned voices switched off must not switch off speech to text.
  vt.saveVoiceEngineSettings({ enabled: false });

  // A stand-in for Hugging Face: a repository listing and its files.
  hub = createServer((req, res) => {
    if (req.url?.startsWith('/api/models/')) {
      return res.end(JSON.stringify({ siblings: ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'README.md', '.gitattributes'].map((rfilename) => ({ rfilename })) }));
    }
    const file = req.url?.split('/').pop() ?? '';
    if (file === 'model.bin' && req.url?.includes('broken')) {
      // The connection drops halfway through the file.
      res.writeHead(200, { 'content-length': '1000' });
      res.write('short');
      return setTimeout(() => res.destroy(), 20);
    }
    res.end(file === 'model.bin' ? 'weights'.repeat(100) : `{"file":"${file}"}`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => hub.once('listening', r));
  hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
  (await import('../src/services/fastWhisper.js')).configureFastWhisper({ base: hubUrl });

  // A stand-in whisper.cpp with a downloaded model, for the fallback.
  const bin = join(dir, 'whisper-cli');
  writeFileSync(bin, '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then out="$2"; fi; shift; done\nprintf \'{"transcription":[{"text":" heard by whisper.cpp"}]}\' > "$out.json"\n');
  chmodSync(bin, 0o755);
  process.env.WHISPER_BIN = bin;
  mkdirSync(join(dataDir, 'whisper', 'models'), { recursive: true });
  writeFileSync(join(dataDir, 'whisper', 'models', 'ggml-base.bin'), 'x');
});
afterAll(async () => {
  delete process.env.WHISPER_BIN;
  await (await import('../src/services/voiceTraining.js')).stopVoiceWorker();
  hub?.close();
  await app?.close();
});

const transcribe = () => app.inject({ method: 'POST', url: '/api/voice/transcribe', headers: { ...bearer(), 'content-type': 'audio/wav' }, payload: wav16k() });
const status = async () => (await app.inject({ url: '/api/voice/fast-whisper', headers: bearer() })).json() as { available: boolean; models: { id: string; downloaded: boolean; downloading?: object }[] };
async function download(id: string) {
  expect((await app.inject({ method: 'POST', url: `/api/voice/fast-whisper/${id}/download`, headers: bearer() })).json()).toEqual({ started: true });
  for (let i = 0; i < 200 && (await status()).models.find((m) => m.id === id)!.downloading; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('fast speech to text (faster-whisper)', () => {
  it('lists its models and offers the engine in the settings', async () => {
    const st = await status();
    expect(st.available).toBe(true);
    expect(st.models[0]).toMatchObject({ id: 'large-v3-turbo', downloaded: false });
    const settings = (await app.inject({ url: '/api/settings/voice', headers: bearer() })).json();
    expect(settings.fastStt).toBe(true);
  });

  it('downloads every file of the model repository (no readme) and can delete it', async () => {
    await download('tiny');
    expect((await status()).models.find((m) => m.id === 'tiny')!.downloaded).toBe(true);
    expect(readdirSync(join(dataDir, 'whisper', 'fast', 'tiny')).sort()).toEqual(['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt']);
    await app.inject({ method: 'DELETE', url: '/api/voice/fast-whisper/tiny', headers: bearer() });
    expect(existsSync(join(dataDir, 'whisper', 'fast', 'tiny'))).toBe(false);
  });

  it('throws away a download that was cut short, and logs it', async () => {
    const { FAST_WHISPER_MODELS } = await import('../src/services/fastWhisper.js');
    FAST_WHISPER_MODELS.push({ id: 'broken', name: 'Broken', repo: 'x/broken', sizeMb: 1, note: '' });
    await download('broken');
    expect((await status()).models.find((m) => m.id === 'broken')!.downloaded).toBe(false);
    expect(existsSync(join(dataDir, 'whisper', 'fast', 'broken.part'))).toBe(false);
    const { db } = await import('../src/db/index.js');
    expect((db.prepare("SELECT message FROM error_log WHERE source = 'voice' ORDER BY id DESC").get() as { message: string }).message).toMatch(/Fast Whisper download \(broken\)/);
    FAST_WHISPER_MODELS.pop();
  });

  it('transcribes in the voice worker with the chosen model, even with cloned voices off', async () => {
    await download('base');
    const put = await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { sttEngine: 'fast', fastWhisperModel: 'base' } });
    expect(put.json()).toMatchObject({ sttEngine: 'fast', fastWhisperModel: 'base', sttReady: true });
    const res = await transcribe();
    expect(res.statusCode).toBe(200);
    // Model name, the Voice engine's device setting, the recording was there for the worker, the model folder too.
    expect(res.json().text).toBe('base|auto|true|true');
    expect(readdirSync(tmpdir()).some((f) => f.startsWith('hm-fstt-'))).toBe(false);
  });

  it('logs a Problem when the GPU did not work and the CPU was used', async () => {
    await download('small');
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { fastWhisperModel: 'small' } });
    expect((await transcribe()).statusCode).toBe(200);
    const { db } = await import('../src/db/index.js');
    expect((db.prepare("SELECT message FROM error_log WHERE source = 'voice' ORDER BY id DESC").get() as { message: string }).message).toMatch(/GPU did not work/);
  });

  it('falls back to whisper.cpp when the fast engine fails, and says so in Problems', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { sttLanguage: 'fail' } });
    const res = await transcribe();
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('heard by whisper.cpp');
    const { db } = await import('../src/db/index.js');
    expect((db.prepare("SELECT message FROM error_log WHERE source = 'voice' ORDER BY id DESC").get() as { message: string }).message).toMatch(
      /Fast speech to text failed, used whisper.cpp \(base\) instead: .*cuda boom/,
    );
  });

  it('says which model is missing instead of failing silently', async () => {
    await rmModel('base');
    await rmModel('small');
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { sttLanguage: '', fastWhisperModel: 'medium', whisperModel: 'tiny' } });
    const res = await transcribe();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/"medium" model is not downloaded/);
  });
});

function rmModel(id: string) {
  return app.inject({ method: 'DELETE', url: `/api/voice/fast-whisper/${id}`, headers: bearer() });
}
