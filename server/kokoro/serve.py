"""Built-in text to speech for HiveMind: Kokoro (kokoro-onnx) behind the OpenAI /v1/audio/speech API.

HiveMind starts this on 127.0.0.1 when a voice is needed and stops it after a while without requests.
Usage: serve.py <port> <model.onnx> <voices.bin>
Only the standard library plus kokoro-onnx (installed into its own folder in the image): nothing else is touched.
"""

import io
import json
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

PORT, MODEL, VOICES = int(sys.argv[1]), sys.argv[2], sys.argv[3]
kokoro = Kokoro(MODEL, VOICES)
lock = threading.Lock()
VOICE_NAMES = sorted(kokoro.get_voices())
# American voices start with "a", British with "b"; other letters are other languages.
LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}


def to_mp3(wav: bytes) -> bytes | None:
    if not shutil.which("ffmpeg"):
        return None
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "mp3", "-b:a", "96k", "pipe:1"], input=wav, capture_output=True, timeout=60)
    return p.stdout if p.returncode == 0 and p.stdout else None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, code: int, message: str):
        self.send(code, json.dumps({"error": {"message": message}}).encode(), "application/json")

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, b'{"ok":true}', "application/json")
        if self.path.startswith("/v1/audio/voices"):
            return self.send(200, json.dumps({"voices": VOICE_NAMES}).encode(), "application/json")
        self.error(404, "not found")

    def do_POST(self):
        if not self.path.startswith("/v1/audio/speech"):
            return self.error(404, "not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except ValueError:
            return self.error(400, "the body is not JSON")
        text = str(body.get("input") or "").strip()[:4000]
        if not text:
            return self.error(400, "input is empty")
        voice = str(body.get("voice") or "af_heart")
        if voice not in VOICE_NAMES:
            return self.error(400, f'Kokoro has no voice "{voice}" (it has: {", ".join(VOICE_NAMES)})')
        try:
            speed = min(4.0, max(0.25, float(body.get("speed") or 1.0)))
        except (TypeError, ValueError):
            speed = 1.0
        with lock:
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=LANG.get(voice[0], "en-us"))
        buf = io.BytesIO()
        sf.write(buf, samples, rate, format="WAV")
        wav = buf.getvalue()
        if body.get("response_format") == "mp3":
            mp3 = to_mp3(wav)
            if mp3:
                return self.send(200, mp3, "audio/mpeg")
        self.send(200, wav, "audio/wav")


print(f"kokoro: {len(VOICE_NAMES)} voices, listening on 127.0.0.1:{PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
