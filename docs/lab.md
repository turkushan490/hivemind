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

### Import from Hugging Face

Text / chat datasets have **⬇ Import from Hugging Face** next to Upload. It works for any public dataset; the code is
`server/src/lab/hfImport.ts`.

1. **Paste** a link (`https://huggingface.co/datasets/owner/name`, also with `/tree/main/…` behind it) or `owner/name`.
2. **Preview** shows the name, the license, the number of rows or files, and the first 5 rows.
3. **Map** columns into *Input*, *Output* and optional *System* (several columns in one field are joined with a blank
   line), or use a **preset**: `fireball` for `lara-martin/FIREBALL`, `chat` for a `messages` / `conversations`
   column with `{role, content}` or `{from, value}` messages. A matching preset is picked for you.
4. **Limit:** how many *new* examples to import (5,000 by default, or All).
5. **Import** runs in the background with a live counter and **Stop**; what was imported stays after a Stop.

**Importing again continues** after the last imported example: 5,000 and then another 5,000 gives 10,000, also after
a Stop or a restart. Where an import got to is kept per repo in the dataset (`datasets.sources`); when the dataset
no longer has any example from that repo, the next import starts from the beginning. Nothing resumes by itself after
a restart: press Import again.

How it reads a dataset:

- **Rows API** (most datasets, Parquet too): `datasets-server.huggingface.co`, the `train` split of the first config,
  100 rows a page. A row with a truncated cell is skipped: half a text never becomes a training example.
- **The repo's own files**, when the rows API can't read the dataset (FIREBALL is script-based): its `.jsonl`, `.json`
  and `.csv` files by name, at most 500 MB each. Other files are ignored; lines that can't be read are skipped.
- Only `huggingface.co` and `datasets-server.huggingface.co` are called, with the token from Settings → Hugging Face
  when there is one. A gated dataset needs that token. 429 and 5xx answers are tried three more times.
- Text goes in as it is; lists become one item per line; objects become `key: value` lines.
- Examples are written in batches of 1,000 with source *Hugging Face* and a `ref` (`hf:<repo>:<config>/<split>:<row>`
  or `hf:<repo>:<file>:<line>`). A dataset holds at most **1,000,000 examples**, whatever their source; an import
  stops there.
- The dataset's description gets `Imported from Hugging Face: <repo> (<license>)`, and a published model's card lists
  every imported dataset with its license and link (**Training data**). Check the license before you publish: with
  none listed, the page warns.

**FIREBALL** (`lara-martin/FIREBALL`, D&D played on Discord, CC-BY-4.0, [paper](https://arxiv.org/abs/2305.01528)):
the preset turns each turn into an example. Input: the combat (one line per actor: name, hp, class, race, effects),
whose turn it is, the chat so far and the player's message. Output: the Avrae commands, their results and what was
said after. Empty sections are left out. Discord ids (`speaker_id`, `controller_id`) are never stored or shown.

> **Warnings**
> - **FIREBALL gets a dataset of its own, never "DungeonMind DM"**; the import refuses that. Its outputs are Avrae
>   commands and Discord text, not the DM's JSON. Mixing them makes the DM's JSON worse.
> - **About two thirds of FIREBALL's turns have no story text**, only commands such as `!cast armor of ag -l 2 -i`.
>   A model trained on it also learns to write those.
> - **DungeonMind's nightly training only uses "DungeonMind DM".** Train on FIREBALL by hand in Lab → New model.
> - **Use a limit for training.** 153,829 turns is far too much for one run on a small GPU. Importing all of them is
>   fine; check the time estimate before training.

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
| `POST /api/datasets/:id/import/preview` | Preview a Hugging Face dataset: `{repo}` → `{repo, license, gated, needsToken, route, files, rows, columns, sample, preset, imported, running}` |
| `POST /api/datasets/:id/import` | Start an import: `{repo, preset}` or `{repo, map: {input, output, system?}}`, `limit` (default 5,000; `null` = all) → `202 {jobId}`; 409 while one runs |
| `GET /api/datasets/import/:jobId` | The import: `{state, done, total, skipped, file, files, capped, error}` (only your own; others are 404) |
| `DELETE /api/datasets/import/:jobId` | Stop the import (what was written stays) |

The import routes are not open to limited API tokens.
