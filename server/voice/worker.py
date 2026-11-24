"""HiveMind's voice worker: audio prep for voice datasets, cloned voices with Qwen3-TTS (Apache 2.0), and fast
speech to text with faster-whisper (MIT; CTranslate2, MIT).

Started by HiveMind on 127.0.0.1 when needed, stopped after a while without requests.
Usage: worker.py <port> <models dir>
Python packages: qwen-tts with its own transformers (in /opt/voice-lib), onnxruntime and soundfile (/opt/kokoro-lib),
torch, torchaudio and librosa from the image's training stack. ffmpeg cuts audio out of mp3/mp4/m4a.
"""

import gc
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

PORT, MODELS = int(sys.argv[1]), sys.argv[2]
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
SR = 24000
lock = threading.Lock()
state = {"model": None, "device": None, "prompts": {}, "want": "auto"}
# Speech to text has its own lock: a microphone question never waits for a cloned voice that is still speaking.
stt_lock = threading.Lock()
stt = {"model": None, "key": None, "device": None}


def log(*a):
    print(*a, flush=True)


# ---- audio prep ----

def to_wav(src: str, rate: int = SR) -> np.ndarray:
    """Any audio or video file → mono float32 at `rate` (24 kHz for voices, 16 kHz for speech to text) with ffmpeg."""
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "pipe:1"], capture_output=True, timeout=1800)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg could not read {os.path.basename(src)}: {p.stderr.decode()[-300:]}")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9))


def quietest(audio: np.ndarray, a: int, b: int) -> int:
    """The quietest 20 ms in audio[a:b] (where a forced cut hurts least)."""
    n = int(0.02 * SR)
    seg = audio[a:b]
    if len(seg) < 2 * n:
        return b
    fr = seg[: len(seg) // n * n].reshape(-1, n)
    return a + int(np.argmin((fr ** 2).mean(axis=1))) * n + n // 2


def split(audio: np.ndarray, min_sec: float, max_sec: float) -> list:
    """Speech pieces between pauses (librosa's energy split), glued into clips of about 8 s (never over max_sec).
    A cloned voice wants one clean 5-10 s reference; clips glued up to 15 s gave long, mixed references."""
    import librosa

    target = min(8.0, max_sec)
    parts = librosa.effects.split(audio, top_db=35, frame_length=1024, hop_length=256)
    clips, cur = [], None
    for s, e in parts:
        if cur is None:
            cur = [s, e]
        elif (e - cur[0]) / SR <= max_sec and (s - cur[1]) / SR < 0.8 and (cur[1] - cur[0]) / SR < target:
            cur[1] = e
        else:
            clips.append(cur)
            cur = [s, e]
    if cur:
        clips.append(cur)
    out = []
    for s, e in clips:
        # Too long: cut at the quietest moment between 60 % of the target and max_sec, not in the middle of a word.
        while (e - s) / SR > max_sec:
            cut = quietest(audio, s + int(target * 0.6 * SR), s + int(max_sec * SR))
            out.append((s, cut))
            s = cut
        out.append((s, e))
    pad = int(0.15 * SR)
    return [(max(0, s - pad), min(len(audio), e + pad)) for s, e in out if (e - s) / SR >= min_sec]


def quality(x: np.ndarray) -> tuple:
    """(snr, flat): loud speech vs. the quiet parts in dB, and the spectral flatness of the loud parts (hiss, music,
    sound effects score high, a clean voice low). Used to pick the cleanest clip for a cloned voice."""
    n = int(0.03 * SR)
    fr = x[: len(x) // n * n].reshape(-1, n)
    if not len(fr):
        return 0.0, 1.0
    e = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)
    peak = np.percentile(e, 95)
    spec = np.abs(np.fft.rfft(fr * np.hanning(n), axis=1)) + 1e-9
    flat = np.exp(np.log(spec).mean(axis=1)) / spec.mean(axis=1)
    loud = e > peak - 25
    return round(float(peak - np.percentile(e, 10)), 1), round(float(flat[loud].mean() if loud.any() else 1.0), 3)


def prep(body: dict) -> dict:
    """Files → clean clips (WAV, 24 kHz mono 16-bit, about -20 dB), with what was thrown away and why."""
    out_dir, prefix = body["outDir"], body.get("prefix", "clip")
    min_sec, max_sec = float(body.get("minSec", 3)), float(body.get("maxSec", 12))
    os.makedirs(out_dir, exist_ok=True)
    clips, dropped, files = [], {"quiet": 0, "clipped": 0, "silence": 0, "short": 0}, []
    n = int(body.get("start", 1))
    for src in body["inputs"]:
        audio = to_wav(src)
        kept_here = 0
        pieces = split(audio, min_sec, max_sec)
        for s, e in pieces:
            x = audio[s:e]
            level = db(x)
            if level < -45:
                dropped["quiet"] += 1
                continue
            if np.mean(np.abs(x) > 0.99) > 0.01:
                dropped["clipped"] += 1
                continue
            # Mostly silence: under 40 % of the frames have speech energy.
            frames = x[: len(x) // 512 * 512].reshape(-1, 512)
            if np.mean(20 * np.log10(np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-9) > level - 15) < 0.4:
                dropped["silence"] += 1
                continue
            snr, flat = quality(x)
            x = np.clip(x * (10 ** ((-20 - level) / 20)), -1, 1)
            path = os.path.join(out_dir, f"{prefix}_{n:04d}.wav")
            sf.write(path, x, SR, subtype="PCM_16")
            clips.append({"path": path, "seconds": round(len(x) / SR, 2), "db": round(level, 1), "snr": snr, "flat": flat,
                          "source": os.path.basename(src)})
            n += 1
            kept_here += 1
        files.append({"file": os.path.basename(src), "minutes": round(len(audio) / SR / 60, 2), "clips": kept_here, "pieces": len(pieces)})
        log(f"prep {os.path.basename(src)}: {kept_here} clips")
    return {"clips": clips, "dropped": dropped, "files": files}


# ---- cloned voices ----

def load_model(device: str):
    import torch
    from qwen_tts import Qwen3TTSModel

    if state["model"] is not None and state["device"] == device:
        return state["model"]
    unload()
    local = os.path.join(MODELS, MODEL_ID.split("/")[-1])
    if not os.path.exists(os.path.join(local, "speech_tokenizer", "preprocessor_config.json")):
        from huggingface_hub import snapshot_download

        log(f"downloading {MODEL_ID} to {local}")
        snapshot_download(MODEL_ID, local_dir=local)
    if device == "cpu":
        torch.set_num_threads(max(4, (os.cpu_count() or 8) // 2))
    # float32: the T4 can't run this model in float16 (sampling breaks).
    state["model"] = Qwen3TTSModel.from_pretrained(local, device_map="cuda:0" if device == "cuda" else "cpu", dtype=torch.float32, attn_implementation="sdpa")
    state["device"] = device
    state["prompts"] = {}
    log(f"voice model loaded on {device}")
    return state["model"]


def unload():
    if state["model"] is None:
        return
    state["model"] = None
    state["prompts"] = {}
    gc.collect()
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:
        pass


def pick_device(want: str) -> str:
    """auto: the GPU only when it has room (4 GB free), so ComfyUI and Ollama are never pushed out."""
    if want == "cpu":
        return "cpu"
    try:
        import torch

        if torch.cuda.is_available():
            free, _ = torch.cuda.mem_get_info()
            if free > 4e9 or (state["device"] == "cuda" and state["model"] is not None):
                return "cuda"
    except Exception:
        pass
    return "cpu"


def prompt_for(model, voice_file: str):
    """The voice's reference (its best clips joined, with what is said in them), made once per voice version."""
    st = os.stat(voice_file)
    key = (voice_file, st.st_mtime)
    if key in state["prompts"]:
        return state["prompts"][key]
    with open(voice_file) as f:
        v = json.load(f)
    gap = np.zeros(int(0.3 * SR), dtype=np.float32)
    parts, texts = [], []
    for r in v["refs"]:
        a, sr = sf.read(r["audio"], dtype="float32")
        if a.ndim > 1:
            a = a.mean(axis=1)
        parts += [a, gap]
        texts.append(r["text"].strip())
    p = model.create_voice_clone_prompt(ref_audio=(np.concatenate(parts[:-1]), sr), ref_text=" ".join(texts), x_vector_only_mode=False)
    state["prompts"] = {k: p2 for k, p2 in state["prompts"].items() if k[0] != voice_file}
    state["prompts"][key] = p
    return p


def speak(body: dict):
    text = str(body.get("text") or "").strip()[:2000]
    if not text:
        raise ValueError("text is empty")
    state["want"] = body.get("device", "auto")
    device = pick_device(state["want"])
    try:
        model = load_model(device)
    except Exception as e:  # out of GPU memory after all: the CPU
        if device != "cuda":
            raise
        log(f"GPU load failed ({e}); using the CPU")
        unload()
        device = "cpu"
        model = load_model("cpu")
    p = prompt_for(model, body["voiceFile"])
    t = time.time()
    # A length limit (12 codes a second): without it the model may not stop and makes up to 2048 codes (~170 s of
    # audio, many minutes on this machine), blocking every other voice job. About 0.5 s a word, twice that as room.
    words = max(1, len(text.split()))
    max_tokens = int(min(2048, max(96, 12 * (words * 0.5 + 2) * 2)))
    # A bit calmer than the model's own 0.9: fewer made-up noises (HiveMind also checks what was said, and asks again).
    temp = float(body.get("temperature") or 0.7)
    wavs, sr = model.generate_voice_clone(text=text, language=body.get("language", "English"), voice_clone_prompt=p,
                                          max_new_tokens=max_tokens, temperature=temp, subtalker_temperature=temp)
    w = wavs[0]
    speed = float(body.get("speed") or 1)
    if abs(speed - 1) > 0.05:
        import librosa

        w = librosa.effects.time_stretch(np.asarray(w, dtype=np.float32), rate=min(2.0, max(0.5, speed)))
    log(f"speak {len(w) / sr:.1f}s audio in {time.time() - t:.1f}s on {device}")
    return w, sr, device


# ---- speech to text (faster-whisper) ----

# GPU memory a model needs in float16, with room for decoding; below that the CPU (int8) is used, so ComfyUI and Ollama
# are never pushed out.
STT_NEED = {"tiny": 0.6e9, "base": 0.8e9, "small": 1.3e9, "medium": 2.6e9, "large-v3-turbo": 2.4e9, "distil-large-v3": 2.4e9, "large-v3": 4.2e9}


def whisper_class():
    """faster-whisper imports PyAV only for its own audio decoding, which HiveMind never uses (ffmpeg decodes, as for
    voices): an empty stand-in keeps PyAV out of the image."""
    try:
        import av  # noqa: F401
    except ImportError:
        import types

        sys.modules["av"] = types.ModuleType("av")
    from faster_whisper import WhisperModel

    return WhisperModel


def stt_unload():
    if stt["model"] is None:
        return
    stt.update(model=None, key=None, device=None)
    gc.collect()


def stt_device(want: str, name: str) -> str:
    """auto: the GPU when it has room for this model (a model that fell back to the CPU moves back once there is room)."""
    if want == "cpu":
        return "cpu"
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() < 1:
            return "cpu"
        if stt["device"] == "cuda" and stt["key"] == name:
            return "cuda"
        import torch

        need = STT_NEED.get(name, 2.5e9) + (0.5e9 if stt["device"] == "cpu" else 0)
        if torch.cuda.mem_get_info()[0] > need:
            return "cuda"
    except Exception as e:
        log(f"speech to text: no GPU ({e})")
    return "cpu"


def stt_load(path: str, name: str, device: str):
    if stt["model"] is not None and stt["key"] == name and stt["device"] == device:
        return stt["model"]
    stt_unload()
    WhisperModel = whisper_class()
    t = time.time()
    if device == "cuda":
        model = WhisperModel(path, device="cuda", compute_type="float16")
    else:
        model = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=max(4, (os.cpu_count() or 8) // 2))
    stt.update(model=model, key=name, device=device)
    log(f"speech to text: {name} loaded on {device} in {time.time() - t:.1f}s")
    return model


def stt_run(model, audio: np.ndarray, language, vad: bool) -> tuple:
    segments, info = model.transcribe(audio, language=language, beam_size=5, vad_filter=vad, condition_on_previous_text=False)
    # The segments come lazily: joining them is where the work happens.
    return " ".join(s.text.strip() for s in segments).strip(), info


def transcribe(body: dict) -> dict:
    """Body: file (any audio), model (its folder), name (e.g. small), language (empty = detect), device (auto / cpu)."""
    name = str(body.get("name") or "small")
    lang = str(body.get("language") or "").strip() or None
    if name.endswith(".en") or name.startswith("distil-"):
        lang = "en"
    audio = to_wav(body["file"], 16000)
    if audio.size < 1600:
        raise ValueError("the recording is shorter than 0.1 s")
    t = time.time()
    device = stt_device(str(body.get("device") or "auto"), name)
    note = ""
    try:
        model = stt_load(body["model"], name, device)
        text, info = stt_run(model, audio, lang, True)
    except Exception as e:  # GPU libraries missing or out of GPU memory: the CPU, and the reason goes back to HiveMind
        if device != "cuda":
            raise
        note = f"the GPU did not work ({str(e)[:200]}), used the CPU"
        log(f"speech to text: {note}")
        stt_unload()
        device = "cpu"
        model = stt_load(body["model"], name, "cpu")
        text, info = stt_run(model, audio, lang, True)
    # Voice activity detection drops silence (no made-up "Thank you." on a quiet clip), but can drop a very short, soft
    # word as well: nothing heard in a short clip gets one more try without it.
    if not text and audio.size < 16000 * 30:
        text, info = stt_run(model, audio, lang, False)
    ms = int((time.time() - t) * 1000)
    log(f"speech to text: {audio.size / 16000:.1f}s audio in {ms}ms on {device} ({name})")
    return {"text": text, "language": info.language, "device": device, "seconds": round(audio.size / 16000, 2), "ms": ms, **({"note": note} if note else {})}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, json.dumps({"ok": True, "loaded": state["device"], "stt": stt["key"], "sttDevice": stt["device"]}).encode())
        self.send(404, b'{"error":"not found"}')

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            if self.path == "/prep":
                with lock:
                    return self.send(200, json.dumps(prep(body)).encode())
            if self.path == "/speak":
                with lock:
                    w, sr, device = speak(body)
                fd, tmp = tempfile.mkstemp(suffix=".wav")
                os.close(fd)
                sf.write(tmp, np.asarray(w, dtype=np.float32), sr, subtype="PCM_16")
                with open(tmp, "rb") as f:
                    data = f.read()
                os.unlink(tmp)
                return self.send(200, data, "audio/wav", {"x-voice-device": device})
            if self.path == "/transcribe":
                with stt_lock:
                    return self.send(200, json.dumps(transcribe(body)).encode())
            if self.path == "/unload":
                # needBytes: a model that wants the GPU (HiveMind, before an Ollama load). Only when the GPU has too little
                # free room for it does the voice model let go (owner, 2026-11-24: it took 5.7 GB of the T4 between loads,
                # so gemma4:26b and qwen3.5:9b kept pushing each other out and every agent job died).
                need = float(body.get("needBytes") or 0)
                if need:
                    try:
                        import torch

                        if state["device"] != "cuda" or torch.cuda.mem_get_info()[0] >= need * 1.15 + 1.5e9:
                            return self.send(200, b'{"ok":true,"kept":true}')
                    except Exception:
                        return self.send(200, b'{"ok":true,"kept":true}')
                    with lock:
                        unload()
                    log("let go of the GPU for a model load (the voice loads again on the next use)")
                    return self.send(200, b'{"ok":true,"freed":true}')
                with lock:
                    unload()
                with stt_lock:
                    stt_unload()
                return self.send(200, b'{"ok":true}')
            self.send(404, b'{"error":"not found"}')
        except Exception as e:
            log(f"error: {e}")
            self.send(500, json.dumps({"error": str(e)[:1000]}).encode())


def back_to_gpu():
    """A voice that fell back to the CPU (the GPU had < 4 GB free) moves back to the GPU by itself once there is room,
    checked every 2 minutes while it is loaded, instead of staying slow until "keep loaded" runs out."""
    while True:
        time.sleep(120)
        if state["model"] is None or state["device"] != "cpu" or state["want"] != "auto":
            continue
        try:
            import torch

            if not torch.cuda.is_available() or torch.cuda.mem_get_info()[0] < 4.5e9:
                continue
        except Exception:
            continue
        if not lock.acquire(blocking=False):  # speaking right now: try again next time
            continue
        try:
            log("the GPU has room again: moving the voice model back to the GPU")
            load_model("cuda")
        except Exception as e:
            log(f"could not move to the GPU ({e}); staying on the CPU")
            unload()
            try:
                load_model("cpu")
            except Exception:
                pass
        finally:
            lock.release()


threading.Thread(target=back_to_gpu, daemon=True).start()
log(f"voice worker on 127.0.0.1:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
