import type { VoiceSettings } from '@hivemind/shared';
import { decrypt, encrypt } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';

/**
 * Voice, pluggable like providers: speech to text through any OpenAI-compatible /audio/transcriptions
 * (Groq Whisper, OpenAI, a local speaches / faster-whisper server), text to speech through the browser
 * or any OpenAI-compatible /audio/speech (OpenAI, Kokoro, Piper).
 */
interface Stored {
  sttUrl?: string;
  sttKey?: string;
  sttModel?: string;
  sttLanguage?: string;
  ttsMode?: 'browser' | 'server';
  ttsUrl?: string;
  ttsKey?: string;
  ttsModel?: string;
  ttsVoice?: string;
}

const KEY = 'voice';

function load(): Stored {
  try {
    return JSON.parse(getSetting(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function voiceSettings(): VoiceSettings {
  const s = load();
  return {
    sttUrl: s.sttUrl,
    sttModel: s.sttModel,
    sttLanguage: s.sttLanguage,
    hasSttKey: !!s.sttKey,
    sttReady: !!s.sttUrl,
    ttsMode: s.ttsMode ?? 'browser',
    ttsUrl: s.ttsUrl,
    ttsModel: s.ttsModel,
    ttsVoice: s.ttsVoice,
    hasTtsKey: !!s.ttsKey,
  };
}

const cleanUrl = (u: string) => {
  const url = u.trim().replace(/\/+$/, '').replace(/\/audio\/(transcriptions|speech)$/, '');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('Voice server addresses must start with http:// or https://');
  return url || undefined;
};
const text = (v: string | undefined, old: string | undefined) => (v !== undefined ? v.trim() || undefined : old);
/** A key in plain text is stored encrypted; "" removes it, undefined keeps it. */
const key = (v: string | undefined, old: string | undefined) => (v !== undefined ? (v.trim() ? encrypt(v.trim()) : undefined) : old);

export function saveVoiceSettings(patch: Partial<Omit<VoiceSettings, 'hasSttKey' | 'hasTtsKey' | 'sttReady'>> & { sttKey?: string; ttsKey?: string }) {
  const s = load();
  const next: Stored = {
    sttUrl: patch.sttUrl !== undefined ? cleanUrl(patch.sttUrl) : s.sttUrl,
    sttKey: key(patch.sttKey, s.sttKey),
    sttModel: text(patch.sttModel, s.sttModel),
    sttLanguage: text(patch.sttLanguage, s.sttLanguage),
    ttsMode: patch.ttsMode === 'server' || patch.ttsMode === 'browser' ? patch.ttsMode : s.ttsMode,
    ttsUrl: patch.ttsUrl !== undefined ? cleanUrl(patch.ttsUrl) : s.ttsUrl,
    ttsKey: key(patch.ttsKey, s.ttsKey),
    ttsModel: text(patch.ttsModel, s.ttsModel),
    ttsVoice: text(patch.ttsVoice, s.ttsVoice),
  };
  setSetting(KEY, JSON.stringify(next));
}

/** The voice key, or else the key of an AI provider on the same address (your Groq or OpenAI key works for voice too). */
function keyFor(url: string, enc: string | undefined, userId: string): string | undefined {
  if (enc) return decrypt(enc);
  const rows = db
    .prepare('SELECT base_url, api_key_enc FROM providers WHERE api_key_enc IS NOT NULL AND enabled = 1 AND (owner_id IS NULL OR owner_id = ?)')
    .all(userId) as { base_url: string; api_key_enc: string }[];
  const row = rows.find((r) => r.base_url.replace(/\/+$/, '') === url);
  return row ? decrypt(row.api_key_enc) : undefined;
}

const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'video/webm': 'webm',
};
/** Whisper servers pick the decoder from the file name, so it needs the right extension. */
export const audioExt = (mime: string) => EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'webm';

async function call(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    throw new Error(`Can't reach the ${what} server at ${url}: ${cause?.code ?? (err as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    const hint = res.status === 401 ? ' — check the API key' : res.status === 404 ? ' — check the address and model' : '';
    throw new Error(`The ${what} server answered HTTP ${res.status}${hint}${body ? `: ${body}` : ''}`);
  }
  return res;
}

/** Speech to text: returns the transcript. */
export async function transcribe(audio: Buffer, mime: string, userId: string): Promise<string> {
  const s = load();
  if (!s.sttUrl) throw new Error('Speech to text is not set up: pick a server in Settings → Voice');
  if (audio.length < 100) throw new Error('The recording is empty');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] }), `speech.${audioExt(mime)}`);
  form.append('model', s.sttModel || 'whisper-1');
  if (s.sttLanguage) form.append('language', s.sttLanguage);
  form.append('response_format', 'json');
  const apiKey = keyFor(s.sttUrl, s.sttKey, userId);
  const res = await call(`${s.sttUrl}/audio/transcriptions`, { method: 'POST', headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined, body: form }, 'speech-to-text');
  const raw = await res.text();
  let out: string;
  try {
    out = String((JSON.parse(raw) as { text?: string }).text ?? '');
  } catch {
    out = raw;
  }
  return out.trim();
}

/** Text to speech on the server: returns the audio and its type. */
export async function speak(input: string, userId: string): Promise<{ audio: Buffer; type: string }> {
  const s = load();
  if (s.ttsMode !== 'server') throw new Error('Text to speech uses the browser voice (Settings → Voice)');
  if (!s.ttsUrl) throw new Error('Text to speech has no server address (Settings → Voice)');
  const apiKey = keyFor(s.ttsUrl, s.ttsKey, userId);
  const res = await call(
    `${s.ttsUrl}/audio/speech`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify({ model: s.ttsModel || 'tts-1', voice: s.ttsVoice || 'alloy', input, response_format: 'mp3' }),
    },
    'text-to-speech',
  );
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('The text-to-speech server sent no audio');
  return { audio, type: res.headers.get('content-type')?.startsWith('audio/') ? res.headers.get('content-type')! : 'audio/mpeg' };
}

/** Markdown, code and links read badly aloud: plain sentences only. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}
