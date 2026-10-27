import type { FastifyInstance } from 'fastify';
import { logError } from '../errors.js';
import { saveVoiceSettings, speak, speakable, transcribe, voiceSettings } from '../services/voice.js';
import { requireAdmin, requireUser } from './auth.js';

const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_SPEAK = 4096;

export function voiceRoutes(app: FastifyInstance) {
  // Recordings arrive as raw audio (audio/webm from Chrome/Firefox, audio/mp4 from Safari, any file from a phone).
  app.addContentTypeParser(/^(audio|video)\//, { parseAs: 'buffer', bodyLimit: MAX_AUDIO }, (_req, body, done) => done(null, body));

  app.get('/api/settings/voice', { preHandler: requireUser }, async () => voiceSettings());

  app.put('/api/settings/voice', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      saveVoiceSettings((req.body ?? {}) as Parameters<typeof saveVoiceSettings>[0]);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return voiceSettings();
  });

  /** Body: the recording (audio/* or application/octet-stream). Answers { text }. */
  app.post('/api/voice/transcribe', { preHandler: requireUser, bodyLimit: MAX_AUDIO }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the recording as audio/* (raw bytes)' });
    try {
      const text = await transcribe(req.body, String(req.headers['content-type'] ?? 'audio/webm'), req.user!.id);
      if (!text) return reply.code(422).send({ error: 'No speech heard in the recording' });
      return { text };
    } catch (err) {
      const message = `Speech to text failed: ${(err as Error).message}`;
      const problemId = logError({ source: 'voice', message, userId: req.user!.id });
      return reply.code(502).send({ error: message, problemId });
    }
  });

  /** Body: { text }. Answers with the audio (mp3) from the text-to-speech server. */
  app.post('/api/voice/speak', { preHandler: requireUser }, async (req, reply) => {
    const raw = String((req.body as { text?: string } | undefined)?.text ?? '');
    const text = speakable(raw).slice(0, MAX_SPEAK);
    if (!text) return reply.code(400).send({ error: 'Nothing to say' });
    try {
      const { audio, type } = await speak(text, req.user!.id);
      return reply.header('content-type', type).header('cache-control', 'no-store').send(audio);
    } catch (err) {
      const message = `Text to speech failed: ${(err as Error).message}`;
      const problemId = logError({ source: 'voice', message, userId: req.user!.id });
      return reply.code(502).send({ error: message, problemId });
    }
  });
}
