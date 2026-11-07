#!/usr/bin/env python3
"""HiveMind's bridge to colibri's own setup code: its model catalog and its resumable Hugging Face downloads.

Every command prints JSON lines on stdout: progress lines while it works, then one result line. Errors are one
line {"type": "error", "message": ...} and exit code 1. The token comes from HF_TOKEN in the environment.

  helper.py catalog <ram_bytes> <models_dir>         the catalog against this RAM and disk, with what is installed
  helper.py download <catalog_id> <models_dir>       one catalog model into <models_dir>/<id> (resumes)
  helper.py gguf <repo> <file_or_pattern> <models_dir> <name>
                                                     a GGUF from Hugging Face, then `coli import` into <models_dir>/<name>
"""
import json
import os
import shutil
import subprocess
import sys
import time

COLI_DIR = os.environ.get("COLIBRI_DIR", "/opt/colibri/c")
sys.path.insert(0, COLI_DIR)

import setup_catalog  # noqa: E402
import setup_download  # noqa: E402


def out(obj):
    print(json.dumps(obj), flush=True)


def progress_printer(label):
    last = [0.0]

    def progress(ev):
        now = time.time()
        if now - last[0] >= 1 or ev.get("done") == ev.get("total"):
            last[0] = now
            out({"type": "progress", "label": label, "done": ev.get("done", 0), "total": ev.get("total", 0), "file": ev.get("file", "")})

    return progress


def cmd_catalog(ram, models_dir):
    os.makedirs(models_dir, exist_ok=True)
    disk = shutil.disk_usage(models_dir).free
    downloaded = {}
    for entry in setup_catalog.catalog():
        folder = os.path.join(models_dir, entry.id)
        manifest = setup_download.read_manifest(folder)
        if manifest:
            downloaded[entry.id] = setup_download.bytes_present(folder, manifest.get("files", []))
    rows = setup_catalog.recommend(ram, disk, downloaded=downloaded, include_images=False)
    models = []
    for row in rows:
        item = setup_catalog.as_dict(row)
        folder = os.path.join(models_dir, row["entry"].id)
        item["dir"] = folder
        item["installed"] = setup_download.is_complete(folder)
        item["downloaded_bytes"] = downloaded.get(row["entry"].id, 0)
        item["size_class"] = row["entry"].size_class
        models.append(item)
    out({"type": "result", "disk_free": disk, "models": models})


def cmd_download(model_id, models_dir):
    entry = setup_catalog.by_id(model_id)
    folder = os.path.join(models_dir, entry.id)
    token = setup_download.hf_token()
    out({"type": "progress", "label": "Listing files", "done": 0, "total": 0, "file": ""})
    files = setup_download.list_repo_files(entry.repo, entry.revision, include=entry.include, exclude=entry.exclude, token=token)
    setup_download.download_repo(entry.repo, entry.revision, folder, files, token=token, progress=progress_printer(entry.name))
    out({"type": "result", "dir": folder})


def cmd_gguf(repo, pattern, models_dir, name):
    token = setup_download.hf_token()
    src = os.path.join(models_dir, ".gguf", name)
    target = os.path.join(models_dir, name)
    wanted = (pattern,) if any(c in pattern for c in "*?[") else (pattern, pattern.replace("-00001-of-", "-*-of-"))
    files = setup_download.list_repo_files(repo, "main", include=wanted, token=token)
    files = [f for f in files if f["path"].endswith(".gguf")]
    if not files:
        raise setup_download.DownloadError(f"{repo}: no .gguf file matches {pattern}")
    setup_download.download_repo(repo, "main", src, files, token=token, progress=progress_printer(name))
    first = sorted(f["path"] for f in files)[0]
    out({"type": "progress", "label": "Importing (coli import)", "done": 0, "total": 0, "file": first})
    rc = subprocess.call([sys.executable, os.path.join(COLI_DIR, "coli"), "import", os.path.join(src, first), "--out", target], stdout=sys.stderr)
    if rc:
        raise RuntimeError(f"coli import failed (exit code {rc})")
    out({"type": "result", "dir": target})


def main(argv):
    try:
        if argv[:1] == ["catalog"] and len(argv) == 3:
            return cmd_catalog(int(argv[1]), argv[2])
        if argv[:1] == ["download"] and len(argv) == 3:
            return cmd_download(argv[1], argv[2])
        if argv[:1] == ["gguf"] and len(argv) == 5:
            return cmd_gguf(argv[1], argv[2], argv[3], argv[4])
        raise SystemExit(__doc__)
    except KeyError as err:
        out({"type": "error", "message": f"unknown model {err}"})
    except Exception as err:  # noqa: BLE001 - every failure becomes one readable line
        out({"type": "error", "message": str(err)})
    sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
