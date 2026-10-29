"""HiveMind's Hugging Face helper: cloud training on HF Jobs, and publishing a model to the Hub.

Run by HiveMind as: python hf.py <command> [args]; the token comes in the HF_TOKEN environment variable (never on
the command line). Every command prints one JSON object.

  whoami                              -> {"name"}
  hardware                            -> {"hardware": [{"name", "label", "gpu", "vramGb", "usdPerHour"}]}
  job-start <job dir> <flavor> <hours> -> {"jobId", "repo", "url"}
  job-status <job id> <repo> <job dir> -> {"stage", "message", "status": {...}}  (downloads the GGUF when done)
  job-cancel <job id>                 -> {"ok"}
  publish <gguf> <repo> <private 0|1> <card.md> -> {"url"}
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

api = HfApi(token=os.environ.get("HF_TOKEN") or None)
# The training stack of the HiveMind image, so a cloud job trains exactly like a local one.
IMAGE = os.environ.get("HF_TRAIN_IMAGE", "unsloth/unsloth:core")
PY = "/opt/unsloth-venv/bin/python"


def out(data: dict) -> None:
    print(json.dumps(data), flush=True)


def whoami() -> None:
    out({"name": api.whoami()["name"]})


def hardware() -> None:
    rows = []
    for h in api.list_jobs_hardware():
        d = h.__dict__ if hasattr(h, "__dict__") else dict(h)
        acc = d.get("accelerator") or {}
        acc = acc if isinstance(acc, dict) else getattr(acc, "__dict__", {})
        if not acc:
            continue  # CPU-only machines can't train
        cost = d.get("unit_cost_usd") or d.get("unitCostUSD") or 0
        unit = str(d.get("unit_label") or d.get("unitLabel") or "minute")
        rows.append(
            {
                "name": d.get("name"),
                "label": d.get("pretty_name") or d.get("prettyName") or d.get("name"),
                "gpu": acc.get("model"),
                "count": int(acc.get("quantity") or 1),
                "vramGb": int(str(acc.get("vram", "0")).split()[0] or 0),
                "usdPerHour": round(float(cost) * (60 if unit.startswith("minute") else 1), 4),
            }
        )
    out({"hardware": rows})


REMOTE = r"""
set -u
export HF_HOME=/tmp/hf
cd /job
upload() { $PY -c "
import sys
from huggingface_hub import HfApi
HfApi().upload_folder(folder_path='/job', repo_id='$REPO', repo_type='dataset', allow_patterns=sys.argv[1:], commit_message='progress')
" "$@" >/dev/null 2>&1; }
( while sleep 90; do upload status.json train.log; done ) &
$PY /job/train.py /job > /job/train.log 2>&1
upload status.json train.log "$($PY -c "import json; print(json.load(open('status.json')).get('gguf', 'none'))")"
"""


def job_start(job_dir: str, flavor: str, hours: str) -> None:
    d = Path(job_dir)
    user = api.whoami()["name"]
    repo = f"{user}/hivemind-train-{d.name}".lower()
    api.create_repo(repo, repo_type="dataset", private=True, exist_ok=True)
    api.upload_folder(folder_path=str(d), repo_id=repo, repo_type="dataset", allow_patterns=["job.json", "dataset.jsonl", "train.py"], commit_message="training job")
    fetch = f"from huggingface_hub import snapshot_download; snapshot_download('{repo}', repo_type='dataset', local_dir='/job')"
    script = f"set -e; mkdir -p /job; {PY} -c \"{fetch}\"; export PY={PY} REPO={repo}; " + REMOTE
    job = api.run_job(
        image=IMAGE,
        command=["bash", "-c", script],
        secrets={"HF_TOKEN": os.environ["HF_TOKEN"]},
        flavor=flavor,
        timeout=f"{max(1, round(float(hours) * 60))}m",
        labels={"app": "hivemind"},
    )
    out({"jobId": job.id, "repo": repo, "url": getattr(job, "url", None)})


def job_status(job_id: str, repo: str, job_dir: str) -> None:
    info = api.inspect_job(job_id=job_id)
    st = getattr(info, "status", None)
    stage = str(getattr(st, "stage", "") or "")
    message = getattr(st, "message", None)
    d = Path(job_dir)
    status: dict = {}
    try:
        p = hf_hub_download(repo, "status.json", repo_type="dataset", force_download=True)
        status = json.loads(Path(p).read_text())
        log = hf_hub_download(repo, "train.log", repo_type="dataset", force_download=True)
        status["log"] = Path(log).read_text(errors="replace")[-4000:]
    except Exception:  # noqa: BLE001 - nothing uploaded yet
        pass
    if status.get("state") == "done" and status.get("gguf"):
        dest = d / status["gguf"]
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            p = hf_hub_download(repo, status["gguf"], repo_type="dataset")
            shutil.copyfile(p, dest)
    out({"stage": stage, "message": message, "status": status})


def job_cancel(job_id: str) -> None:
    api.cancel_job(job_id=job_id)
    out({"ok": True})


def publish(gguf: str, repo: str, private: str, card: str) -> None:
    api.create_repo(repo, repo_type="model", private=private == "1", exist_ok=True)
    api.upload_file(path_or_fileobj=card, path_in_repo="README.md", repo_id=repo, commit_message="Model card")
    api.upload_file(path_or_fileobj=gguf, path_in_repo=Path(gguf).name, repo_id=repo, commit_message="GGUF from HiveMind")
    out({"url": f"https://huggingface.co/{repo}"})


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    try:
        {"whoami": whoami, "hardware": hardware, "job-start": job_start, "job-status": job_status, "job-cancel": job_cancel, "publish": publish}[cmd](*args)
    except Exception as err:  # noqa: BLE001 - HiveMind shows the message
        out({"error": f"{type(err).__name__}: {err}"[:800]})
        sys.exit(1)
