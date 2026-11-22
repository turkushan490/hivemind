import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { useStored } from '../stored';
import { transcribe } from '../voice';

/**
 * HiveBot in the browser (H33): talk to the HiveBot workflow like to the robot — a face, open conversation (the
 * microphone stays on and a pause ends a question), hold to talk, or type. HiveMind picks who answers (character
 * "auto"), each tab is its own session, and the answer is spoken in that character's voice.
 */

const LOOK: Record<string, { color: string; title: string }> = {
  jev: { color: '#a78bfa', title: 'Jev' },
  jarvis: { color: '#fb923c', title: 'Jarvis' },
  ultron: { color: '#ef4444', title: 'Ultron' },
  vision: { color: '#facc15', title: 'Vision' },
  ghost: { color: '#22d3ee', title: 'Ghost' },
  friday: { color: '#f472b6', title: 'Friday' },
};
type Mode = 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'locked';
const MODE_TEXT: Record<Mode, string> = {
  idle: 'READY',
  listening: 'LISTENING - JUST TALK',
  hearing: 'HEARING YOU…',
  thinking: 'THINKING',
  speaking: 'SPEAKING',
  muted: 'MUTED',
  locked: 'LOCKED (GUEST)',
};

interface Job {
  jobId: string;
  title?: string;
  status: string;
  character?: string;
  createdAt?: string;
  finishedAt?: string;
}

const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** This tab's own session (H30): kept in sessionStorage, so a reload keeps the conversation. */
function sessionId(): string {
  try {
    let id = sessionStorage.getItem('hivebot.session');
    if (!id) {
      id = `tab-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('hivebot.session', id);
    }
    return id;
  } catch {
    return `tab-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function HiveBotPage({ active }: { active: boolean }) {
  const [character, setCharacter] = useState('vision');
  const [mode, setMode] = useState<Mode>('idle');
  const [log, setLog] = useState<{ who: string; text: string }[]>([]);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useStored('hivebot.open', true);
  const [voiceOn, setVoiceOn] = useStored('hivebot.voice', true);
  const [guest, setGuest] = useStored('hivebot.guest', false);
  const [level, setLevel] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [silenceMs, setSilenceMs] = useState(1800);
  const [maxSec, setMaxSec] = useState(60);
  const session = useRef(sessionId());
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const busySince = useRef(0);
  const modeRef = useRef<Mode>('idle');
  modeRef.current = mode;
  // Kept current for callbacks made earlier (the job poller, the microphone loop), so they never use an old value.
  const openRef = useRef(open);
  openRef.current = open;
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const characterRef = useRef(character);
  characterRef.current = character;
  const rest = (): Mode => (openRef.current ? 'listening' : 'idle');

  // H35: every Stop (or barge-in) bumps this; anything started before it drops itself when it comes back.
  const gen = useRef(0);
  const playing = useRef<{ a: HTMLAudioElement; done: () => void } | null>(null);
  const speakAbort = useRef<AbortController | null>(null);
  const voiceQueue = useRef<Promise<void>>(Promise.resolve());
  // The microphone recorder (used by Stop too).
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const lastStop = useRef(0);

  // The listening settings from listening.md (H31): pause length and the longest question.
  useEffect(() => {
    if (!active) return;
    api<{ settings: Record<string, number | string> }>('/api/robot/rules', { quiet: true })
      .then((r) => {
        if (typeof r.settings.silenceMs === 'number') setSilenceMs(r.settings.silenceMs);
        if (typeof r.settings.maxQuestionSeconds === 'number') setMaxSec(r.settings.maxQuestionSeconds);
        if (typeof r.settings.defaultCharacter === 'string') setCharacter(r.settings.defaultCharacter);
      })
      .catch(() => {});
  }, [active]);

  /** Stops the voice now. A voice still being made never plays; a paused one resolves its promise by hand. */
  const stopVoice = () => {
    speakAbort.current?.abort();
    speakAbort.current = null;
    const p = playing.current;
    playing.current = null;
    if (p) {
      p.a.pause();
      p.done(); // pause() never fires "ended": without this, whoever waits on the voice waits forever
    }
    setLevel(0);
  };

  /** Speaks one line in the character's voice, after the lines before it (they wait for each other, never cut off). */
  const say = (text: string, who: string): Promise<void> => {
    const g = gen.current;
    const run = voiceQueue.current.then(() => (g === gen.current ? speakNow(text, who, g) : undefined));
    voiceQueue.current = run.catch(() => {});
    return run;
  };

  async function speakNow(text: string, who: string, g: number) {
    if (!voiceOnRef.current || !text.trim()) return;
    const ctl = new AbortController();
    speakAbort.current = ctl;
    let res: Response;
    try {
      res = await fetch('/api/voice/speak', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: who, format: 'mp3' }) });
    } catch {
      return; // stopped while the voice was being made
    }
    if (!res.ok || g !== gen.current) return;
    const url = URL.createObjectURL(await res.blob());
    if (g !== gen.current) return URL.revokeObjectURL(url);
    setMode('speaking');
    await new Promise<void>((resolve) => {
      const a = new Audio(url);
      let ctx: AudioContext | undefined;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        if (playing.current?.a === a) playing.current = null;
        void ctx?.close().catch(() => {});
        setLevel(0);
        URL.revokeObjectURL(url);
        resolve();
      };
      playing.current = { a, done };
      try {
        ctx = new AudioContext();
        const src = ctx.createMediaElementSource(a);
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);
        an.connect(ctx.destination);
        const buf = new Uint8Array(an.frequencyBinCount);
        const tick = () => {
          if (playing.current?.a !== a) return;
          an.getByteFrequencyData(buf);
          setLevel(buf.reduce((n, v) => n + v, 0) / buf.length / 128);
          requestAnimationFrame(tick);
        };
        tick();
      } catch {}
      a.onended = a.onerror = done;
      void a.play().catch(done);
    });
    if (modeRef.current === 'speaking' && !playing.current) setMode(rest());
  }

  /** Cancels a background job (an orb). */
  const cancelJob = async (j: Job) => {
    await api(`/api/robot/jobs/${j.jobId}/cancel`, { method: 'POST' }).catch(() => {});
    setJobs((list) => list.map((x) => (x.jobId === j.jobId ? { ...x, status: 'cancelled', finishedAt: new Date().toISOString() } : x)));
  };

  /**
   * Stop: the voice, the question that runs (the server cancels its run when the stream closes), a recording that is
   * still going (thrown away) and a transcription on its way. Never leaves the page stuck. Pressed twice within 3 s:
   * also the background jobs started in the last 2 minutes.
   */
  const stop = () => {
    gen.current++;
    stopVoice();
    abort.current?.abort();
    abort.current = null;
    const r = rec.current;
    if (r && r.state !== 'inactive') {
      r.onstop = null;
      r.stop();
    }
    rec.current = null;
    chunks.current = [];
    busy.current = false;
    const now = Date.now();
    if (now - lastStop.current < 3000) {
      for (const j of jobsRef.current) {
        if (!FINISHED.has(j.status) && j.createdAt && now - Date.parse(j.createdAt) < 120_000) void cancelJob(j);
      }
    }
    lastStop.current = now;
    setMode(rest());
  };

  // Background jobs as orbs (like the robot); "your website is done" is spoken when one finishes.
  const seen = useRef(new Set<string>());
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  useEffect(() => {
    if (!active) return;
    let first = true;
    const load = () =>
      api<Job[] | { jobs: Job[] }>('/api/robot/jobs', { quiet: true })
        .then((r) => {
          const list = (Array.isArray(r) ? r : r.jobs).slice(0, 12);
          for (const j of list) {
            if ((j.status === 'done' || j.status === 'failed') && !seen.current.has(j.jobId) && !first) void say(`${j.title ?? 'The job'}: ${j.status === 'done' ? 'done' : 'that failed'}.`, j.character ?? characterRef.current);
            if (FINISHED.has(j.status)) seen.current.add(j.jobId);
          }
          first = false;
          setJobs(list);
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** One question to the HiveBot workflow, streamed: who answers comes first, "say now" lines are spoken in order. */
  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) return;
      // A safety net: something stuck for 5 minutes never keeps the page deaf.
      if (busy.current && Date.now() - busySince.current > 5 * 60_000) stop();
      if (busy.current) return;
      const g = gen.current;
      busy.current = true;
      busySince.current = Date.now();
      stopVoice();
      setMode('thinking');
      const ctl = new AbortController();
      abort.current = ctl;
      let who = characterRef.current;
      let text = '';
      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: guest ? 'hivebot-guest' : 'hivebot',
            stream: true,
            messages: [{ role: 'user', content: q }],
            hivemind_vars: { session: session.current, character: 'auto', locked: guest ? 'true' : 'false', progress: true },
          }),
        });
        if (!res.ok || !res.body) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error?.message ?? `HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const says: Promise<void>[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
            const d = JSON.parse(line.slice(5)) as {
              type?: string;
              character?: string;
              text?: string;
              choices?: { delta?: { content?: string } }[];
              hivemind?: { skip?: string; character?: string; question?: string };
            };
            if (g !== gen.current) continue; // stopped: nothing of this question is shown or spoken any more
            if (d.type === 'route' && d.character) {
              who = d.character;
              setCharacter(d.character);
            }
            if (d.type === 'say' && d.text) says.push(say(d.text, who));
            if (d.hivemind?.skip) setLog((l) => [...l, { who: 'skip', text: `(${d.hivemind!.skip}: "${q.slice(0, 60)}")` }]);
            if (d.hivemind?.character) {
              who = d.hivemind.character;
              setCharacter(who);
            }
            const c = d.choices?.[0]?.delta?.content;
            if (c) text += c;
          }
        }
        await Promise.all(says);
        if (g !== gen.current) return;
        if (text.trim()) {
          setLog((l) => [...l, { who: 'you', text: q }, { who, text: text.trim() }]);
          await say(text.trim(), who);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError' && g === gen.current) toast(`HiveBot: ${(err as Error).message}`);
      } finally {
        // Only when nothing newer started (Stop already reset it; an old question must not clear a new one's state).
        if (g === gen.current) {
          busy.current = false;
          abort.current = null;
          setMode((m) => (m === 'thinking' || m === 'speaking' ? rest() : m));
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guest],
  );

  // ---- the microphone: open conversation (voice detection) or hold to talk ----
  const finishRecording = useCallback(async () => {
    const r = rec.current;
    if (!r || r.state === 'inactive') return;
    const g = gen.current;
    await new Promise<void>((res) => {
      r.onstop = () => res();
      r.stop();
    });
    if (g !== gen.current) return; // Stop during the recording: thrown away
    rec.current = null;
    const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
    chunks.current = [];
    if (blob.size < 2000) return setMode(rest());
    setMode('thinking');
    try {
      const text = await transcribe(blob);
      if (g !== gen.current) return; // Stop while speech-to-text ran: no question
      if (text.trim()) await ask(text);
      else setMode(rest());
    } catch {
      if (g === gen.current) setMode(rest());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const startRecording = useCallback(() => {
    if (!stream.current || rec.current) return;
    chunks.current = [];
    const r = new MediaRecorder(stream.current);
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.start(250);
    rec.current = r;
    setMode('hearing');
  }, []);

  // The microphone with echo cancellation, so it doesn't hear itself; the volume decides when you talk.
  useEffect(() => {
    if (!active || !open || guest === undefined) return;
    let stopped = false;
    let ctx: AudioContext | undefined;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        let loudSince = 0;
        let quietSince = 0;
        let startedAt = 0;
        setMode('listening');
        const tick = () => {
          if (stopped) return;
          an.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((n, v) => n + v * v, 0) / buf.length);
          const now = Date.now();
          const loud = rms > 0.025;
          const m = modeRef.current;
          if (m === 'speaking' && rms > 0.08) stop(); // barge in: talking over it stops everything, then it listens
          if (m === 'listening') {
            if (loud) {
              loudSince ||= now;
              if (now - loudSince > 180) {
                startRecording();
                startedAt = now;
                quietSince = 0;
              }
            } else loudSince = 0;
          } else if (m === 'hearing') {
            if (loud) quietSince = 0;
            else quietSince ||= now;
            if ((quietSince && now - quietSince > silenceMs) || now - startedAt > maxSec * 1000) {
              loudSince = 0;
              void finishRecording();
            }
          }
          requestAnimationFrame(tick);
        };
        tick();
      } catch {
        toast('No microphone: allow it in the browser (on a phone the page needs https)');
        setMode('idle');
      }
    })();
    return () => {
      stopped = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      void ctx?.close();
    };
  }, [active, open, guest, silenceMs, maxSec, startRecording, finishRecording]);

  // Hold to talk: the button or the space bar.
  const holdStart = async () => {
    if (open || busy.current) return;
    stopVoice();
    if (!stream.current) {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        return toast('No microphone: allow it in the browser (on a phone the page needs https)');
      }
    }
    startRecording();
  };
  // H36.4: while it hears you, Enter (with an empty text box) sends at once instead of waiting for the pause.
  useEffect(() => {
    if (!active) return;
    const enter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || modeRef.current !== 'hearing') return;
      if (e.target instanceof HTMLInputElement && e.target.value.trim()) return;
      e.preventDefault();
      void finishRecording();
    };
    window.addEventListener('keydown', enter);
    return () => window.removeEventListener('keydown', enter);
  }, [active, finishRecording]);
  useEffect(() => {
    if (!active || open) return;
    const down = (e: KeyboardEvent) => e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement) && (e.preventDefault(), void holdStart());
    const up = (e: KeyboardEvent) => e.code === 'Space' && !(e.target instanceof HTMLInputElement) && void finishRecording();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  const look = LOOK[character] ?? { color: '#94a3b8', title: character };
  // Running orbs, plus finished ones of the last 10 minutes (old failures don't pile up).
  const shownJobs = jobs
    .filter((j) => !FINISHED.has(j.status) || Date.now() - Date.parse(j.finishedAt ?? j.createdAt ?? '') < 10 * 60_000)
    .slice(0, 8);
  const shownMode: Mode = guest && mode === 'idle' ? 'locked' : mode;
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 py-4">
      <div
        className={`relative flex h-64 w-64 items-center justify-center ${mode === 'hearing' ? 'cursor-pointer' : ''}`}
        title={mode === 'hearing' ? 'Tap to send now' : undefined}
        onClick={() => mode === 'hearing' && void finishRecording()}
      >
        <div
          className="absolute inset-0 rounded-full transition-transform duration-75"
          style={{ background: `radial-gradient(circle, ${look.color}55 0%, ${look.color}11 60%, transparent 70%)`, transform: `scale(${1 + Math.min(0.35, level * 0.5)})` }}
        />
        <div
          className={`relative flex h-44 w-44 items-center justify-center rounded-full border-4 ${mode === 'thinking' ? 'animate-pulse' : ''}`}
          style={{ borderColor: look.color, boxShadow: `0 0 ${20 + level * 60}px ${look.color}` }}
        >
          <div className="flex gap-6">
            {[0, 1].map((i) => (
              <div key={i} className="w-6 rounded-full transition-all duration-75" style={{ background: look.color, height: mode === 'hearing' ? 30 : 20 + level * 26 }} />
            ))}
          </div>
        </div>
      </div>
      <div className="text-center">
        <div className="text-2xl font-semibold" style={{ color: look.color }}>
          {look.title}
        </div>
        <div className="mt-1 text-xs tracking-widest text-slate-400">{MODE_TEXT[shownMode]}</div>
        {mode === 'hearing' && <div className="mt-1 text-xs text-slate-500">tap the face to send</div>}
      </div>

      {shownJobs.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {shownJobs.map((j) => {
            const live = !FINISHED.has(j.status);
            const look =
              j.status === 'done'
                ? 'border-emerald-600 text-emerald-300'
                : j.status === 'cancelled'
                  ? 'border-slate-600 text-slate-400'
                  : j.status === 'failed'
                    ? 'border-red-600 text-red-300'
                    : 'animate-pulse border-sky-500 text-sky-200 hover:border-red-400';
            return (
              <button
                key={j.jobId}
                disabled={!live}
                title={live ? `${j.title ?? 'Job'} · ${j.status} — click to cancel` : `${j.title ?? 'Job'} · ${j.status}`}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${look}`}
                onClick={() => live && confirm(`Cancel "${j.title ?? 'this job'}"?`) && void cancelJob(j)}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: LOOK[j.character ?? '']?.color ?? '#94a3b8' }} />
                {(j.title ?? 'Job').slice(0, 32)}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {!open && (
          <button className="btn min-h-12 px-6" onMouseDown={() => void holdStart()} onMouseUp={() => void finishRecording()} onTouchStart={() => void holdStart()} onTouchEnd={() => void finishRecording()}>
            🎤 Hold to talk (or space)
          </button>
        )}
        <button className="btn-ghost min-h-12 px-5 text-red-300" onClick={stop}>
          ■ Stop
        </button>
      </div>

      <form
        className="flex w-full gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(typed);
          setTyped('');
        }}
      >
        <input className="input flex-1" placeholder='Type, e.g. "Jev, turn on the osan light" or "Ultron, make a website about cats"' value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button className="btn" disabled={!typed.trim()}>
          Send
        </button>
      </form>

      <div className="flex flex-wrap justify-center gap-4 text-xs text-slate-300">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Open conversation (microphone stays on)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> Speak the answers
        </label>
        <label className="flex items-center gap-1.5" title="Locked: the guest workflow, no home control, no rule changes">
          <input type="checkbox" checked={guest} onChange={(e) => setGuest(e.target.checked)} /> Guest (locked)
        </label>
      </div>

      <div className="w-full space-y-2">
        {log.slice(-12).map((l, i) => (
          <div key={i} className={`rounded-lg px-3 py-2 text-sm ${l.who === 'you' ? 'ml-auto max-w-[80%] bg-indigo-600/30 text-right' : l.who === 'skip' ? 'text-center text-xs text-slate-500' : 'max-w-[85%] bg-[#161b22]'}`}>
            {l.who !== 'you' && l.who !== 'skip' && (
              <div className="mb-0.5 text-xs font-semibold" style={{ color: LOOK[l.who]?.color }}>
                {LOOK[l.who]?.title ?? l.who}
              </div>
            )}
            {l.text}
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-slate-500">
        Each tab is its own conversation. Say a name (Jev, Jarvis, Ultron, Vision, Ghost) first; without a name whoever answered goes on for a minute.
        The names and how they are misheard are in Memory → hivebot/rules/names.md.
      </p>
    </div>
  );
}
