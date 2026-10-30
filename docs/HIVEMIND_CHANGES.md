# HiveMind changes for DungeonMind

**Status:** Part 1 (M0 §1–§10) is built (HiveMind milestone 7), and so is **M9** (milestone 9: HiveMind as DungeonMind's training engine — schedules, the training window, training with limited tokens, per-run models, block inputs, live training events; see [M9](#m9--hivemind-as-dungeonminds-training-engine)). Part 2 (the D&D Lab) was built as L1–L4 and has **moved to DungeonMind** in M9: HiveMind keeps only the generic datasets and training. Notes on how it was built are marked *Built:*. User guides: [lab.md](lab.md), [decisions.md](decisions.md).
## Why

**DungeonMind** (`github.com/turkushan490/dungeonmind`, separate repo, AGPL-3.0) is a self-hostable website where groups play D&D 5e together with an **AI Dungeon Master**. DungeonMind owns the game: sheets, dice, rules math, saves. It uses **HiveMind for all AI**: LLMs, ComfyUI images and memory.

DungeonMind talks to HiveMind **server-to-server**. That's why CORS isn't needed. It authenticates with one HiveMind API token. It installs its own canvases into HiveMind and runs them many times per game.

The file has two parts:

- **Part 1: API changes (M0).** These are small and generic. Every other HiveMind user benefits from them too.
- **Part 2: Training Lab (L1–L4).** This part is D&D only. It simulates games with fake players, scores models, fine-tunes a fast DM model, and serves it back through Ollama.

Rules for all work in this file:

- Keep the HiveMind style: Node 24 + TS, Fastify, `node:sqlite`, React/Vite/Tailwind, tests in `server/test/`.
- Add a DB migration to `MIGRATIONS` in `server/src/db/index.ts`, guarded by `PRAGMA user_version`.
- Don't break existing canvases. Every new config field is optional and defaults to today's behaviour.

---

# Part 1 — API changes (M0)

## 0. API binding: how DungeonMind uses HiveMind

### Auth

1. The admin creates a token in HiveMind under **Settings → API tokens**. The route behind it is `POST /api/tokens {name:"DungeonMind"}`, which returns `{id, name, token:"hm_…"}`. The token is shown once and stored as a sha256 hash.
2. The admin pastes the URL and the token into DungeonMind's settings, or into the Unraid template env `HIVEMIND_URL` and `HIVEMIND_TOKEN`.
3. Every call sends `Authorization: Bearer hm_…`. The token acts as the user who made it, through `authenticate()` in `server/src/api/auth.ts`. Use a **member** account, not a viewer. Viewers can only run saved canvases and can't install them.

### Endpoints DungeonMind calls

New or changed endpoints are marked ★.

| What | Method + path | Notes |
|---|---|---|
| Compatibility check | ★ `GET /api/health` | Add `features[]` (§9). |
| Install/update a canvas | `PUT /api/canvases/:id` | Already exists. DungeonMind uses fixed ids such as `dnd-narrate` so a re-install overwrites. |
| List canvases | `GET /api/canvases` | Already exists. |
| Start a run | ★ `POST /api/runs` | Adds `vars` (§1). |
| Live events | `GET /api/runs/:id/events` (SSE) | Already exists. Adds `node_done.label` (§5). |
| Final result | ★ `GET /api/runs/:id` | Adds `outputs` per node (§5). |
| Cancel | `POST /api/runs/:id/cancel` | Already exists. |
| Memory: import | ★ `POST /api/memory/keys/:key/import` | §6 |
| Memory: search | ★ `POST /api/memory/keys/:key/search` | §6, for debugging and the DungeonMind rules page. |
| Memory: delete a key | `DELETE /api/memory/keys/:key` | Already exists in `server/src/api/settings.ts`. |
| Image files | `GET /api/files/raw?path=…&inline=1` | Already exists. |

> ⚠️ `/api/memory` and `/api/memory/unload` are the **GPU memory** routes (`server/src/api/memory.ts`). Everything about the memory *block* lives under `/api/memory/keys/*` (`server/src/api/settings.ts`). Keep new routes there.

### Example: one DM turn

```http
POST /api/runs
Authorization: Bearer hm_xxx
{
  "canvasId": "dnd-narrate",
  "question": "Turks: I play a dirge to unsettle the hag. Esvahanna: Guiding Bolt at the hag.",
  "vars": {
    "tableId": "t_8f2k",
    "ruleset": "srd51",
    "campaign": "<full campaign.md>",
    "party": "<party state JSON>",
    "results": "<server dice results JSON>",
    "recent": "<last 12 turns>"
  }
}
→ 200 { "runId": "r_abc" }
```

```http
GET /api/runs/r_abc            (after run_done)
→ 200 {
  "id": "r_abc", "status": "done", "final": "…",
  "outputs": {
    "narration": { "nodeId": "n2", "type": "llm", "text": "The dirge crawls under the hag's skin…" },
    "state":     { "nodeId": "n3", "type": "llm", "text": "{\"deltas\":[…],\"choices\":{…}}" }
  },
  "events": [ … ]
}
```

### Errors (unchanged pattern: `{ error: string }`)

| Code | When |
|---|---|
| 400 | Bad body. Examples: `"Ask a question"`, `"vars must be an object of strings"`, `"Unknown node type"`, or a graph validation message. |
| 401 | No or invalid token. |
| 403 | The role isn't allowed (viewer). |
| 404 | Canvas, run or memory key not found. |
| 409 | `GET /api/runs/:id` while the run is still going. DungeonMind waits for the SSE `event: end` first. |
| 413 | ★ Memory import too large (§6). |

---

## 1. Run variables (`vars`)

**Goal:** pass structured input into a run without packing everything into `question`.

- `POST /api/runs` accepts `vars?: Record<string, string>`. Limits: at most 64 keys, key `^[a-zA-Z0-9_]{1,40}$`, total size ≤ 1 MB, otherwise 400.
- Store `vars` on the run. Add a `runs.vars TEXT` column, which is JSON.
- `{{vars.name}}` gets filled in by the shared `fill()` in `server/src/nodes/index.ts` and by `fillTemplate()` in `server/src/nodes/actions.ts`. It also works in `prompt`, `system`, memory `key`, the image `prompt`, the save `fileName`, and the webhook `body`/`url`.
- An unknown var becomes an empty string. A JSON template escapes its values, as `fillTemplate` already does.
- `NodeContext` gets `vars: Record<string,string>`. `startRun()` in `server/src/events/runs.ts` and `runGraph()` in `server/src/engine/run.ts` pass it on.
- `/v1/chat/completions` (`server/src/api/v1.ts`) accepts the extra body field `hivemind_vars` with the same shape.

**Files:** `packages/shared/src/index.ts` (the `RunRequest` type), `server/src/api/runs.ts`, `server/src/events/runs.ts`, `server/src/engine/run.ts`, `server/src/nodes/index.ts`, `server/src/nodes/actions.ts`, `server/src/api/v1.ts`, `server/src/db/index.ts`.

**Tests:**
- A template node with `"Hi {{vars.name}}"` and `vars:{name:"Turks"}` outputs `Hi Turks`.
- An unknown var outputs an empty string.
- Bad keys return 400.
- `/v1` passes `hivemind_vars` through.

## 2. Chat history passthrough (`/v1`)

**Goal:** OpenAI clients can send a whole conversation. Today only the last user message is used.

- `/v1/chat/completions` turns the incoming messages into `{{system}}` (all system messages joined), `{{history}}` (the earlier turns as `User: …` / `Assistant: …` text) and `{{question}}` (the last user message).
- A new llm-node flag, `config.useMessages?: boolean`. When true, the node sends the **real message list** (system + history + the filled user prompt) to the model, instead of one user message.

**Tests:** a 3-message conversation fills `{{history}}`. With `useMessages`, the provider receives 3+ messages.

## 3. JSON mode per block

**Goal:** blocks that must output structured data (DM state, rolls, sheets, setup forms).

- New fields: `NodeConfig.json?: boolean` and `NodeConfig.jsonSchema?: string`. The schema is text describing the shape, shown to the model, and it can be a JSON Schema.
- For `llm`, `judge` and `router`: when `json` is set, `callModel` sends `ChatRequest.json = true`. That already maps to Ollama `format:'json'` and to OpenAI/Groq `response_format`. The schema text is added to the system prompt.
- **Repair:** the engine `JSON.parse`s the output, stripping ``` fences first. If parsing fails, it does **one** repair call: "Your last answer was not valid JSON: <error>. Reply with only the corrected JSON." Reuse the approach in `server/src/api/builder.ts`. If parsing still fails, the node errors with `Invalid JSON after repair`, so DungeonMind's auto-retry kicks in.
- The node's output text is the normalised JSON string (`JSON.stringify(parsed)`).
- The canvas editor gets a "JSON output" toggle and a schema textarea in the inspector.

**Files:** `packages/shared/src/index.ts`, `server/src/nodes/index.ts`, `server/src/engine/run.ts` (callModel), the web inspector.

**Tests:** a fake provider returns fenced JSON and the output is clean JSON. A fake provider returns bad JSON, then good JSON, and the result is good after one repair. Bad JSON twice gives an error.

## 4. Templated memory key

**Goal:** one canvas, separate memory per campaign.

- The memory `key` is passed through `fill()`, which means `vars` too: `dnd:{{vars.tableId}}`.
- An empty key after filling becomes `default`. Keys are trimmed and at most 120 chars.

**Tests:** two runs with different `tableId` values save under two keys, and recall stays separate.

## 5. Per-node outputs in run results

**Goal:** DungeonMind reads the `narration` block and the `state` block separately.

- The SSE `node_done` event also carries `label`.
- `GET /api/runs/:id` adds `outputs: Record<label, {nodeId, type, text}>`. Labels are the node `label`, or else the node id; duplicates get `#2`. Build it from the stored events, so no new table is needed.
- Skipped and errored nodes are left out of `outputs`, and their status stays in `events`.

**Tests:** a canvas with labelled nodes `narration` and `state` gives both texts in `outputs`.

## 6. Memory search + bulk import

**Goal:** rules knowledge (the whole SRD) and long campaign history in memory. Today recall only returns the **newest N**, which is useless for looking up a rule.

- New memory-block mode `mode: 'search'`. The query is the last upstream text, or else `{{question}}`. It returns the top `limit` entries by relevance. An optional `config.query` template lets the query come from vars, e.g. `{{vars.actions}}`.
- **Search engine:** SQLite **FTS5**, with a virtual table `memory_fts(text, content='memory', content_rowid='id')` kept up to date by triggers and ranked with `bm25()`. Check that the bundled `node:sqlite` has FTS5 compiled in. If it doesn't, fall back to a small in-process BM25 over the key's rows.
- **Bulk import:** `POST /api/memory/keys/:key/import` with body `{ entries: [{text, tags?}], replace?: boolean }`.
  - It accepts at most 20 000 entries and 20 MB, otherwise 413.
  - `replace:true` wipes the key first.
  - It returns `{ imported, key }`.
- **Keep limits:** the existing `KEEP_PER_KEY = 500` in `server/src/services/memory.ts` stays for normal saves. Imported keys have no limit. Mark them with a `memory_keys(owner_id, key, pinned)` row, or a `pinned` column.
- **Search route:** `POST /api/memory/keys/:key/search {query, limit}` returns `[{text, score, at}]`.
- DungeonMind loads `rules:srd51` and `rules:srd52`. Each entry is one rule, spell, condition, feature, item or monster as markdown.

**Files:** `server/src/services/memory.ts` (add `search()` to `NodeServices.memory`), `server/src/nodes/index.ts` (the memory block), `server/src/api/settings.ts`, `server/src/db/index.ts` (migration: FTS table + triggers + pinned).

*Built:*
- The FTS5 table (porter stemming) and its triggers are created at startup, outside the numbered migrations, so a SQLite build without FTS5 still starts. It then uses the BM25 fallback in `services/memory.ts`.
- Migration 9 adds `memory.tags` and `memory_keys(owner_id, key, pinned)`.
- Small words ("the", "at", "ik", "op"…) are left out of the query.
- The search block's output lists the matches separated by `---`.

**Tests:**
- Import 3 entries, then search "grapple" returns the grapple entry first.
- `replace` wipes the key.
- 413 when the import is too big.
- A normal save still trims to 500.

## 7. Image block batch

**Goal:** 4 portrait options in one run.

- New field `NodeConfig.batch?: number` (1–8, default 1) for the image block.
- ComfyUI: set `batch_size` on the EmptyLatentImage node in `txt2imgWorkflow` in `server/src/providers/comfyui.ts`. OpenAI-compatible image APIs: use `n`.
- The output lists every image: `![image](hm-file:…)` once per image.
- The GPU lock and `freeGpu` work as they do today: one job holds the lock.

**Tests:** a fake ComfyUI returns 4 images, and the output has 4 file links.

## 8. Context size per LLM node (`numCtx`)

**Goal:** a big context for the DM. HiveMind never sends `num_ctx` today, so Ollama uses its small default and silently cuts the prompt.

- New fields: `NodeConfig.numCtx?: number` (2048–131072) and `ChatRequest.numCtx?: number`.
- `server/src/providers/ollama.ts`: add `num_ctx` to `options` (next to `temperature` / `num_predict`). Other providers ignore it.
- The inspector gets a "Context size" dropdown (default / 8K / 16K / 32K / 64K / 128K) with a hint that more context means more VRAM.
- Optional: warn in the node's progress line when the prompt token estimate (chars/4) is above `numCtx`.

**Tests:** the provider request body contains `options.num_ctx` when it's set and leaves it out otherwise.

## 9. Feature flags on `/api/health`

`GET /api/health` → `{ ok, version, features: ["vars","history","jsonMode","memoryKeyTemplate","nodeOutputs","memorySearch","memoryImport","imageBatch","numCtx"] }`

*Built:* the list is in `server/src/features.ts`. The decision-model flags `decisionProviders`, `decide` and `autoModel` are added too (see JEV_INTEGRATION.md §6).

DungeonMind shows what's missing and refuses to start a game until the required ones are there. Add each flag in the same commit as its feature. This lives in `server/src/app.ts:54`.

## 10. Nice to have

- **Canvas-scoped tokens:** a token limited to a list of canvas ids and memory key prefixes (`dnd:*`, `rules:*`).
  *Built:* `POST /api/tokens {name, canvases: ["dnd-*"], memory: ["dnd:*", "rules:*"]}`, also in Settings → API tokens.
  - Such a token only reaches the canvas, run, memory, files and `/v1` routes; everything else answers 403.
  - It only sees and installs matching canvases, never runs an ad-hoc graph, and a block using another memory key fails with a clear message.
  - It can't make new tokens.
- **"Tabletop" template set** in `web/src/canvas/templates.ts` with the DungeonMind canvases (below), so people can see and tweak them.
  *Built:* `dnd-setup`, `dnd-adjudicate`, `dnd-narrate`, `dnd-chronicle`, `dnd-ask`, `dnd-sheet`, `dnd-portrait` and `dnd-sim`.

## Implementation order (M0)

1. §9 health features (makes everything after it testable)
2. §1 vars
3. §4 templated memory key
4. §5 node outputs
5. §3 JSON mode
6. §8 numCtx
7. §6 memory search + import
8. §7 image batch
9. §2 history passthrough
10. §10 nice to have

Each step is one commit with its tests and CI green.

## How to test with curl

```bash
H=http://192.168.1.10:4820; T="Authorization: Bearer hm_xxx"
curl -s $H/api/health
# install a test canvas: input -> template "Hi {{vars.name}}" (label greet)
curl -s -X PUT $H/api/canvases/t-vars -H "$T" -H 'content-type: application/json' -d '{"name":"t-vars","nodes":[{"id":"i","type":"input","position":{"x":0,"y":0},"config":{}},{"id":"g","type":"template","label":"greet","position":{"x":200,"y":0},"config":{"prompt":"Hi {{vars.name}}"}}],"edges":[{"id":"e","source":"i","target":"g"}]}'
R=$(curl -s -X POST $H/api/runs -H "$T" -H 'content-type: application/json' -d '{"canvasId":"t-vars","question":"x","vars":{"name":"Turks"}}' | jq -r .runId)
curl -sN $H/api/runs/$R/events -H "$T"          # until event: end
curl -s $H/api/runs/$R -H "$T" | jq .outputs     # { "greet": { "text": "Hi Turks", ... } }
# memory
curl -s -X POST $H/api/memory/keys/rules:test/import -H "$T" -H 'content-type: application/json' -d '{"replace":true,"entries":[{"text":"Grapple: Athletics vs Athletics/Acrobatics"},{"text":"Prone: disadvantage on attacks"}]}'
curl -s -X POST $H/api/memory/keys/rules:test/search -H "$T" -H 'content-type: application/json' -d '{"query":"grapple","limit":3}'
```

## M9 — HiveMind as DungeonMind's training engine

*Built (milestone 9).* DungeonMind now owns everything D&D: simulating games, reviewing turns, the scoreboard,
reports and the nightly promotion of a new DM model. HiveMind is the generic engine underneath: datasets,
training, the training window, schedules and models. The Lab's D&D simulator, review queue and scoreboard are
gone from HiveMind (see Part 2). All bodies are JSON; errors are `{ error }` with the status shown.

### Health flags

`GET /api/health` → `features` also lists `schedules`, `trainingWindow`, `scopedTraining`, `modelOverride`,
`nodeInputs` and `trainEvents`.

### Removed

`GET /api/lab`, `POST /api/lab/start`, `POST /api/lab/stop`, `GET /api/lab/turns`, `PATCH /api/lab/turns/:id`,
`GET /api/lab/export.jsonl`, `GET /api/lab/scoreboard`, `POST /api/lab/default` → 404. The tables `lab_runs` and
`lab_turns` stay (unused), and so does the "DungeonMind DM" dataset with its examples.

### Limited tokens that may train (`scopedTraining`)

`POST /api/tokens` takes two more scope fields:

```json
{ "name": "DungeonMind", "canvases": ["dnd-*"], "memory": ["dnd:*", "rules:*"], "training": true, "datasets": ["DungeonMind*"] }
```

| Field | Type | Meaning |
|---|---|---|
| `training` | boolean, default `false` | May start training jobs and use the jobs it started. |
| `datasets` | string[] | Dataset **names**, exact or ending in `*`. Without it the token reaches no dataset. |

The answer (and `GET /api/tokens`) echoes `scope` with these fields. Any of `canvases`, `memory`, `datasets` or
`training: true` makes the token limited. On top of the canvas, run, memory, files and `/v1` routes, a limited
token may use:

| Route | Needs | Rule |
|---|---|---|
| `GET /api/datasets` | `datasets` | Lists only matching datasets. |
| `POST /api/datasets` | `datasets` | `name` must match, else 403. |
| `GET /api/datasets/:id/items`, `POST /api/datasets/:id/items` | `datasets` | Dataset must match, else 403. |
| `DELETE /api/datasets/items/:itemId` | `datasets` | The item's dataset must match, else 403. |
| `POST /api/lab/train` | `training` | `datasetId` is required and must be a matching dataset; no `flavor` (no Hugging Face machines). |
| `GET /api/lab/train` | `training` | `jobs` holds only the jobs this token started. |
| `GET /api/lab/train/:id`, `POST /api/lab/train/:id/cancel`, `DELETE /api/lab/train/:id`, `GET /api/lab/train/:id/events` | `training` | Only jobs this token started, else 403. |
| `GET /api/lab/window` | `training` | |
| `GET/PUT/DELETE /api/workflows/:id/schedule` | — | Only canvases in `canvases`, else 403. |

Everything else (pause/resume, publish, PATCH or DELETE a dataset, the Lab settings) answers 403
`This API token is limited and may not …`. In runs, the training blocks (Generate examples, Add to dataset, Train,
Evaluate, Deploy) work for a token with `training: true`, but only with matching datasets (a block naming another
dataset fails with `This API token may not use dataset "<name>"`) and Deploy only touches canvases in its scope.
Without `training: true` they fail as before.

### Per-run model override (`modelOverride`)

`POST /api/runs` takes `models`, also from limited tokens:

```json
{ "canvasId": "dnd-narrate", "question": "…", "vars": {}, "models": { "*": { "providerId": "ollama", "model": "dungeonmind-dm:20261030" }, "state": { "providerId": "ollama", "model": "qwen3:8b" } } }
```

- A key is a block (node) id or `"*"`. `"*"` sets the model of every AI model block (`type: "llm"`); a node id sets
  that block's `model` whatever its type and wins over `"*"`. Auto-model blocks given a model use it.
- Only this run changes; the saved canvas does not. The models come from the providers the run uses (the canvas
  owner's, as before).
- 400 when `models` is not an object, a value is not `{providerId, model}` (both non-empty strings), or a key is
  neither `"*"` nor a block id of the workflow (`models: this workflow has no block "<id>"`).

### The messages each block sent (`nodeInputs`)

`GET /api/runs/:id?inputs=1` adds three fields to every entry of `outputs` whose block called a chat model:

```json
"outputs": { "narration": { "nodeId": "n2", "type": "llm", "text": "…", "providerId": "ollama", "model": "qwen3:8b",
  "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }] } }
```

`messages` is exactly what the block's **last** model call sent (blocks that call more than once, like Generate
examples, show the last call). They are stored with the run (`node_done.sent` in the stored events); without
`?inputs=1` they are left out of `outputs`, and `events` (here and in `GET /api/runs/:id/events`) never carry them.
Runs from before M9 have no `messages`.

### Workflow schedules (`schedules`)

A workflow runs by itself at a time of day, on chosen days, in the server's **local time** (`TZ`). One schedule
per workflow and user. Table `workflow_schedules(canvas_id, owner_id, time, days, enabled, last_run_at)`.

| Method + path | Body | Answer |
|---|---|---|
| `GET /api/workflows/:id/schedule` | — | `WorkflowSchedule`; 404 `This workflow has no schedule` (or `Workflow not found`). |
| `PUT /api/workflows/:id/schedule` | `{ time: "HH:MM", days?: ["mon",…,"sun"], enabled?: boolean }` | `WorkflowSchedule`. Creates or updates; omitted fields keep their value (new: every day, enabled). 400 on a bad time/day list, 404 when the workflow isn't yours or shared with you. |
| `DELETE /api/workflows/:id/schedule` | — | `{ ok: true }`; 404 when there is none. |

```json
{ "canvasId": "dnd-nightly", "time": "03:15", "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], "enabled": true,
  "lastRunAt": "2026-10-30T02:15:02.000Z", "nextRunAt": "2026-10-31T02:15:00.000Z" }
```

- `time` is 24-hour `HH:MM`; `days` is any of `mon tue wed thu fri sat sun` (case-insensitive in, lowercase and in
  week order out). `lastRunAt` / `nextRunAt` are ISO UTC; `nextRunAt` only while enabled.
- A minute ticker (`server/src/main.ts`) starts each due workflow like `POST /api/runs {canvasId, question:
  "Scheduled run (HH:MM)"}`, **as the user who set the schedule**, with the saved canvas. It runs once per day it is
  due; a time missed by less than an hour (a restart) still runs, an older one waits for its next time. A run
  that can't start is logged in Problems.
- Every training job a scheduled run starts (Train block) is a nightly job: it waits for the training window.
- Viewers can't set schedules (403).

### Training window (`trainingWindow`)

| Method + path | Body | Answer |
|---|---|---|
| `GET /api/lab/window` | — | `{ start: "03:00", end: "08:00", open: boolean }` (local time, `open` = now) |
| `PUT /api/settings/training` (admin) | `{ start?: "HH:MM", end?: "HH:MM" }` | the same shape; 400 on a bad time or start = end |

Default 03:00–08:00 (Settings → Training). A window may cross midnight (22:00–06:00). `GET /api/lab/train` also
returns it as `window`.

**Nightly jobs** are jobs started with `nightly: true` (`POST /api/lab/train` or the Train block) and every job a
scheduled run starts:
- Outside the window they wait in the new state **`queued`** (note `Waits for the training window (03:00–08:00)`).
- When it opens they queue for the GPU and train as usual.
- When it closes while they train, they pause the way Pause does (a checkpoint after the current step, the GPU is
  free) and go back to `queued`; at the next window start they continue from the checkpoint. Cloud (Hugging Face)
  and ComfyUI jobs wait for the window but don't pause.
- Cancel works while `queued`. After a restart a `queued` job waits again.

### Training jobs

`TrainJob` (`GET /api/lab/train` → `jobs`, `GET /api/lab/train/:id`, `POST /api/lab/train`) gains:
`state: "queued"`, `nightly?: true`, `losses?: [{step, loss}]` (the last 500 logged steps) and
`sample?: {prompt, answer, expected?}` (the trained model's answer to the first example of its dataset, made
after training, before the GGUF export). `TrainBase` gains `vramGb` (about how much GPU memory training needs).

**`POST /api/lab/train`** (changed) — body as before plus `nightly?: boolean`:

```json
{ "datasetId": "…", "base": "unsloth/Qwen3.5-2B", "name": "dungeonmind-dm:20261030", "providerId": "ollama", "epochs": 2, "nightly": true }
```

Without `datasetId` it trains on the "DungeonMind DM" dataset when there is one, else 400 `Pick the dataset to
train on (datasetId)`. Answer: the `TrainJob` (`state` is `queued` for a nightly job outside the window, else
`waiting`).

**`GET /api/lab/train/:id`** (new) → the `TrainJob`; 404 when it isn't yours.

**`DELETE /api/lab/train/:id[?model=1]`** (new) → `{ ok: true, modelDeleted: boolean }`.
- Removes the job record and its folder (dataset copy, checkpoints, GGUF).
- Only finished jobs (`done`, `error`, `cancelled`, `interrupted`) and `paused` ones: anything still running or
  waiting (also `queued`) answers **409** `This job is still running or waiting: cancel it first`.
- `?model=1` (or `true`) also deletes the model the job made from its Ollama, with the same rules as
  `DELETE /api/ollama/:providerId/models` (a shared provider needs an admin, 403). Only for `done` jobs that are
  not image LoRAs; otherwise `modelDeleted` is `false`. When Ollama refuses, the answer is its error (502) and the
  job is kept.
- 404 when it isn't yours.

### Live training events (`trainEvents`)

`GET /api/lab/train/:id/events` — Server-Sent Events (`text/event-stream`), 404 JSON when the job isn't yours. The
first messages replay everything so far, then changes follow about once a second; the stream closes after `end`.
Every message has a named event and one JSON `data` line:

| `event` | `data` | When |
|---|---|---|
| `state` | `{ state, note?, error? }` | The state or its note changed (`state` is a `TrainState`). |
| `progress` | `{ step?, totalSteps?, loss?, etaS? }` | Step, loss or time left changed. |
| `loss` | `{ step, loss }` | Once per logged training step, in order. |
| `log` | `{ source: "trainer" \| "hivemind", line }` | A new log line: the trainer's own (`[download]`, `[train] step …`, `[sample]`, `[gguf] …`, library output) or HiveMind's (waiting for the window or the GPU, starting, pausing, `Importing … into Ollama`, `Ready: …`). |
| `sample` | `{ prompt, answer, expected? }` | The trained model's answer to one example, after training. |
| `end` | `{ state }` | The job reached `done`, `error`, `cancelled` or `interrupted`. |

```
event: state
data: {"state":"training","note":"Training started"}

event: loss
data: {"step":12,"loss":1.4831}

event: log
data: {"source":"trainer","line":"[train] step 12/80 loss 1.4831"}

event: end
data: {"state":"done"}
```

Comment lines (`: ping`) keep the connection open. A paused or queued job keeps the stream open until it ends.

### Train block (`server/src/nodes/training.ts`)

New options (also in the block's settings): `minNewExamples?: number` and `nightly?: boolean`.
- `minNewExamples`: train only when the dataset has at least this many trainable examples that the last **finished**
  (`done`) training of this model name did not have. The model name counts without its tag, so `dm:20261030` and
  `dm:20261031` are the same model. Without such a training, every trainable example counts.
- `nightly`: the job waits for the training window.

The block's output (what the next blocks and `outputs` get) is now JSON:

```json
{ "status": "started", "model": "dungeonmind-dm:20261030", "jobId": "…", "examples": 412 }
```

| `status` | When | `jobId` | `examples` |
|---|---|---|---|
| `started` | The job was queued (the block doesn't wait). | the job | examples in the training set |
| `done` | "Wait until it's ready" was on and the job finished. | the job | examples in the training set |
| `skipped` | Fewer new examples than `minNewExamples`; the run goes on. | `null` | the new examples counted |

For an image LoRA, `model` is the LoRA file once `done`.

---

## The DungeonMind canvases (installed by DungeonMind, documented here)

DungeonMind keeps the JSON in its repo under `hivemind/*.canvas.json` and installs it with `PUT /api/canvases/<id>`. The user picks the models per node in HiveMind afterwards. The defaults come from the Lab scoreboard (Part 2).

| id | Blocks (label) | Output |
|---|---|---|
| `dnd-setup` | input → llm `pitch` (JSON) | Adventure pitches + a **dynamic setup form** `{fields:[{id,label,type:"select|slider|text|multi",options?,min?,max?,default}]}` |
| `dnd-adjudicate` | input → memory search `rules:{{vars.ruleset}}` → llm `rolls` (JSON) | `{rolls:[{pc,kind:"attack|save|skill|damage|heal",stat,dc?,targetAc?,adv,dice?}], resources:[{pc,name,amount}]}`. It never invents results. |
| `dnd-narrate` | input → memory search `dnd:{{vars.tableId}}` + memory search rules → llm `narration` (numCtx 32K) → llm `state` (JSON) → memory save `dnd:{{vars.tableId}}` | `state`: `{deltas, xp, conditions, items, positions:{zone:[names]}, zones:[{name,distances}], choices:{pc:[4 strings]}, speakers:[{name,kind,gender}], image?, sceneEnd}` |
| `dnd-chronicle` | input → llm `patches` (JSON) | `{patches:[{section,op:"replace|append",text}]}` for the campaign.md sections |
| `dnd-ask` | input → memory search rules + campaign → llm `answer` | An out-of-turn answer that doesn't move the story forward |
| `dnd-sheet` | input → memory search rules → llm `sheet` (JSON) | A full legal character sheet. DungeonMind validates it. |
| `dnd-portrait` | input → llm `prompt` → image `portraits` (batch 4) | 4 portrait image links |
| `dnd-sim` | see Part 2 | Simulation turns |

Every prompt gets `{{vars.campaign}}`, `{{vars.party}}`, `{{vars.recent}}` and `{{vars.results}}`. **The numbers are always the server's.** The narrator must use the given dice results and may not change HP, slots or other numbers itself.

---

# Part 2 — Training Lab (D&D only)

> **Moved to DungeonMind (M9).** The simulator, mini bookkeeper, judge, review queue, scoreboard and "Set as
> DungeonMind default" were removed from HiveMind; DungeonMind does them itself and uses HiveMind's datasets,
> training jobs, schedules and the training window over the API ([M9](#m9--hivemind-as-dungeonminds-training-engine)).
> The tables `lab_runs` / `lab_turns` and the "DungeonMind DM" dataset stay. L3 and L4 were built in HiveMind as
> generic training (Lab → New model, Hugging Face Jobs). What follows is the original plan, kept for the record.

**Goal:** a **fast** DM model that tells good dark-fantasy stories and **never misses bookkeeping**: resources used, rolls requested, JSON valid. HiveMind finds it by simulating many games, scoring models, fine-tuning one, and serving it back through Ollama.

**Where:** a new **Lab** tab in HiveMind, with one project, "DungeonMind". It's D&D only on purpose, so keep the code in `server/src/lab/` and `web/src/lab/`, free of general abstractions.

## L1 — Simulator + datasets

- **`dnd-sim` canvas:** an AI DM plus 2–5 **fake players**, each an llm node with a persona prompt:
  - a reckless fighter;
  - a rules-lawyer who tries to cheat resources;
  - a sneaky rogue;
  - a healer;
  - a typo-heavy casual player ("ik cast fierbolt op die gast").
  A **rules-checker judge** (llm, JSON) checks every DM turn against the party state and `rules:srd51` / `rules:srd52` memory search. It looks for:
  - missing roll requests;
  - spent resources that weren't tracked (e.g. a Channel Divinity used while it was at 0/1);
  - invented numbers;
  - invalid JSON;
  - contradictions with campaign.md.
- **Party state while simulating:** the Lab keeps a **mini bookkeeper** in `server/src/lab/state.ts`. It tracks HP, slots, counters `{current,max,recharge}`, conditions and XP for the fake party, so the judge has ground truth. It's replaced by DungeonMind's real Bookkeeper API in DungeonMind M13.
- **Batch runner:** N games × M turns, running in the background. **It runs until stopped by hand**, with Start/Stop buttons and a status panel (games, turns, errors/100, speed). Real runs get priority: a sim turn takes the GPU host lock (`withHostLock` in `server/src/engine/run.ts`) per call and releases it in between, so a real DungeonMind or HiveMind run can go next.
- **Datasets:**
  - Tables `lab_runs` and `lab_turns`. A turn holds `input`, `output`, `verdict` JSON, `error_types[]`, `model`, `tokens_per_s`, and an optional `corrected`.
  - Bad turns get a corrected version (from the judge or a stronger model) and go into a **review queue** in the Datasets tab. Each one can be accepted, edited or rejected.
  - Export is JSONL in chat format (`{"messages":[…]}`) for SFT.
  - Real DungeonMind games can be added later, opt-in per game.

## L2 — Scoreboard

- Per model or prompt version, the scoreboard shows:
  - JSON valid %;
  - rule/number errors per 100 turns;
  - missed resources per 100 turns;
  - story score (1–10, from the judge);
  - average tokens/sec and time per turn;
  - VRAM (from Ollama `ps`).
- **Compare runs:** the same seeded scenarios run on several models, so the comparison is fair. Candidates are picked from what is installed. Suggested ones to try: Qwen 8B/14B, Gemma 12B, Mistral Small / Cydonia 24B, gpt-oss 20B.
- The winner becomes the default model in the DungeonMind canvases, with a "Set as DungeonMind default" button.

## L3 — Local fine-tune (own GPU)

- **Unsloth Docker container** (`unsloth/unsloth`) as a separate Unraid template. HiveMind starts the job over its API, or through `docker exec` from a small helper script on Unraid.
- **QLoRA SFT** on the L1 dataset: on a 16 GB card such as a Tesla T4: fp16, 4-bit load. 7–9B fits comfortably, and 12–14B is tight.
- **GPU:** HiveMind takes the GPU host lock for the whole job and unloads Ollama and ComfyUI first, using the existing `freeGpu`. The UI shows "Training — local AI paused".
- **Output:** a LoRA → merge → **GGUF** (q4_k_m and q8_0) → `ollama create dungeonmind-dm:<version>` from a Modelfile. The new model shows up in HiveMind and on the scoreboard straight away.

## L4 — Hugging Face training + publishing

- **Settings → Hugging Face:** the token is stored encrypted like other provider keys, and there's a **daily GPU-minutes limit**. The default is 40 min/day, and a usage bar shows today's minutes.
- Before **every** job, HiveMind shows the estimated minutes and cost, and the user must confirm.
- ⚠️ **Check first:** HF Pro's daily minutes are **ZeroGPU quota for Spaces**, while **HF Jobs** (`hf jobs uv run` with a TRL/Unsloth script) are billed per use. Find out which one fits:
  - (a) HF Jobs within the budget;
  - (b) a private ZeroGPU Space that trains in short chunks with checkpoints pushed to the Hub;
  - (c) fall back to L3 on the local GPU.
- **Publish:** the merged GGUF goes **public** to the configured HF account (e.g. `turkushan490/dungeonmind-dm-8b-gguf`). It gets a model card (base model, dataset description, scores from L2, license) and is pulled with `ollama pull hf.co/turkushan490/…`. DungeonMind's setup offers this as a one-click model download.
- **Base model licenses:** only use base models whose license allows publishing fine-tunes (Apache-2.0/MIT, e.g. Qwen, Mistral). Record the license in the model card.

## Lab order

L1 can start **right after M0 §1, §3, §5 and §6**, because it needs vars, JSON mode, node outputs and rules search. Running the sim early means data keeps building up while DungeonMind is being built. After that comes L2, then L3 once there are a few thousand reviewed turns, then L4.

## Verification

- **Unit tests:** the mini bookkeeper's counter math, the judge verdict parser, JSONL export format, and that the GPU lock lets a real run in between two sim turns.
- **A 10-turn sim** with a fake provider must produce 10 `lab_turns` and a valid JSONL.
- **On Unraid:** run the sim for 1 hour on a real model, check that the scoreboard numbers look sane, and check that a HiveMind run started by hand during the sim still goes first.

## Built: L1–L2 notes

- Code: `server/src/lab/`:
  - `state.ts`: the bookkeeper;
  - `sim.ts`: personas, seeded scenarios and dice, the dnd-sim graph;
  - `judge.ts`: Jev fast pass, LLM judge, verdict parser;
  - `runner.ts`: background runner;
  - `data.ts`: JSONL and scoreboard.
- API: `server/src/api/lab.ts`. UI: `web/src/lab/LabPage.tsx`. Guide: [lab.md](lab.md).
- Migration 11 adds `lab_runs` and `lab_turns`. Each turn keeps:
  - `input`, `output`;
  - `verdict` (LLM judge plus bookkeeper findings) and `jev_verdict`;
  - `error_types[]` (`json`, `roll`, `resource`, `number`, `contradiction`);
  - `story_score`, `jev_story`;
  - `model`, `prompt_version`, `tokens_per_s`, `ms`;
  - `corrected`, `review`.
- Every sim call (players, DM, judge, Jev) goes through the engine or the host lock one call at a time. A run that
  is waiting for the GPU goes before the sim's next call. A test proves it.
- The "compare runs" option: give several DM models. Game *n* of every model uses the same seed (same scenario,
  party and dice).
- Not built: adding real DungeonMind games to the dataset (opt-in per game). That needs DungeonMind first.

## TODO: L3–L4 (not built)

Out of scope for milestone 7; left for a later milestone:

- **L3:** an Unsloth container template, starting a QLoRA job from HiveMind with the GPU lock held for the whole
  job ("Training — local AI paused"), then LoRA → GGUF → `ollama create dungeonmind-dm:<version>`.
- **L4:** Settings → Hugging Face (encrypted token, daily GPU-minute limit with a usage bar, confirm the estimate
  before every job). First check HF Jobs against ZeroGPU Spaces, then publish the GGUF with a model card. Only
  use Apache-2.0 / MIT base models.

