# Training Lab

The **Lab** tab makes your own AI models: collect examples in **datasets**, then train a base model on them with
**New model**. The result goes into Ollama (or ComfyUI, for picture LoRAs) under its own name; your other models
are not changed. The code lives in `server/src/lab/` and `web/src/lab/`.

The D&D simulator, review queue and scoreboard that used to be here moved to **DungeonMind** (milestone 9).
DungeonMind fills its own datasets and starts training over the API with a limited token; see
[HIVEMIND_CHANGES.md → M9](HIVEMIND_CHANGES.md#m9--hivemind-as-dungeonminds-training-engine) for the exact API.

## Datasets

- Kinds: **text / chat**, **decisions** (for decision models), **pictures** (image LoRAs) and voice.
- Fill them by uploading a file (JSONL, CSV or plain text), typing examples, 👍 on good answers, or from a workflow
  (Generate examples, Add to dataset).
- Examples can wait for **review**; pending and rejected ones are never trained on.
- **Export JSONL** gives what the trainer gets: chat format (`{"messages":[system, user, assistant]}`) for text.
- The "DungeonMind DM" dataset (from the old simulator) stays, with its examples.

## New model

One screen in three steps:

1. **Your data:** pick a dataset; the list shows how many examples are ready. With too few (fewer than 20), the
   page says so and links to the fix: add examples in Datasets, review the waiting ones, or let a workflow write
   them. **Test run anyway** trains on a handful, just to check that training works.
2. **Pick a brain:**
   - **Small & fast** — Qwen3.5 2B;
   - **Balanced** — Qwen3.5 4B;
   - **Smart, slow** — Qwen3 8B.

   Each card says whether it fits the GPU HiveMind found and about how long training takes (rough speeds of a 16 GB GPU, plus
   the first download of the base). **Advanced** holds every base model, any Hugging Face id Unsloth can train, the
   new model's name and its Ollama server, the rounds over the data (epochs), training on a rented Hugging Face
   machine instead, and the trainer's address.
3. **Start.** When the button is grey, its label says why (no dataset, too few examples, no Ollama server, the
   trainer isn't ready, the cloud price is still being worked out). Tick **Only in the training window** to let it
   wait for the night.

The job list shows every job: its state, steps, loss (with a small loss curve), time left, the trainer log and,
after training, a **try-out**: what the new model answered to one example. **Delete** removes a finished, failed or
cancelled job and its files (cancel a running one first); **Delete with model** also removes the model from Ollama.

### How it trains

- **Trainer:** built into HiveMind. The image is based on `unsloth/unsloth:core` (PyTorch, CUDA, Unsloth, TRL,
  llama.cpp) and HiveMind starts the trainer (`server/trainer/server.py`) itself, on localhost only, restarting it if
  it stops. Give the HiveMind container the GPU (Unraid Extra Parameters: `--gpus=all`); without a GPU everything
  else works and training says so. Base models are cached in `/data/trainer-cache`. `TRAINER_URL` (or Advanced)
  can point at a trainer on another machine instead.
- **How:** LoRA (rank 16; 4-bit loading from 4B up). GPUs without bfloat16 (T4) train in float32, as Unsloth's own
  T4 notebooks do. Then a `q4_k_m` GGUF, which HiveMind uploads to Ollama (`/api/blobs` + `/api/create`).
- **GPU:** HiveMind takes the GPU lock for the whole job and frees Ollama and ComfyUI first. Runs started meanwhile
  wait in line. **Pause** saves a checkpoint and frees the GPU; **Resume** continues from it.
- After a HiveMind restart, a job that is still training is followed again.
- Errors (out of GPU memory, a base that can't load, a failed GGUF export) show on the job and in **Problems**,
  with the trainer log.
- **Hugging Face:** connect it under Settings → Hugging Face to rent a bigger GPU for one job (the price is shown
  first and must be confirmed, within a daily limit) and to publish finished models.

## Training window

**Settings → Training** sets the window, 03:00–08:00 by default (server time, `TZ`; it may cross midnight).

- Jobs started with "Only in the training window" (`nightly`), and every job a **scheduled workflow** starts, wait
  as **queued** until the window opens.
- When the window closes while such a job trains, it pauses with a checkpoint (the GPU is free for the day) and
  continues when the window opens again.

## Training from workflows and on a schedule

- The **Train** block starts a job from a workflow. Its output is JSON:
  `{"status": "started" | "done" | "skipped", "model", "jobId", "examples"}`.
  - **Only train when there are at least N new examples** (`minNewExamples`): it counts the examples the last
    finished training of this model name didn't have, and passes with `skipped` when there are fewer.
  - **Only in the training window** (`nightly`).
- **Schedule** (Workflow editor toolbar): the saved workflow runs by itself at a time of day, on the days you pick,
  as you. A workflow that adds examples and ends in a Train block with `minNewExamples` makes a nightly
  "train when there is enough new data" loop.

## Live view over the API

`GET /api/lab/train/:id/events` streams a job as Server-Sent Events: state changes, step/total, loss per step, time
left, the trainer's log lines (download, training, GGUF export, Ollama import) and the try-out answer. Exact shapes
are in [HIVEMIND_CHANGES.md → M9](HIVEMIND_CHANGES.md#live-training-events-trainevents).

## API

| Method + path | What |
|---|---|
| `GET /api/lab/train` | The trainer, the base models, your jobs, Hugging Face and the training window |
| `POST /api/lab/train` | Start a job: `{datasetId, base, name, providerId, epochs?, maxSteps?, allowSmall?, nightly?, flavor?, confirmUsd?}` |
| `GET /api/lab/train/:id` | One job |
| `GET /api/lab/train/:id/events` | Live events (SSE) |
| `POST /api/lab/train/:id/cancel` · `/pause` · `/resume` | Control a job |
| `DELETE /api/lab/train/:id[?model=1]` | Delete a finished job (and its model) |
| `POST /api/lab/train/estimate` · `POST /api/lab/train/:id/publish` | Hugging Face price and publishing |
| `PUT /api/lab/train/settings` | The trainer's address (admin) |
| `GET /api/lab/window` · `PUT /api/settings/training` | The training window (setting it: admin) |
| `GET/PUT/DELETE /api/workflows/:id/schedule` | A workflow's schedule |
| `/api/datasets…` | Datasets and their examples |
