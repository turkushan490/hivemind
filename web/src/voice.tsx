import type { VoiceSettings } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { reportProblem, toast } from './notify';

// ---- Settings, shared by every mic and speak button ----

let cached: Promise<VoiceSettings | null> | null = null;
const listeners = new Set<(s: VoiceSettings | null) => void>();

export function loadVoice(fresh = false): Promise<VoiceSettings | null> {
  if (!cached || fresh) {
    cached = api<VoiceSettings>('/api/settings/voice', { quiet: true }).catch(() => null);
    cached.then((s) => listeners.forEach((l) => l(s)));
  }
  return cached;
}

export function useVoice(): VoiceSettings | null {
  const [s, setS] = useState<VoiceSettings | null>(null);
  useEffect(() => {
    listeners.add(setS);
    loadVoice().then(setS);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

// ---- Speech to text ----

/** Sends a recording to the server and returns the text. Shows a toast and throws on failure. */
export async function transcribe(audio: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': audio.type || 'audio/webm' }, body: audio });
  } catch {
    toast("Can't reach the HiveMind server to transcribe");
    throw new Error('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error ?? `Speech to text failed (HTTP ${res.status})`;
    toast(data.problemId ? `${msg} (problem #${data.problemId})` : msg);
    throw new Error(msg);
  }
  return data.text as string;
}

const MAX_SECONDS = 60;
type MicState = 'idle' | 'recording' | 'busy';

/**
 * Click to record, click again to stop; the text goes to onText.
 * Without microphone access (plain http on a LAN address) it falls back to picking or recording an audio file.
 */
export function MicButton({ onText, disabled, className = '', size = 'md' }: { onText: (text: string) => void; disabled?: boolean; className?: string; size?: 'sm' | 'md' }) {
  const voice = useVoice();
  const [state, setState] = useState<MicState>('idle');
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => () => {
    clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const handle = async (audio: Blob) => {
    setState('busy');
    try {
      const text = await transcribe(audio);
      onText(text);
    } catch {
    } finally {
      setState('idle');
    }
  };

  const start = async () => {
    if (!voice?.sttReady) return toast('Speech to text is not set up yet: Settings → Voice', 'info');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      // Browsers only allow the microphone on https:// or localhost; a phone can still record an audio file.
      toast('The browser blocks the microphone on plain http. Pick or record an audio file instead — or open HiveMind over https.', 'info');
      return file.current?.click();
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as Error).name;
      const msg =
        name === 'NotAllowedError' ? 'Microphone access was refused. Allow it in the browser’s site settings.' : name === 'NotFoundError' ? 'No microphone found.' : `Microphone error: ${(err as Error).message}`;
      toast(msg);
      if (name !== 'NotAllowedError' && name !== 'NotFoundError') reportProblem(msg, (err as Error).stack);
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && parts.push(e.data);
    r.onerror = (e) => {
      const msg = `Recording failed: ${(e as ErrorEvent).message ?? 'unknown error'}`;
      toast(msg);
      reportProblem(msg);
    };
    r.onstop = () => {
      clearInterval(timer.current);
      stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
      const blob = new Blob(parts, { type: (r.mimeType || 'audio/webm').split(';')[0] });
      if (blob.size < 500) {
        setState('idle');
        return toast('The recording was empty — hold on a little longer', 'info');
      }
      handle(blob);
    };
    rec.current = r;
    r.start(250);
    setSecs(0);
    setState('recording');
    const t0 = Date.now();
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setSecs(s);
      if (s >= MAX_SECONDS) r.state === 'recording' && r.stop();
    }, 250);
  };

  const click = () => {
    if (state === 'recording') return rec.current?.state === 'recording' && rec.current.stop();
    if (state === 'idle') start();
  };

  const dim = size === 'sm' ? 'h-7 min-w-7 text-xs' : 'h-12 min-w-12';
  return (
    <>
      <button
        type="button"
        disabled={disabled || state === 'busy'}
        onClick={click}
        title={state === 'recording' ? 'Stop and use what you said' : voice?.sttReady ? 'Speak your question' : 'Speech to text: set it up in Settings → Voice'}
        aria-label={state === 'recording' ? 'Stop recording' : 'Speak'}
        className={`nodrag relative inline-flex shrink-0 items-center justify-center gap-1 rounded-md border px-2 transition ${dim} ${
          state === 'recording' ? 'hm-breathe border-red-500 bg-red-500/20 text-red-200' : 'border-[#30363d] bg-[#161b22] text-slate-300 hover:border-indigo-500 hover:text-white'
        } ${voice && !voice.sttReady ? 'opacity-60' : ''} ${className}`}
      >
        {state === 'busy' ? <span className="animate-pulse">…</span> : <MicIcon />}
        {state === 'recording' && <span className="text-xs tabular-nums">{secs}s</span>}
      </button>
      <input
        ref={file}
        type="file"
        accept="audio/*"
        capture
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) handle(f);
        }}
      />
    </>
  );
}

const MicIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

// ---- Text to speech ----

/** Markdown, code and links read badly aloud. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .trim()
    .slice(0, 4096);
}

let current: { stop: () => void } | null = null;

/** Reads text aloud with the browser voice or the text-to-speech server; resolves when done. */
export async function speak(text: string, voice: VoiceSettings | null, onEnd?: () => void): Promise<void> {
  current?.stop();
  const say = speakable(text);
  if (!say) return;
  if (voice?.ttsMode === 'server') {
    const res = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: say }) }).catch(() => null);
    if (!res) throw new Error("Can't reach the HiveMind server");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.problemId ? `${data.error} (problem #${data.problemId})` : (data.error ?? `HTTP ${res.status}`));
    }
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    const done = () => {
      URL.revokeObjectURL(url);
      if (current?.stop === stop) current = null;
      onEnd?.();
    };
    const stop = () => {
      audio.pause();
      done();
    };
    current = { stop };
    audio.onended = done;
    audio.onerror = () => {
      done();
      toast('This browser could not play the audio from the text-to-speech server');
    };
    await audio.play();
    return;
  }
  if (!('speechSynthesis' in window)) throw new Error('This browser has no built-in voice. Choose a text-to-speech server in Settings → Voice.');
  const u = new SpeechSynthesisUtterance(say);
  u.lang = document.documentElement.lang || navigator.language;
  const stop = () => {
    speechSynthesis.cancel();
    onEnd?.();
  };
  current = { stop };
  u.onend = () => {
    if (current?.stop === stop) current = null;
    onEnd?.();
  };
  u.onerror = (e) => {
    if (e.error !== 'canceled' && e.error !== 'interrupted') toast(`The browser voice failed: ${e.error}`);
    onEnd?.();
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export const stopSpeaking = () => current?.stop();

/** 🔊 on answers: read aloud, click again to stop. */
export function SpeakButton({ text, className = '' }: { text: string; className?: string }) {
  const voice = useVoice();
  const [on, setOn] = useState(false);
  useEffect(() => () => void (on && stopSpeaking()), []);
  return (
    <button
      type="button"
      className={`btn-ghost px-2 py-0.5 text-xs ${on ? 'border-indigo-500 text-indigo-200' : ''} ${className}`}
      title={on ? 'Stop reading' : 'Read the answer aloud'}
      onClick={async () => {
        if (on) return stopSpeaking();
        setOn(true);
        try {
          await speak(text, voice, () => setOn(false));
        } catch (err) {
          setOn(false);
          toast(`Could not read aloud: ${(err as Error).message}`);
        }
      }}
    >
      {on ? '■ Stop' : '🔊 Read aloud'}
    </button>
  );
}
