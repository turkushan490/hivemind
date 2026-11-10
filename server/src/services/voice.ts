import type { VoiceSettings } from '@hivemind/shared';
import { decrypt, encrypt } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';
import { ensureKokoro, KOKORO_VOICES, kokoroAvailable } from './kokoro.js';
import { isCloneVoice, listClonedVoices, speakClone } from './voiceTraining.js';

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
  ttsMode?: 'browser' | 'server' | 'builtin';
  ttsUrl?: string;
  ttsKey?: string;
  ttsModel?: string;
  ttsVoice?: string;
  /** Voices for apps: "jarvis" → a voice id of the speech server. */
  appVoices?: Record<string, string>;
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
    appVoices: s.appVoices ?? {},
    builtinTts: kokoroAvailable(),
    ...(kokoroAvailable() && { builtinVoices: KOKORO_VOICES }),
  };
}

/** Voices for apps as a clean map: names of letters, digits, - and _ (at most 50), voice ids of at most 100 characters. */
function cleanVoices(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Voices for apps must be a list of name → voice');
  const out: Record<string, string> = {};
  for (const [name, voice] of Object.entries(v as Record<string, unknown>)) {
    const n = name.trim().toLowerCase();
    const id = String(voice ?? '').trim();
    if (!n || !id) continue;
    if (!/^[a-z0-9_-]{1,40}$/.test(n)) throw new Error(`"${name}" is not a valid voice name (letters, digits, - and _)`);
    out[n] = id.slice(0, 100);
    if (Object.keys(out).length > 50) throw new Error('At most 50 voices for apps');
  }
  return out;
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
  const voices = patch.appVoices !== undefined ? cleanVoices(patch.appVoices) : undefined;
  const s = load();
  const next: Stored = {
    sttUrl: patch.sttUrl !== undefined ? cleanUrl(patch.sttUrl) : s.sttUrl,
    sttKey: key(patch.sttKey, s.sttKey),
    sttModel: text(patch.sttModel, s.sttModel),
    sttLanguage: text(patch.sttLanguage, s.sttLanguage),
    ttsMode: patch.ttsMode === 'server' || patch.ttsMode === 'browser' || patch.ttsMode === 'builtin' ? patch.ttsMode : s.ttsMode,
    ttsUrl: patch.ttsUrl !== undefined ? cleanUrl(patch.ttsUrl) : s.ttsUrl,
    ttsKey: key(patch.ttsKey, s.ttsKey),
    ttsModel: text(patch.ttsModel, s.ttsModel),
    ttsVoice: text(patch.ttsVoice, s.ttsVoice),
    appVoices: voices ?? s.appVoices,
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

/** Text to speech is not set up for this caller (no server, or the browser voice for the screen). */
export class TtsNotConfigured extends Error {
  readonly code = 'tts_not_configured';
}

/** What a caller may ask for per request: a voice (or an app voice name), the model, the speed and the format. */
export interface SpeakOptions {
  voice?: string;
  model?: string;
  speed?: number;
  format?: 'mp3' | 'wav';
  /** An app with an API token: it has no browser voice, so a configured server is used even in browser mode. */
  app?: boolean;
}

/** Text to speech on the server: returns the audio and its type. */
export async function speak(input: string, userId: string, opts: SpeakOptions = {}): Promise<{ audio: Buffer; type: string; note?: string }> {
  const s = load();
  // A cloned voice ("clone:jarvis", or a Voices-for-apps name that points to one): the voice engine. When it can't
  // speak (no voice yet, engine off), the built-in voice says it instead, and the answer says why.
  const wanted = opts.voice?.trim();
  const pinned = (wanted && s.appVoices?.[wanted.toLowerCase()]) || '';
  // A name with a cloned voice of its own ("jarvis" and clone:jarvis exists) speaks in it by itself, so a voice the
  // Voice trainer builds reaches the apps and robots without a setting; Voices for apps only picks another clone.
  const own = wanted && !isCloneVoice(wanted) && !isCloneVoice(pinned) && listClonedVoices().some((v) => v.id.toLowerCase() === `clone:${wanted.toLowerCase()}`);
  const mapped = own ? `clone:${wanted!.toLowerCase()}` : pinned || wanted || s.ttsVoice || '';
  if (isCloneVoice(mapped)) {
    try {
      // What it said is checked with speech to text (when set up): noises instead of words are made again.
      const check = s.sttUrl ? (wav: Buffer) => transcribe(wav, 'audio/wav', userId) : undefined;
      const out = await speakClone(input, mapped, { ...(opts.speed !== undefined && { speed: opts.speed }), ...(check && { check }) });
      return { audio: out.audio, type: out.type };
    } catch (err) {
      if (!kokoroAvailable()) throw err;
      // The voice it had before the clone (Voices for apps, e.g. jarvis = bm_george), else the default.
      const r = await speak(input, userId, { ...opts, voice: pinned && !isCloneVoice(pinned) ? pinned : 'af_heart' });
      return { ...r, note: `${mapped} could not speak (${(err as Error).message.slice(0, 160)}); the built-in voice said it` };
    }
  }
  // The built-in voice (Kokoro in this container): chosen in Settings, or for apps when no speech server is set.
  const builtin = kokoroAvailable() && (s.ttsMode === 'builtin' || (!!opts.app && s.ttsMode !== 'server' && !s.ttsUrl));
  if (!builtin) {
    if (!s.ttsUrl) throw new TtsNotConfigured('Text to speech has no server address (Settings → Voice)');
    if (s.ttsMode !== 'server' && !opts.app) throw new TtsNotConfigured('Text to speech uses the browser voice (Settings → Voice)');
  }
  const asked = opts.voice?.trim();
  // A name from Voices for apps ("jarvis"), else the voice id as given, else the stored voice.
  const voice = (asked && s.appVoices?.[asked.toLowerCase()]) || asked || s.ttsVoice || (builtin ? 'af_heart' : 'alloy');
  if (builtin) {
    const base = await ensureKokoro();
    const format = opts.format === 'wav' ? 'wav' : 'mp3';
    const speed = opts.speed !== undefined && Number.isFinite(opts.speed) ? Math.min(4, Math.max(0.25, opts.speed)) : undefined;
    // Its voices are Kokoro's own (am_puck, bm_george…): an OpenAI name like "alloy" becomes the default.
    const id = KOKORO_VOICES.includes(voice) || /^[a-z][fm]_[a-z]+$/.test(voice) ? voice : 'af_heart';
    const res = await call(
      `${base}/audio/speech`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'kokoro', voice: id, input, response_format: format, ...(speed !== undefined && { speed }) }) },
      'built-in text-to-speech',
    );
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new Error('The built-in voice sent no audio');
    return { audio, type: res.headers.get('content-type') || (format === 'wav' ? 'audio/wav' : 'audio/mpeg') };
  }
  const format = opts.format === 'wav' ? 'wav' : 'mp3';
  const speed = opts.speed !== undefined && Number.isFinite(opts.speed) ? Math.min(4, Math.max(0.25, opts.speed)) : undefined;
  const apiKey = keyFor(s.ttsUrl!, s.ttsKey, userId);
  const res = await call(
    `${s.ttsUrl}/audio/speech`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify({ model: opts.model?.trim() || s.ttsModel || 'tts-1', voice, input, response_format: format, ...(speed !== undefined && { speed }) }),
    },
    'text-to-speech',
  );
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('The text-to-speech server sent no audio');
  return { audio, type: res.headers.get('content-type')?.startsWith('audio/') ? res.headers.get('content-type')! : format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
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
