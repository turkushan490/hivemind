"""HiveMind's voice worker: audio prep for voice datasets, and cloned voices with Qwen3-TTS (Apache 2.0).

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
state = {"model": None, "device": None, "prompts": {}}


def log(*a):
    print(*a, flush=True)


# ---- audio prep ----

def to_wav(src: str) -> np.ndarray:
    """Any audio or video file → 24 kHz mono float32 (ffmpeg)."""
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"], capture_output=True, timeout=1800)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg could not read {os.path.basename(src)}: {p.stderr.decode()[-300:]}")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


def db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9))


def split(audio: np.ndarray, min_sec: float, max_sec: float) -> list:
    """Speech pieces between pauses (librosa's energy split), merged into clips of min..max seconds."""
    import librosa

    parts = librosa.effects.split(audio, top_db=35, frame_length=1024, hop_length=256)
    clips, cur = [], None
    for s, e in parts:
        if cur is None:
            cur = [s, e]
        elif (e - cur[0]) / SR <= max_sec and (s - cur[1]) / SR < 0.8:
            cur[1] = e
        else:
            clips.append(cur)
            cur = [s, e]
    if cur:
        clips.append(cur)
    out = []
    for s, e in clips:
        # Too long: cut into max_sec pieces.
        while (e - s) / SR > max_sec:
            out.append((s, s + int(max_sec * SR)))
            s += int(max_sec * SR)
        out.append((s, e))
    pad = int(0.15 * SR)
    return [(max(0, s - pad), min(len(audio), e + pad)) for s, e in out if (e - s) / SR >= min_sec]


def prep(body: dict) -> dict:
    """Files → clean clips (WAV, 24 kHz mono 16-bit, about -20 dB), with what was thrown away and why."""
    out_dir, prefix = body["outDir"], body.get("prefix", "clip")
    min_sec, max_sec = float(body.get("minSec", 3)), float(body.get("maxSec", 15))
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
            x = np.clip(x * (10 ** ((-20 - level) / 20)), -1, 1)
            path = os.path.join(out_dir, f"{prefix}_{n:04d}.wav")
            sf.write(path, x, SR, subtype="PCM_16")
            clips.append({"path": path, "seconds": round(len(x) / SR, 2), "db": round(level, 1), "source": os.path.basename(src)})
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
    device = pick_device(body.get("device", "auto"))
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
    wavs, sr = model.generate_voice_clone(text=text, language=body.get("language", "English"), voice_clone_prompt=p,
                                          max_new_tokens=max_tokens)
    w = wavs[0]
    speed = float(body.get("speed") or 1)
    if abs(speed - 1) > 0.05:
        import librosa

        w = librosa.effects.time_stretch(np.asarray(w, dtype=np.float32), rate=min(2.0, max(0.5, speed)))
    log(f"speak {len(w) / sr:.1f}s audio in {time.time() - t:.1f}s on {device}")
    return w, sr, device


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
            return self.send(200, json.dumps({"ok": True, "loaded": state["device"]}).encode())
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
            if self.path == "/unload":
                with lock:
                    unload()
                return self.send(200, b'{"ok":true}')
            self.send(404, b'{"error":"not found"}')
        except Exception as e:
            log(f"error: {e}")
            self.send(500, json.dumps({"error": str(e)[:1000]}).encode())


log(f"voice worker on 127.0.0.1:{PORT}")
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
