import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;
let dataDir: string;
const port = 19881 + Math.floor(Math.random() * 400);

/**
 * A stand-in for server/voice/worker.py (and a speech-to-text server): /prep writes three clips per recording,
 * /speak answers "WAV:<voice file>:<text>", /v1/audio/transcriptions says "hello from the clip".
 */
const FAKE = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"ok":true}');
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: 'hello from the clip' }));
    const b = JSON.parse(raw.toString() || '{}');
    if (req.url === '/prep') {
      fs.mkdirSync(b.outDir, { recursive: true });
      const clips = [];
      let n = b.start;
      for (const src of b.inputs) for (let i = 0; i < 3; i++) {
        const p = path.join(b.outDir, b.prefix + '_' + String(n++).padStart(4, '0') + '.wav');
        // Same recording, same clips (so a second run finds them in the dataset already).
        fs.writeFileSync(p, path.basename(src) + ':' + i + ':' + 'x'.repeat(300));
        clips.push({ path: p, seconds: 6 + i * 2, db: -20, source: path.basename(src) });
      }
      return res.end(JSON.stringify({ clips, dropped: { quiet: 1, clipped: 0, silence: 0, short: 0 }, files: b.inputs.map((f) => ({ file: path.basename(f), minutes: 1, clips: 3 })) }));
    }
    if (req.url === '/speak') { res.setHeader('content-type', 'audio/wav'); return res.end('WAV:' + b.voiceFile + ':' + b.text); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

beforeAll(async () => {
  ({ app } = await testApp('voicetrain'));
  dataDir = process.env.DATA_DIR!;
  const fake = join(mkdtempSync(join(tmpdir(), 'hm-voicefake-')), 'fake.cjs');
  writeFileSync(fake, FAKE);
  const vt = await import('../src/services/voiceTraining.js');
  vt.configureVoiceTraining({ port, launch: (p) => ({ cmd: process.execPath, args: [fake, String(p)] }) });
  // Speech to text answered by the same stand-in.
  await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { sttUrl: `http://127.0.0.1:${port}/v1`, sttModel: 'whisper-large-v3' } });
  // A recording uploaded by u1.
  const { setOwner } = await import('../src/services/files.js');
  mkdirSync(join(dataDir, 'files', 'uploads'), { recursive: true });
  writeFileSync(join(dataDir, 'files', 'uploads', 'friend.mp3'), 'mp3 data');
  setOwner('uploads/friend.mp3', 'u1');
});
afterAll(async () => {
  const vt = await import('../src/services/voiceTraining.js');
  await vt.stopVoiceWorker();
  await app?.close();
});

const trainer = chain(
  node('in', 'input'),
  node('prep', 'audioPrep'),
  node('ds', 'voiceDataset'),
  node('clone', 'voiceClone'),
  node('say', 'speak', { prompt: 'Good evening, sir.\nAll systems ready.' }),
  node('out', 'output'),
);

describe('voice training (HiveBot · Voice trainer)', () => {
  it('recordings → clips → a voice dataset → a cloned voice → spoken test lines', async () => {
    const r = await runAndWait(app, { graph: trainer, question: 'Jarvis [friend.mp3](hm-file:uploads/friend.mp3)' });
    if (r.status !== 'done') console.log(JSON.stringify(r.events.filter((e) => e.type === 'error' || e.type === 'node_progress').map((e) => [e.nodeId, e.error ?? e.note])));
    expect(r.status).toBe('done');
    const prep = JSON.parse(r.outputs!.prep.text);
    expect(prep.character).toBe('jarvis');
    expect(prep.clips.map((c: { path: string }) => c.path)).toEqual(['voices/jarvis/clip_0001.wav', 'voices/jarvis/clip_0002.wav', 'voices/jarvis/clip_0003.wav']);
    const ds = JSON.parse(r.outputs!.ds.text);
    expect(ds).toMatchObject({ dataset: 'hivebot-voice-jarvis', added: 3, clips: 3, minutes: 0.4 });
    expect(readFileSync(join(dataDir, 'files', 'voices', 'jarvis', 'metadata.csv'), 'utf8')).toContain('clip_0001|hello from the clip');
    const clone = JSON.parse(r.outputs!.clone.text);
    expect(clone.voice).toBe('clone:jarvis');
    expect(existsSync(join(dataDir, 'voices', 'jarvis', 'voice.json'))).toBe(true);
    // Two test lines as audio files in the run.
    const spoken = r.events.filter((e) => e.type === 'node_done' && e.nodeId === 'say').flatMap((e) => e.files ?? []);
    expect(spoken).toHaveLength(2);
    expect(readFileSync(join(dataDir, 'files', spoken[0].path), 'utf8')).toMatch(/^WAV:.*voice\.json:Good evening, sir\.$/);
  });

  it('a second run with the same recording adds nothing twice, and keeps the previous voice', async () => {
    const r = await runAndWait(app, { graph: trainer, question: 'Jarvis [friend.mp3](hm-file:uploads/friend.mp3)' });
    const ds = JSON.parse(r.outputs!.ds.text);
    expect(ds).toMatchObject({ added: 0, skipped: 3, clips: 3 });
    expect(existsSync(join(dataDir, 'voices', 'jarvis', 'voice.v1.json'))).toBe(true);
  });

  it('/api/voice/speak speaks in the cloned voice by its app name, and lists it', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/voice', headers: bearer(), payload: { appVoices: { jarvis: 'clone:jarvis' } } });
    const res = await app.inject({ method: 'POST', url: '/api/voice/speak', headers: bearer(), payload: { text: 'Hello, sir.', voice: 'jarvis', format: 'wav' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/^WAV:.*jarvis.*voice\.json:Hello, sir\.$/);
    const voices = (await app.inject({ method: 'GET', url: '/api/voice/voices', headers: bearer() })).json();
    expect(voices.cloned.map((v: { id: string }) => v.id)).toEqual(['clone:jarvis']);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().features).toEqual(expect.arrayContaining(['audioPrep', 'voiceDataset', 'voiceClone', 'speak']));
  });
});
