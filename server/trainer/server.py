"""HiveMind trainer: a tiny job server inside the Unsloth container.

HiveMind writes this file (and train.py) into its Lab folder, which the trainer container mounts at /lab.
HiveMind starts one fine-tune at a time over HTTP and polls its progress; train.py does the work.
Only the standard library is used here, so it runs on any Python in the Unsloth image.

Auth: every request needs "Authorization: Bearer <token>", with the token HiveMind wrote to /lab/trainer/token.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LAB = Path(os.environ.get("LAB_DIR", "/lab"))
HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("TRAINER_PORT", "8765"))
# Inside the HiveMind image only HiveMind talks to it: listen on localhost there.
HOST = os.environ.get("TRAINER_HOST", "0.0.0.0")
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{4,64}$")

lock = threading.Lock()
current: dict | None = None  # {"id", "proc", "dir"}


def token() -> str:
    try:
        return (LAB / "trainer" / "token").read_text().strip()
    except OSError:
        return ""


def gpu() -> dict:
    """GPU name and memory, when nvidia-smi is there."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()[0]
        name, used, total = [s.strip() for s in out.split(",")]
        return {"name": name, "usedMb": int(used), "totalMb": int(total)}
    except Exception:  # noqa: BLE001 - no GPU info is not an error
        return {}


def job_dir(job_id: str) -> Path:
    return LAB / "train" / job_id


def read_status(job_id: str) -> dict:
    d = job_dir(job_id)
    try:
        status = json.loads((d / "status.json").read_text())
    except (OSError, ValueError):
        status = {"state": "starting"}
    running = current is not None and current["id"] == job_id and current["proc"].poll() is None
    if not running and status.get("state") in ("starting", "loading", "training", "exporting"):
        # The process ended without writing a final state: it crashed (out of memory, killed).
        code = current["proc"].poll() if current and current["id"] == job_id else None
        status = {**status, "state": "error", "error": status.get("error") or f"The trainer stopped unexpectedly (exit code {code}). See the log."}
    try:
        log = (d / "train.log").read_text(errors="replace")
        status["log"] = log[-4000:]
    except OSError:
        status["log"] = ""
    return status


class Handler(BaseHTTPRequestHandler):
    server_version = "HiveMindTrainer/1"

    def log_message(self, fmt: str, *args) -> None:  # quieter access log
        sys.stderr.write("trainer: " + (fmt % args) + "\n")

    def send(self, code: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self) -> bool:
        t = token()
        if not t or self.headers.get("authorization") != f"Bearer {t}":
            self.send(401, {"error": "Wrong or missing trainer token"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self.authed():
            return
        if self.path == "/health":
            busy = current["id"] if current and current["proc"].poll() is None else None
            return self.send(200, {"ok": True, "busy": busy, "gpu": gpu(), "python": sys.version.split()[0]})
        m = re.match(r"^/jobs/([^/]+)$", self.path)
        if m and JOB_ID.match(m.group(1)):
            if not job_dir(m.group(1)).exists():
                return self.send(404, {"error": "No such job"})
            return self.send(200, read_status(m.group(1)))
        self.send(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        global current
        if not self.authed():
            return
        length = min(int(self.headers.get("content-length") or 0), 1_000_000)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send(400, {"error": "Send JSON"})
        if self.path == "/jobs":
            job_id = str(body.get("id", ""))
            if not JOB_ID.match(job_id):
                return self.send(400, {"error": "Bad job id"})
            d = job_dir(job_id)
            if not (d / "dataset.jsonl").exists():
                return self.send(400, {"error": f"No dataset at {d / 'dataset.jsonl'}"})
            with lock:
                if current and current["proc"].poll() is None:
                    return self.send(409, {"error": f"Job {current['id']} is still training"})
                (d / "job.json").write_text(json.dumps(body))
                log = open(d / "train.log", "ab")  # noqa: SIM115 - kept open by the child process
                proc = subprocess.Popen(
                    [sys.executable, str(HERE / "train.py"), str(d)],
                    stdout=log, stderr=subprocess.STDOUT, cwd=str(d), start_new_session=True,
                )
                current = {"id": job_id, "proc": proc, "dir": d}
            return self.send(200, {"ok": True, "id": job_id})
        m = re.match(r"^/jobs/([^/]+)/cancel$", self.path)
        if m:
            with lock:
                if current and current["id"] == m.group(1) and current["proc"].poll() is None:
                    os.killpg(current["proc"].pid, signal.SIGTERM)
                    deadline = time.time() + 20
                    while current["proc"].poll() is None and time.time() < deadline:
                        time.sleep(0.5)
                    if current["proc"].poll() is None:
                        os.killpg(current["proc"].pid, signal.SIGKILL)
                    (current["dir"] / "status.json").write_text(json.dumps({"state": "cancelled"}))
                    return self.send(200, {"ok": True})
            return self.send(404, {"error": "That job is not running"})
        self.send(404, {"error": "Not found"})


if __name__ == "__main__":
    (LAB / "train").mkdir(parents=True, exist_ok=True)
    print(f"HiveMind trainer on port {PORT}, lab folder {LAB}, GPU {gpu() or 'not found'}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
