# HiveMind changes for DungeonMind

**Status:** Part 1 (M0 §1–§10) is built (HiveMind milestone 7), and so is **M9** (milestone 9: HiveMind as DungeonMind's training engine — schedules, the training window, training with limited tokens, per-run models, block inputs, live training events; see [M9](#m9--hivemind-as-dungeonminds-training-engine)), and **M10** (run limits, `cancelWhenAlone`, an Unload that checks, the Activity page; see [M10](#m10--runs-that-stop-unload-that-unloads-and-the-activity-page)), and **M11** (access profiles per user and per API token, private files, no pulling pictures from ComfyUI; see [M11](#m11--access-profiles-and-private-files)). Part 2 (the D&D Lab) was built as L1–L4 and has **moved to DungeonMind** in M9: HiveMind keeps only the generic datasets and training. Notes on how it was built are marked *Built:*. User guides: [lab.md](lab.md), [decisions.md](decisions.md).
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

## M10 — Runs that stop, Unload that unloads, and the Activity page

*Built (milestone 10).* A local thinking model can loop for many minutes in a run nobody follows, hold the GPU lock
and block every run behind it. These changes put a limit on every model call, stop runs whose client is gone, make
Stop and Unload work on runs that wait or run, and show what is running and what comes in through the API.

### Health flags

`GET /api/health` → `features` also lists `cancelWhenAlone` and `activity`.

### Run limits (Settings → Run limits)

Admin setting `run.limits`: `GET /api/settings/run-limits` (any user), `PUT /api/settings/run-limits` (admin;
only the fields sent change, out-of-range values → 400).

| Setting | Default | Range | Applies to |
|---|---|---|---|
| `maxSeconds` | 600 | 10–86400 | every model call (`call` and `decide`), all providers |
| `maxTokens` | 4096 | 16–32768 | local providers, when the block has no `maxTokens` |
| `numCtx` | 16384 | 2048–131072 | local providers, when the block has no `numCtx` |

- **Time limit.** The timer runs around one model call, after the GPU lock is held: time in the queue doesn't
  count, a cold load does. The provider gets `AbortSignal.any([run, timer])`, so the request to Ollama is aborted;
  a provider that ignores its signal still can't hang the block. The block fails with
  `<model> was stopped after N seconds` (an `error` event, so it is in Problems) and the lock is released. A call
  stopped by the timer is not retried as "only thought". A block's own `maxSeconds` (10–86400, Block settings →
  Time limit) wins over the setting. Image and Train blocks are not timed. `RUN_TIMEOUT_MINUTES` still limits the
  whole run.
- **Token ceiling.** A local model without its own `maxTokens` gets `num_predict` from the setting; cloud models
  still get no cap. Ollama's `done_reason: "length"` (and `finish_reason: "length"` from OpenAI-compatible
  servers) becomes `stopped: "length"` on the `done` chunk, and the run shows the note
  `Stopped at the 4096-token limit` (`node_progress`). The ceiling includes thinking: a thinking model that hits it
  with no answer is asked once more without thinking, as before.
- **Context size.** A local model without its own `numCtx` gets `num_ctx` from the setting, for every block (the
  Voice template's Assistant block used to get Ollama's 4096 and fail on longer prompts). Blocks with their own
  `numCtx` keep it.

### Stop a run when its client is gone (`cancelWhenAlone`)

`POST /api/runs {…, cancelWhenAlone: true}`: the run is cancelled when nobody has followed
`/api/runs/:id/events` for 30 seconds. The clock also starts at run start, for a client that never connects. The
run ends `cancelled`, with `Stopped: nobody followed the run for 30 seconds`. Without the flag (the default, and
every run from the HiveMind screen) a run goes on when the page is closed. `/v1/chat/completions` already stopped
its run when the client went away.

### Stopping a waiting run

`withHostLock(key, fn, { signal, label })`: with a signal, a cancel while waiting for the GPU rejects at once with
`Cancelled`; the queue stays intact (the slot is let go only after the job in front of it), so later runs are not
let through early. The lock remembers who holds each host (`"DungeonMind: chronicler"`, `"Training: dm-v3"`,
`"Image training: …"`) for "Waiting for the GPU behind …". Training and image jobs pass only their label and wait
as before.

### Unload really unloads

`POST /api/memory/unload {providerId?, model?}`:

1. Live runs using or waiting for that model (all models of the provider for "Unload all") are cancelled. An admin
   cancels anyone's; another user only their own: a run of someone else is reported in `failed`
   (`In use by a run of another user (<workflow>)`) and that model is left loaded.
2. Up to 5 seconds for them to end.
3. `keep_alive: 0`.
4. `loaded()` is polled for up to 10 seconds. A model that is still there is reported in `failed` as
   `Still loaded: Ollama did not let it go`, never as unloaded.

The answer is `{unloaded, failed, stoppedRuns}`. A run stopped this way shows `Stopped by Unload`. `GET /api/memory`
adds per model `runs: [{runId, canvasName, state: "waiting" | "running"}]` (an admin sees all, others their own);
the panel lists them under the model, and the button says **Stop & unload**.

### Activity page (`activity`)

Top nav **Activity** (also for viewers), polled every 3 seconds while open. An admin sees everything, anyone else
only their own. Not in `SCOPED_ROUTES`: limited tokens get 403.

- `GET /api/activity/running` → `{runs, training}`. Each run: `runId, canvasId, canvasName, source, owner, mine,
  startedAt, question` (the first 200 characters) and `blocks: [{nodeId, label, providerId, model, state,
  startedAt, tokens, waitingBehind?}]` (tokens counts thinking too). `training` lists jobs that hold or wait for
  the GPU (read-only; the page links to Lab). The page has **Stop** (`POST /api/runs/:id/cancel`) and opens the
  live run (`/api/runs/:id/events`, which a full admin may now follow for anyone's live run).
- `POST /api/runs/:id/cancel` works for the run's owner and for a full admin (not a limited token); everyone else
  gets 404, as before.
- `runs.source` (migration 16): `Screen`, `API: <token name>`, `/v1: <token name>`, `Schedule` or `Batch`.
  `GET /api/runs` returns it as `source`; Run history shows it.
- `GET /api/activity/calls?limit=200&token=<name>&failed=1`: every request made with an API token (scoped or full,
  `/v1` too), newest first, from an in-memory ring of the last 1,000 (nothing in the database; screen traffic is
  not logged). Each line: `at, token, user, method, route, status, ms`, and for `POST /api/runs` and
  `/v1/chat/completions` also `runId` and `canvasName`. `route` is the route pattern (`/api/runs/:id`), never the
  URL; headers, bodies and query strings are never kept. One `onResponse` hook in `server/src/app.ts` writes it
  (an event stream gets its line when it ends).

### Stale rows

At startup, before the server takes requests, runs still on `running` (the previous process never finished them)
become `error`, with `Stopped by a restart` stored as an error event (`closeStaleRuns()` in `server/src/main.ts`).

### Code

- `server/src/services/runLimits.ts`, `server/src/engine/run.ts` (limits, timer, `withHostLock`, `hostHolder`).
- `server/src/events/runs.ts` (live blocks, `source`, `cancelWhenAlone`, `cancelRun` with a reason, `closeStaleRuns`).
- `server/src/api/memory.ts`, `server/src/api/activity.ts`, `server/src/services/activity.ts`.
- `web/src/pages/ActivityPage.tsx`, `web/src/components/MemoryButton.tsx`, Settings → Run limits, Block settings → Time limit.
- Tests: `server/test/runLimits.test.ts`, `server/test/activity.test.ts`.

---

## M11 — Access profiles and private files

*Built (milestone 11).* Before this, every user saw and could use every model of every shared provider (all
ComfyUI checkpoints and LoRAs too), nothing on the server checked which model or LoRA a run used, the Files tab
showed everyone's files, and a Webhook block could ask ComfyUI on the LAN for every picture it ever made. Now the
admin chooses per user and per API token what may be used, and files belong to whoever made them.

### Health flags

`GET /api/health` → `features` also lists `accessProfiles` and `privateFiles`.

### Access profiles (Settings → Access, admins)

A profile says, per provider, which models and LoRAs may be used:

```json
{ "id": "…", "name": "DungeonMind",
  "providers": {
    "<providerId>": { "models": "all" | ["model", "glob*"], "loras": "none" | "all" | ["lora.safetensors", "dnd/*"] } } }
```

- A provider that isn't listed can't be used at all, and a provider with nothing allowed doesn't show anywhere.
- Globs only know `*` (`dnd/*` = everything in that folder and below). Matching ignores case, treats `\` as `/`
  (ComfyUI on Windows) and `llama3` as `llama3:latest`. `loras` defaults to `"none"`.
- **Everything** (`everything`) is built in and can't be changed or deleted. Admins always have it.
- **Basic** (`basic`) starts with every shared cloud provider (not Ollama, ComfyUI or decision providers), all
  models, no LoRAs. A shared cloud provider an admin adds later is put into Basic too. The admin changes it freely.
- Providers a user added with their own key are always theirs to use (a token profile can still leave them out).

Who has what:

- **Users:** `users.profile_id`. New users get the "New users get" profile (`access.newUsers`, Basic by default);
  an admin always has Everything, whatever is stored.
- **API tokens:** `api_tokens.profile_id`, optional. A token with a profile gets only what **both** its user and
  that profile allow; without one it has what its user has. Every user may give their own new token a profile
  (`POST /api/tokens {profileId}`), because it can only narrow; admins set it on any token.
- The migration (17) gives existing non-admin users Basic, and the tokens of admins `everything` (they keep what
  they had); other tokens get none.

Routes (admins): `GET /api/access` (profiles, users with their profile, all tokens, `newUsers`,
`keepComfyCopy`), `POST /api/access/profiles {name, providers}`, `PUT /api/access/profiles/:id`,
`DELETE /api/access/profiles/:id` (not Everything, not the "New users get" one; its users go to that one, its
tokens to none), `PUT /api/access/settings {newUsers?, keepComfyCopy?}`, `PUT /api/access/users/:id {profileId}`,
`PUT /api/access/tokens/:id {profileId | null}`. `GET /api/users` returns `profileId`, `POST /api/users` and
`PATCH /api/users/:id` take it.

### Enforced on the server

One function, `allowedFor(user)` in `server/src/services/access.ts` (the token is part of `req.user`), answers
`provider(id)`, `model(id, name)` and `lora(id, name)`.

- **Lists:** `GET /api/providers`, `GET /api/models`, `GET /api/providers/:id/models`, `GET /api/providers/:id/loras`
  and `GET /api/memory` show only what is allowed (another provider is 404 on the per-provider routes). DungeonMind
  reads its list from the same `GET /api/models` and `/loras`, so it shows players only those; limited (scoped)
  tokens may call these two.
- **Start of a run:** `startRun` checks every block's `model`, `models`, `decider`, `jevScore`, `auto.decider`, the
  Image block's `lora`, and needs one allowed Auto size, after the `models` override is applied. Anything else is
  refused with **403** `You can't use <model> (ask the admin to add it to your access)` (`the LoRA <name>` for a
  LoRA). That covers `POST /api/runs`, `/v1/chat/completions` (OpenAI error format, `model_not_allowed`), batch
  (`POST /api/batch` refuses up front) and schedules (the run doesn't start; Problems shows why).
- **Shared canvases:** a shared canvas of someone else still runs with its owner's providers (`runSetup`), but
  the **caller's** access is checked, so sharing is no way around it.
- **During the run:** `callModel`, `decide` and `generateImage` check again, because Routers and Auto model
  pick models while the run goes. Auto model only offers the decision model the sizes the caller may use. An Image
  block with a LoRA that isn't allowed fails.
- **Elsewhere:** the Builder AI lists (and so proposes) only allowed models and refuses a Builder model that isn't;
  the canvas router (voice, `/v1` model `auto`), the decision test and dataset captioning check their model;
  training targets (Ollama / ComfyUI) are limited to providers the user may use.

### Private files

- Table `files (path, owner_id, created_at)`, filled on every write: uploads, the Save file and Image blocks,
  task imports. Paths stay as they are; the check uses the table. A path without a row is admin-only.
- At the first start after the migration, every file already in the folder goes to the first admin (once; files
  copied into the folder by hand later have no owner).
- Non-admins see, open, use in blocks and delete only their own files: `GET /api/files`, `GET /api/files/raw`,
  `DELETE /api/files`, the run's `readFile` (Decide image input), task exports, pictures added to datasets.
  Someone else's file is "not found", like a missing one. A limited token reaches only its user's files.
- Admins see every file, with an Owner column and an owner filter in Files.
- Run outputs belong to whoever runs the run: a shared canvas run by user B saves into B's files.

### No pulling pictures from ComfyUI

- **Webhook / HTTP block:** in a run of a non-admin, private (LAN) addresses are always refused, whatever
  `BLOCK_PRIVATE_ADDRESSES` says; loopback (including any `localhost` name), link-local and cloud metadata were
  already refused for everyone. Admins keep the old behaviour.
- **Image workflow:** the last node is `PreviewImage` (ComfyUI's `temp` folder, which it clears on its own restart)
  instead of `SaveImage`. HiveMind downloads the picture right away into the owner's Files. **Settings → Access →
  "Keep a copy in ComfyUI's output folder"** (`access.keepComfyCopy`, off by default) brings back `SaveImage`.
- **Don't publish ComfyUI's own port** outside your LAN. Anyone who reaches it can list and download every picture
  through `/history` and `/view`, and HiveMind can't protect that.

### Code

- `server/src/services/access.ts`, `server/src/api/access.ts`, migration 17 in `server/src/db/index.ts`.
- `server/src/api/providers.ts` (`usableRows`, `allowedModelsOf`), `server/src/events/runs.ts` (check at start),
  `server/src/engine/run.ts` (`deps.access`, checks per call), `server/src/nodes/index.ts` (Auto model).
- `server/src/services/files.ts` (owners), `server/src/services/net.ts`, `server/src/providers/comfyui.ts`.
- `web/src/pages/Access.tsx`, the profile dropdowns in Settings → Users and API tokens, the Owner column in Files.
- Tests: `server/test/access.test.ts`, `server/test/privateFiles.test.ts`, `server/test/accessMigration.test.ts`,
  `server/test/comfyui.test.ts`, `server/test/actions.test.ts`.

---

## M12 — Projects, builds, GitHub, Pause, For each and skills

*Built (milestone 12).* Before this, the Website templates made one HTML file, the Save file block wrote one file to
`outputs/` and never into a folder you choose, nothing read a folder back into a run, no block could wait for a
person, and there was no git. Now a project is a folder that stays, workflows read and write it, build it with npm,
push it to GitHub and stop for a check first. The user guide is [docs/projects.md](projects.md).

### Health flags

`GET /api/health` → `features` also lists `projects`, `projectBuild`, `github`, `pause` and `skills`.

### Projects

- Table `projects (id, owner_id, name, folder, github_repo, github_branch, created_at, updated_at)`, folder
  `files/projects/<id>/`; `project_changes` keeps what each run or edit changed (the last 500 per project).
- `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, `GET /api/projects/:id/tree` (files, folders and a
  fresh preview link), `GET|PUT|DELETE /api/projects/:id/file?path=` (`PUT` takes `{text}` or the raw file as
  `application/octet-stream`), `POST /api/projects/:id/folder {path}`, `POST /api/projects/:id/move {from, to}`,
  `GET|POST /api/projects/:id/zip`, `GET /api/projects/:id/history`. Owner or full admin; anyone else gets 404.
- Project files never show in the Files tab, and `/api/files` can't write into `projects/`.
- **Preview:** `GET /api/projects/preview/<token>/<path>` with a signed token (12 hours, HMAC with the server's key),
  without a login, served with `Content-Security-Policy: sandbox allow-scripts …` and no `allow-same-origin`, so the
  page can't use the HiveMind session or read its pages.

### Blocks

`readProject`, `writeFiles`, `updateNotes`, `git`, `build`, `pause`, `foreach`, `collect`. New `NodeConfig`
fields: `project` (id, name or a template; empty = `vars.project`), `globs`, `budget`, `onlyNamed`, `writeMode`,
`optionalWrite`, `gitAction`, `message`, `branch`, `script`, `outDir`, `title`, `timeoutMinutes`, `onTimeout`,
`maxItems`, `skills`, `skillMode`.

- **For each … Collect** (`server/src/engine/graph.ts` `loopsOf`, `server/src/engine/run.ts` `runLoop`): each For
  each needs exactly one Collect after it; the blocks between them may only take input from inside the loop or from
  blocks before the For each, and only feed blocks inside it or the Collect. Loops can't be nested. Each item gets a
  fresh pass; the Collect gets `### Item n: <name>` sections in order. An item that fails doesn't stop the others.
- **Reject branch:** the spec asked for a second handle on the Pause block. Branches in HiveMind go by the name of
  the block wired after (Router, Decide), so the Reject branch is every block wired after a Pause whose name starts
  with "rejected". No new edge field was needed.

### Pause

- Run status `paused` while any Pause waits; events `paused` (with `pause: PauseInfo`) and `resumed` (`action`).
- `POST /api/runs/:id/resume {action, text?, comment?, nodeId?}`: owner or full admin; limited tokens their own runs
  (in `SCOPED_ROUTES`). Stop also cancels the run.
- The run's `RUN_TIMEOUT_MINUTES` clock and the `cancelWhenAlone` clock stand still while it waits. A Pause holds
  no GPU lock. `closeStaleRuns()` also closes `paused` rows.
- `GET /api/activity/running` → each run has `paused: PauseInfo[]`.

### Builds

- The runtime image now has `npm`, `npx`, `git` and the user `hmbuild` (the Dockerfile checks all four).
- `server/src/services/build.ts`: copy to `/data/builds/<id>`, run as `hmbuild` when HiveMind is root, environment
  only `PATH`, `HOME`, `NODE_ENV` and npm settings, 10-minute limit (the whole process group is killed), 2 MB log,
  output folder copied back. `lockDataDir()` at start-up makes `/data` `711` and its entries `700`/`600` (except
  `builds` and `cache`), so the build user can't read the database, the key or other files.
- `POST /api/projects/:id/build {script?, outDir?}` → `BuildResult {ok, log, outDir, ms}`. Not for limited tokens.
- The spec's test used a small Vite project; the test uses a project without packages instead, so CI doesn't depend
  on the npm registry. It checks the same things: the build runs, the output comes back, no secret leaks, the limit
  stops it.

### GitHub

- Table `github_accounts (user_id, token_enc, last4, login, author_name, author_email)`.
- `GET/PUT/DELETE /api/settings/github`, `POST /api/settings/github/test`, `GET /api/github/repos`.
- `POST /api/projects/:id/git/connect {repo, branch?, create?}`, `…/git/disconnect`, `…/git/commit {message}`,
  `…/git/push`, `…/git/pull`, `…/git/pr {title, body?, branch?}`, `GET /api/projects/:id/git` (status).
- `server/src/services/git.ts` runs the git CLI with hooks off, links written as files, no system or user config,
  no prompts, `file://` and `ext::` remotes off; the token only as an `http.extraheader` through `GIT_CONFIG_*`
  environment variables. Never `--force`. Pull is fetch + rebase (with uncommitted edits committed first); a conflict
  is aborted and named.
- Tests point `HIVEMIND_GIT_REMOTE_BASE` at a folder of bare repos instead of github.com.

### Skills

- Table `skills (id, owner_id, name, description, shared, folder, updated_at)`, files in `/data/skills/<id>/`.
- `GET/POST /api/skills` (`{skillMd}`), `POST /api/skills/import` (a zip), `POST /api/skills/import/github {repo,
  path?, ref?}`, `GET /api/skills/:id`, `GET|PUT|DELETE /api/skills/:id/file`, `DELETE /api/skills/:id`,
  `PUT /api/skills/:id/shared` (admins), `GET /api/skills/:id/zip`. Limited tokens: `GET /api/skills` only.
- `withSkills()` in `server/src/nodes/index.ts` (LLM, Review, Judge). **Auto** always uses the short picker call:
  no provider adapter supports tool calls yet, so the `load_skill` / `read_skill_file` tools of the spec are left
  for when one does. The Builder AI doesn't use skills yet.

### Later additions

- **Runs go on after a restart:** `runs.checkpoint` (migration) holds how a run was started, what its blocks did and
  its events (without tokens), updated after every block and For each item (`EngineDeps.save` / `resume`). At
  start-up `resumeStoppedRuns()` (`server/src/api/runs.ts`) starts them again as the same user; runs that can't go on
  are closed (`Stopped by a restart`). Not for limited API tokens, `/v1` chats or `cancelWhenAlone` runs.
- **Decide → `questionsFromInput`:** the questions come from the text wired in (`{"questions": [...]}`, written by a
  model); the output adds `decided: {name: answer}`. No questions: it passes without calling the model.
- **Web search:** source `duckduckgo` (keyless HTML results), `readPages` (0-3: the text of the first pages found,
  public addresses only, every redirect checked) and `searchList` (search each item of a list, at most 5).
- **Build:** `buildFailOk` (a failed build passes `BUILD FAILED` and its log on) and `buildOptional` (no
  `package.json`: passes).
- Templates `software-builder` (Coding), `site-push`; the site templates use a fast model to work, a strong one to
  check, and a decision model for the small choices.
- `unraid/update.sh` takes a lock, so two updates never recreate the container at once.

### Templates

`site-builder` (Site builder (project)) and `site-quick` (Site: quick change) in the Website group. Picking one asks
which project it works on, and can make a new one.

### Code

- `server/src/services/projects.ts`, `diff.ts`, `build.ts`, `git.ts`, `skills.ts`, `projectRun.ts`;
  `server/src/api/projects.ts`, `server/src/api/skills.ts`; `server/src/nodes/projects.ts`; the last migration in
  `server/src/db/index.ts`.
- `web/src/pages/ProjectsPage.tsx`, `web/src/pages/GithubSkills.tsx`, `web/src/components/PausePanel.tsx`,
  `web/src/canvas/ProjectSettings.tsx`.
- Tests: `server/test/projects.test.ts`, `pause.test.ts`, `gitProjects.test.ts`, `build.test.ts`, `skills.test.ts`.

---

## M13 — Support for apps like HiveBot

`GET /api/health` → `features` also lists `autoFallback`, `warm`, `ttsVoiceOverride`, `routeInfo`, `managedBy` and
`hivebot` (all of them together).

- **Auto model falls back** (`autoFallback`): when the size the decision model picked fails because the model is
  gone (404, "no longer available"), rate-limited (429), its server fails (5xx) or the network does, the next size
  down answers, then the ones up; each size once per run. The run shows `large failed (…) → medium: …` (with the new
  route) and the Problems tab gets a line. Time limits, refusals and cancels don't fall back; a fixed model never does.
- **Warm models** (`warm`): a block option `keepAlive` (`"30m"`, `"1h"`, …) is sent to Ollama as `keep_alive` on chat
  calls and on Ollama decision models. `POST /api/canvases/:id/warm` loads a workflow's local models without answering
  (Auto model: the decider, small and medium; else the fixed model) → `{warmed: [models], ms}`, or
  `{warmed, busy: true}` at once when an image or training holds the GPU. Limited tokens may warm their own canvases.
- **A voice per request** (`ttsVoiceOverride`): `POST /api/voice/speak {text, voice?, model?, speed?, format?: "mp3" |
  "wav"}`. `voice` may be a name from Settings → Voice → **Voices for apps** (`jarvis = bm_george`), else a voice id
  of the speech server. Callers with an API token use the speech server also when the screen is set to the browser
  voice. Not set up: 502 with `code: "tts_not_configured"`.
- **Which model answered** (`routeInfo`): `/v1/chat/completions` adds `"hivemind": {"route": "small: gemma4:e2b",
  "decider_ms": 412}`; streaming sends it in one extra chunk (with `choices: []`) before `[DONE]`.
- **Installed by an app** (`managedBy`): `PUT /api/canvases/:id {…, managedBy: "hivebot"}` marks a workflow; it stays
  marked until a save sends `managedBy: null`. The editor shows "Installed by HiveBot — the app may update this", and
  saving your own changes there asks first and then clears it (the app then leaves the workflow alone).
- Tests: `server/test/hivebot.test.ts`, `server/test/hivebotApi.test.ts`.

---

## M14 — Deep research

- **Deep search** block (`deepSearch`): searches the web in rounds. Each round reads `pageBatch` new sites (default
  5; a site is never read twice), then decides with `decider` (a decision model: one choice question) or else its own
  `model` (JSON): `enough`, `more_sites`, `many_more_sites` (three times the batch) or `new_query` (its model writes
  other search words). At most `maxPages` sites (default 15, up to 40) and `maxRounds` rounds per search (default 4).
  `searchList` researches each line of the text wired in (or `{"research": [...]}`), sharing the sites out. Output:
  `{"question", "queries", "items": [{url, title, query, text}]}` — a For each goes through `items`.
- DuckDuckGo search can now go several result pages deep (up to 40 results), through the page's own "Next" form.
- **Review panel** block (`panel`): `count` (default 2) different models, picked at random from the pool in
  `models`, each review the text wired in (`system`/`prompt`); a reviewer that fails is replaced by another from the
  pool. Output: one `### Reviewer: <model>` section each.
- Templates (group **Research**): **Deep research** (deep search → each site reviewed by 2 random AIs → memory key
  `research` → 3 AIs read the memory for facts, conflicts, links and gaps → follow-up searches → reviewed → final
  answer with sources), **Deep research: dig deeper** (goes on from the memory), **Research: what do we know?**
  (memory only) and **Research: add notes** (your own data into the memory).
- Tests: `server/test/research.blocks.test.ts`.

## M15 — Colibri inside HiveMind

[Colibri](https://github.com/JustVugg/colibri) (Apache-2.0) runs very large mixture-of-experts models (35B up to
2.8T parameters). It keeps the experts a model uses most on the GPU or in RAM and streams the rest from disk.

- **Image.** A build stage compiles a pinned release (`COLIBRI_REF`, now v2.1.0) twice:
  - for x86-64-v3 CPUs;
  - with CUDA for `CUDA_ARCH` (default `sm_75`; colibri's own release files start at sm_80).
  - The engines built are GLM (`colibri`), `qwen36` and `deepseek-v4`.
  - An engine that fails to build is left out, and the image still builds.
  - Everything lands in `/opt/colibri/{cpu,cuda}/c` with a `build.json`.
- **Engine** (`server/src/colibri/engine.ts`).
  - **Process:** HiveMind starts `coli serve` on `127.0.0.1:8790` (`COLIBRI_PORT`) with one model at a time.
  - **Switching models:** a restart. It waits until no call is using the loaded model.
  - **Unloading:** after `keepAliveMin` minutes, or a block's `keepAlive`.
  - **RAM:** the container's cgroup limit minus 4 GB, or the `ramGb` setting. A model whose catalog minimum is more than that is refused with a clear message.
  - **CUDA fallback:** if the CUDA build won't start (no GPU, a missing library), it falls back to the CPU build.
- **Models** live in `<DATA_DIR>/colibri/models/<id>`. `server/colibri/helper.py` runs colibri's own Python:
  - `setup_catalog.py` gives the catalog with fits / tight / needs-ram / needs-disk against this container.
  - `setup_download.py` downloads from Hugging Face with resume (and the Hugging Face token from Settings).
  - **GGUF import:** downloads the file, then runs `coli import`.
- **Providers**, added by themselves once, when the image has the engine:
  - **`colibri`** (kind `openai`) lists every installed model, and a call loads the model. Giant models are named `… (colibri, slow)`.
  - **`colibri-decisions`** (kind `decision`) answers Decide blocks and the Auto router through `/v1/systemone`, which has the same request and reply as Jev.
  - **GPU queue:** both share it with the Ollama/ComfyUI on the same machine. That machine is `gpuHost`, by default the host of the first local Ollama.
  - **CPU only** (`gpu: off`): colibri never waits for the GPU.
  - **Time limit:** a block without `maxSeconds` gets `callSeconds` (default 7200).
- **API** (admins):
  - `GET /api/colibri/status`
  - `PUT /api/colibri/settings`
  - `GET /api/colibri/catalog`
  - `POST /api/colibri/download {id}`
  - `POST /api/colibri/import {repo, file, name}`
  - `GET /api/colibri/jobs`
  - `POST /api/colibri/jobs/:id/cancel`
  - `DELETE /api/colibri/models/:name`
  - `POST /api/colibri/load {model}`
  - `POST /api/colibri/unload`
  - Feature flag `colibri`.
- **Settings → Colibri:**
  - the engine (CUDA or CPU), RAM against the container limit, free disk;
  - your models (Load now, Delete);
  - downloads with progress;
  - the catalog with fit labels;
  - GGUF import;
  - the settings and the engine log.
- **Template** **Deep research: overnight:**
  - the fast models search, and 2 random AIs review each site;
  - a big slow model (the first `(colibri, slow)` model there is) finds facts, conflicts and links, and writes the answer;
  - those blocks allow 6 hours, with short memory reads (20 notes).
- Template **Colibri: start here** (Everyday): a first colibri workflow.
  - A Decide block on `colibri-decisions` asks one question, "code or chat?".
  - Only the block named after the answer runs (`code` on the coder model, or `chat`).
  - The answer ends with an explanation of every step.
- **Speed for apps (HiveBot):**
  - colibri starts with `--kv-slots` (`kvSlots`, default 4). Each conversation (its system prompt and first question) gets its own slot (`cache_slot`), so a repeated prompt isn't read again, and decisions get the last slot to themselves.
  - It stays loaded for 30 minutes by default.
  - The catalog names are read once at start.
- **Template Train a HiveBot character (colibri teaches):** colibri writes 200 short spoken answers in a character, then a small model trains on them and lands in Ollama.

- **Colibri library** (Settings → Colibri), modelled on the Ollama library:
  - every model family colibri runs (`web/src/pages/colibriModels.ts`), with search, size filters, tags, the fit against colibri's RAM, colibri's speed numbers and Hugging Face links;
  - **Download** for colibri's ready-made versions;
  - **Find GGUF files** searches Hugging Face (`/api/hf/search`, `/api/hf/files`): pick a repo, then a quant, and it is imported (split files as a `-*-of-N` pattern);
  - models that need a PyTorch conversion are marked as such.
- **The image builds every engine** colibri has: qwen38, deepseek_v41, glm53, mimo, olmoe, kimi_k3, inkling, laya and gliner_decide too. `GET /api/colibri/status` lists them (`engines`), and the library marks a family whose engine is missing.

## M16 — Questions with pictures, files and audio; HiveBot S7/S8

- **The question box** (Workflow page and Use page):
  - grows with the text (Enter sends, Shift+Enter is a new line);
  - 📎, drop or paste for attachments;
  - a mic next to it on the Workflow page.
- **What attachments become:**
  - Pictures are uploaded to `uploads/` in your files and go into the question as `![name](hm-file:…)`.
  - PDFs and text/code files go in as their text (100k characters at most).
  - Audio goes in as what is said in it (speech to text).
- **Pictures reach models that can see.** The last user message gets the pictures linked in it (at most 4, 20 MB each) as images: Ollama `images`, OpenAI-compatible `image_url` parts, Anthropic image blocks. A model that refuses them is asked again with the text only, and a progress note says so.
- **Home Assistant block "Ask (Assist)"** (`haOp: 'assist'`, `haLanguage`): `POST /api/conversation/process`. The output is HA's own answer ("Turned on the lights"); when HA doesn't understand, the block fails with HA's words.
- **`think: false` for cloud reasoning models:** `reasoning_effort` `none` (Gemini), `low` (gpt-oss), `minimal` (OpenAI o-series/gpt-5). A model that refuses the setting is asked again without it.
- Tests: `server/test/colibri.test.ts`, which uses a fake `coli serve` (`server/test/fake-coli.mjs`).

## M17 — Picture reader, several colibri models at once, CPU-only Ollama, phone layout

- **Picture reader** (every AI block, so every workflow):
  - `seesPictures(model, info)` in `@hivemind/shared`: what the provider says first (`ModelInfo.vision`: Ollama's `vision` capability; colibri says no, it runs text only), else the name (Gemini, GPT-4o/4.1/5, Claude, gemma3/4, Qwen-VL, Pixtral, Llama 4, ...; never gpt-oss or coders).
  - A model that can't see gets the reader's description of each picture in place of the picture: `[Picture "name", described by <reader>: …]`, text in the picture written down exactly. Each picture is described once per run and shared by every block.
  - A model that was thought to see but refuses the picture is asked again with the description. Without a reader it is asked with the text only, as before.
  - Settings → **Pictures**: automatic (the fastest local Ollama model that sees: gemma4:e2b first), off, or a chosen model. `GET/PUT /api/settings/picture-reader` (`{ choice: 'auto' | 'off' | ModelRef }`).
  - LLM block → **Send pictures straight to this model** (`NodeConfig.pictures: 'direct'`).
- **Several colibri models loaded at once:**
  - Each loaded model has its own `coli serve` on its own port (from the base port up). `maxEngines` (Settings → Colibri, default 3).
  - They share the RAM budget: a model gets its file size plus 2 GB, or everything there is when it doesn't fit. A model that doesn't fit unloads the one used longest ago (pinned ones last); one that is answering is never stopped.
  - Only one engine uses the GPU; the others run on the CPU.
  - **Always loaded** (`pinned`): no unload timer, and it comes back after a bigger model pushed it out and was unloaded.
  - `POST /api/colibri/unload` takes `{ model }` for one model. Status has `running[]`; logs are per model (`/data/colibri/engine-<model>.log`).
- **CPU only** for Ollama providers (`cpu_only` column, `ProviderInfo.cpuOnly`): `num_gpu: 0` on chat, load and Ollama decision calls. Such a provider holds no GPU lock, so for example Jev can decide while colibri or ComfyUI holds the GPU.
- **Also run in colibri** (Settings → Download models, admins): for an installed `hf.co/owner/repo:QUANT` model whose architecture colibri reads, the same GGUF is imported into colibri (`/api/colibri/import`). Families colibri can't run say why.
- **One frame on every tab:** full width everywhere (the Use page keeps a wide reading column inside).
- **Phone (narrower than 768 px):**
  - bottom bar with Use, Workflow, Activity, Settings and More;
  - Use: the question box at the bottom like a chat app;
  - Workflow: no side panels; **＋ Block** and **Block settings** open as bottom sheets (tapping a block opens its settings); pinch to zoom, drag to move, fit button; no minimap;
  - Settings: the sections as a list, a tap opens one full screen.
- **Installable (PWA):** `manifest.webmanifest`, `sw.js` (pages always from the server; only an offline page is cached), `offline.html`.
- Colibri library: the Qwen family card has size buttons (0.6B to 235B-A22B), each with its own fit label and GGUF search.
- Block settings texts: "Keep model loaded" applies to colibri too; "Context size" is Ollama only (colibri sets it in Settings → Colibri).
- **Template "HiveMind: smart router"** (`hivemind-router`): Jev (the decision model) sorts the question into chat, code, reasoning, writing, deep, home or picture (unsure: chat); a branch per kind answers (fast model, coder, thinking model, writer, the big model, Home Assistant Assist, a model that sees). `TemplateModels` gained `fast`, `deep` and `vision`.
- **HiveBot S12 (models reloading):** `POST /api/canvases/:id/warm` loads Ollama models with the context size the run will send (the block's, else the run limit), and the picture reader uses the run limit too, so the call finds the model loaded as it is instead of loading it again.
- **Workflow folders:** `canvases.folder` (migration), `Canvas.folder`, `PUT /api/canvases/:id` takes `folder` (string up to 40 characters; `""`/`null` clears it, left out keeps it), so apps can file their workflows themselves. Without a folder, `folderOf()` sorts by app (`managedBy`: HiveBot, DungeonMind) or name: HiveBot ·… → HiveBot, Site… → Websites, Software… → Software, (Deep) research… → Research, DungeonMind… → DungeonMind, Colibri… → Colibri, the rest → Other. **Open…** shows the folders as groups (fold open and shut, remembered per browser) with a search box; the 📁 field next to the name sets the folder on Save, with the existing folders suggested.
- Home Assistant **Ask (Assist)** takes a sentence template in `body` (e.g. `{{question}}` behind a Decide block); without one it uses the text wired in, as before.
- Tests: `server/test/pictures.test.ts`; several engines and the router template in `server/test/colibri.test.ts`.

## M18 — HiveBot S10–S14, Workflows panel

- **Workflows panel (PC):** the workflow list (folders, search, the open one highlighted) is a panel on the left of the
  workflow screen, next to the blocks; ◂ folds it to a thin "Workflows" strip, ▸ opens it again (remembered per
  browser). The phone keeps the **Open…** dropdown.
- **S10, sizes of remote models:** an OpenAI-compatible or cloud server says nothing about how big its models are, so
  apps that pick "the big model" by size (HiveBot's Ultron) couldn't see it. Settings → AI providers → **Model sizes**
  writes a size (GB) and parameters ("400B") per model; `GET /api/models` returns them as `sizeBytes` / `params`
  (what an admin wrote wins). `GET/PUT /api/providers/:id/sizes` (`{ model, sizeGb, params }`; 0 and no params removes
  it). Remote models never take the local GPU lock, and `/v1` keeps the stream alive while a slow model thinks.
- **S11, built-in voice:** Kokoro (kokoro-onnx, 82M) inside the container, behind the OpenAI `/audio/speech` API
  (`server/kokoro/serve.py`, Python package in `/opt/kokoro-lib`, its own folder so the training stack is untouched).
  Model files (~350 MB) download into `/data/kokoro` the first time; the server starts on demand on 127.0.0.1:8880 and
  stops after 30 minutes of quiet. About a second per sentence on the CPU. Settings → Voice → **HiveMind voice
  (Kokoro)** (`ttsMode: 'builtin'`, voice picker); apps with an API token get it too when no speech server is set.
  Voices for apps map names to Kokoro voices (`jarvis = bm_george`). `VoiceSettings.builtinTts` / `builtinVoices`.
- **S12, the truth about loading:** Ollama's `/api/ps` reports the context size a model is loaded with; a call with
  another `numCtx` is reported as loading (Ollama loads it again). When a call that looked warm still reports a real
  load (`loadMs` > 1 s), a second `model_ready` with `warm: false` and `loadMs` follows.
- **S13, a long colibri job no longer blocks local blocks:** colibri on the CPU (`gpu: off`) holds no GPU lock, so
  an Ollama block on the same machine runs while colibri writes for minutes (test in `engine.test.ts`).
- **S14, the workflow guide:** a built-in shared skill **hivemind-workflows** (`server/skills/`): the canvas JSON,
  every block, `{{question}}`/`{{inputs}}`/`{{vars.x}}`, and the rules (Router/Decide pick by label, same `numCtx` per
  model, `think: false`, Jev for decisions, short colibri prompts, folders). Installed at start for the first admin and
  updated with new versions unless an admin changed it. API tokens get a **skills** permission (`scope.skills`, at
  creation or later with `PATCH /api/tokens/:id {skills}`, a checkbox on the token list): such a token may make,
  change and delete its user's skills, nothing more.
- Tests: `server/test/kokoro.test.ts`, `server/test/hivebotS10S14.test.ts`, S12/S13 in `server/test/engine.test.ts`.

## M19 — Coding agents (T3 Code / OpenCode) and folders of other apps

- **Single models in `/v1`:** besides the canvases, `GET /v1/models` lists the provider models a person may use as
  `<providerId>/<model>` (`colibri/qwen36-35b`, `ollama/gemma4:e2b`, cloud models), with
  `hivemind: { kind: "model", provider, contextLength, tools }`. A canvas id never has a slash, so canvases keep working.
  Settings → API tokens → **Coding agents → Single models in the API** (`prefs.apiModels`, default on for admins); a
  limited token also needs its **models** permission (`scope.models`, at creation or `PATCH /api/tokens/:id {models}`).
- **Tools:** `POST /v1/chat/completions` with such a model passes `messages` (tool calls and `role: "tool"` results
  included), `tools`, `tool_choice`, `temperature`, `top_p`, `max_tokens`/`max_completion_tokens` and `stop` to the
  provider, and answers with `tool_calls` / `finish_reason: "tool_calls"`, streamed as OpenAI deltas or whole.
  - `ChatMessage` has `toolCalls` / `toolCallId` / `toolName` and role `tool`; `ChatRequest` has `tools`,
    `toolChoice`, `stop`, `topP`; `StreamChunk` has `tool_call` pieces.
  - OpenAI-compatible providers and colibri (`coli serve` renders tools in the model's own format and parses them
    back): passed through. Ollama: native `/api/chat` tools, each call gets an id. Anthropic: `tool_use` /
    `tool_result` blocks, `input_json_delta` streamed.
  - All system (and `developer`) messages are merged into one at the start (some chat templates refuse a second one).
  - Ollama gets `num_ctx` 32768 for API calls (its default 4096 is too small for an agent's ~12k first request); a
    request that can't fit the model's context gets a 400 `context_length_exceeded` with both numbers.
  - Same rules as a run: access profiles, the run time limit (colibri's longer one for colibri), the shared GPU queue
    (`: waiting for GPU` / `: loading model` comments every 10 s while streaming), usage in the stats
    (`run_usage`, `node_type = 'api'`).
- **Copy OpenCode config** (Settings → API tokens): an `opencode.json` provider block for this HiveMind with every
  model that can call tools (`tool_call: true`, context limit).
- **Folders of other apps:** a folder another app works in (T3 Code's projects) mounted into the container (template
  path "Folder of another app" → `/projects`). Projects → **Folders of other apps**: a switch (off by default), the
  allowed roots (never HiveMind's own folders), and each folder with **Open as project**. Such a project
  (`projects.external`) is the folder itself: workflows, the editor, Build and Git work on the same files; new files
  get the owner of the folder; `node_modules`, `.venv` and caches are skipped; bigger limits (20,000 files, 2 GB).
  Deleting the project never deletes the folder; switched off, it stays listed but can't be opened (403).
  `GET/PUT /api/outside-folders`, `POST /api/projects/outside { path, name? }` (admins).
- Tests: `server/test/v1models.test.ts`, `server/test/outsideFolders.test.ts`.

## M20 — Voice training for HiveBot (recordings → a cloned voice per character)

- **Voice engine** inside the container: Qwen3-TTS-12Hz-0.6B-Base (Apache 2.0) in `/opt/voice-lib` (with the
  transformers it needs, apart from the training stack), run by `server/voice/worker.py` on 127.0.0.1:8881, started on
  demand and stopped after `keepMin` minutes. The model (~2.5 GB) downloads into `/data/models/voice` on first use.
  Device: the GPU only when it has 4 GB free (float32; the T4 can't run it in float16), else the CPU (~9 s for a
  sentence on the 9950X), so ComfyUI and Ollama are never pushed out. Settings → Voice → **Voice engine**: on/off,
  CPU only or auto, keep loaded; the cloned voices with **Use previous voice**.
- **Blocks** (group Voice):
  - **Audio prep** (`audioPrep`): the recordings linked in the question (the question box now attaches audio and video
    files as files: `[name.mp3](hm-file:uploads/…)`, short audio also as its words) and optionally a Files folder →
    ffmpeg to 24 kHz mono → split on pauses into 3–15 s clips → about −20 dB; too quiet, clipped or mostly silent
    clips are thrown away. Clips go to `files/voices/<character>/clip_NNNN.wav` (owned by the runner). The character is
    `vars.character`, else jev/jarvis/ultron/vision in the question, else its first word.
  - **Voice dataset** (`voiceDataset`): writes down what is said in each clip (Settings → Voice speech to text, with
    retries on rate limits) and adds it to the Lab dataset of kind `voice` (`hivebot-voice-<character>`; the audio
    hash is the item's ref, so a clip already in it is skipped and deleted); writes `metadata.csv` (LJSpeech style).
  - **Voice clone** (`voiceClone`): picks the best `count` (3) clips (6–12 s, about −20 dB, most words, different
    sources) and writes `/data/voices/<name>/voice.json` with copies of them; the previous version stays 7 days.
  - **Speak** (`speak`): says the block's text (one sentence per line) or what is wired in, in any voice, as WAV files
    with players in the run output.
- **API:** `/api/voice/speak` takes `clone:<name>` (directly or through Voices for apps, `jarvis = clone:jarvis`);
  when a cloned voice can't speak, the built-in voice says it and the `x-voice-note` header says why.
  `GET /api/voice/voices` (built-in and cloned), `PUT /api/settings/voice-engine`,
  `POST /api/voice/voices/:name/previous`. Feature flags `audioPrep`, `voiceDataset`, `voiceClone`, `speak` (HiveBot
  installs its Voice trainer and Voice test workflows when it sees them).
- Files: `.wav`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.mp4`, `.webm` are served with their media type, so they play in
  the browser.
- Not built (yet): music removal (Demucs), the two-speaker check, fine-tuning on ≥ 30 min, VoxCPM2 as a second engine.
- **Automatic:** `/api/voice/speak` with a name that has a cloned voice of its own (`jarvis` and `clone:jarvis`
  exists) speaks in it without any setting, even when Voices for apps still says a built-in voice (that one is then the
  fallback). So the robot and the app get the new voice as soon as the Voice trainer builds it. Feature `autoCloneVoice`.
- **Cleaner cloned voices** (the first Jarvis voice made noises, falling objects and robot sounds): one clean 5-10 s
  reference clip instead of three 12-15 s clips joined. Audio prep glues pauses into clips of about 8 s (3-12 s, a
  forced cut at the quietest moment) and measures each clip (`snr`, spectral `flat`ness: noise, music and effects are
  high); Voice clone (`count` 1 by default) picks the clip with normal speech (2-3.6 words a second, few numbers), a
  quiet background and the least noise. Clips whose words speech to text made up ("Thanks for watching", "Terima kasih
  ...", not English, words that can't fit the clip) never go in the dataset and are never a reference. Speaking is a
  bit calmer (temperature 0.7) and checked: what the voice said is written down and compared with the text; noise or
  wrong words are made again (at most 3 tries, the best is kept; under 40 % heard -> the built-in voice says it).
- Fix: Speak could hang for minutes ("fetch failed" after 5 min, and every voice job behind it failed too): the model
  had no length limit and could make up to ~170 s of audio. Now about 0.5 s a word with twice that as room
  (`max_new_tokens`); the engine is never stopped for being idle while a job waits or runs; a clear message instead of
  "fetch failed".
- Fix: a second upload of the same file is saved as `x (2).mp3`; the space and brackets broke the link, so Audio
  prep found no recordings. The question box now writes the path encoded (`x%20%282%29.mp3`) and Audio prep also reads
  the old raw links.
- Tests: `server/test/voiceTraining.test.ts` (a stand-in worker).

## M21 — Robots and installers (HiveBot S16 + S17 / R1)

- **Robots** (Settings → Robots & installers, admins; table `robots`): add a robot (name, board, home Wi-Fi); it
  gets **its own token** (`api_tokens`, `scope.robot = <id>`, canvases/memory `hivebot*`), shown once. A robot token may
  only use `/api/robot/*`, the voice API (`/api/voice/transcribe`, `/speak`, `/voices`), its workflows and memory, and
  download its own firmware. New token / remove (revokes it). The list shows online (heartbeat < 2 min), battery,
  firmware, Wi-Fi, IP and when it was last seen.
- **Robot API:** `POST /api/robot/heartbeat {battery, ssid, rssi, firmware, board?, moved?}` → `{configVersion,
  config}`; `GET /api/robot/config` → Wi-Fi networks (with passwords, encrypted at rest), the HiveMind addresses
  (`PUT /api/settings/robot-urls {home, public}`), room, home networks, characters with wake words, standby times and
  the firmware it should run (`{version, url, sha256}`); `POST /api/robot/event {type, character?}`. Any change to a
  robot raises its config version. An ordinary token gets a clear 403 on the robot API.
- **Installers:** `/data/installers/<app>/<version>/<file>` (exe, msi, zip, apk, bin, elf, uf2, json, md, txt; at
  most 200 MB each, with a .sha256 next to it). `PUT /api/installers/:app/:version/:file` (raw body) by an admin or a
  token with the **installers** permission (`scope.installers`, at creation or `PATCH /api/tokens/:id`);
  `GET /api/installers` (admins), downloads for admins (and a robot for its own firmware), delete a version, a GitHub
  repository per app with **Get newest from GitHub** (the latest release's files, private repositories with the
  owner's GitHub token).
- **Robot firmware** lives in the app `hivebot-robot` as `<board>-bootloader.bin`, `<board>-partitions.bin`,
  `<board>-ota_data_initial.bin`, `<board>-firmware.bin` (boards `cores3`, `t-dongle-s3`, `sticks3`).
  `GET /api/installers/firmware-manifest?board=` is the esp-web-tools manifest (offsets 0x0, 0x8000, 0xf000, 0x20000).
  **Install a robot**: Espressif's esp-web-tools (loaded from unpkg) flashes it over USB (Chrome/Edge, HTTPS or
  localhost), then the setup form sends `wifi add`, `url`, `token` and `pin` over the same serial port; the PIN goes
  only to the robot. Per robot, **Firmware: newest / a version** sets what it is told to run (OTA is the robot's part).
- Tests: `server/test/robots.test.ts`.

## M22 — Seeing what the API does, and HiveBot from the web page (H1–H6)

- **Activity:** `/v1` calls straight to a model (coding agents like T3 Code) show live under **Running now**: the
  model, the token, what it is doing (waiting for the GPU, loading, reading the prompt, thinking, writing, calling a
  tool), tokens written, tokens/s, the last 300 characters and the tools it called. Every line in **Incoming API
  calls** has a Details column: the model or workflow, tokens in/out, tokens/s, time to the first word, tools called,
  and for a failed call the error it got (a 403's reason). `ActivityRunning.apiCalls`, `ApiCall.model|error|…`.
- **H1:** "Get newest from GitHub" puts a release's robot firmware (`<board>-*.bin`, `firmware-version.txt`) into the
  `hivebot-robot` app and the rest (HiveBot.exe) into the app itself. `cores3-srmodels.bin` (the CoreS3 speech
  model) is flashed at 0x620000 when the release has it.
- **H2:** the setup form asks the PIN twice (4–8 digits, required). Robots → **Change PIN**: `POST /api/robots/:id/pin
  {pin}` puts `pinChange {salt, hash = SHA-256(salt ‖ digits), id}` in the robot's config; when its heartbeat reports
  `pinId`, HiveMind forgets it. The digits are never stored.
- **H3, background jobs:** `/v1/chat/completions` with `hivemind_vars.background: true` (`character`, `job`) answers
  **202** `{jobId, runId, status}` at once; the run goes on (up to 60 minutes, resumable after a restart).
  `GET /api/robot/jobs` (newest 50), `GET /api/robot/jobs/:id` (status queued/running/done/failed/cancelled, the block
  now with its live tokens/s, blocks done/total, the last output, files, answer, `failedNode`, per block model,
  tokens/s, tokens and seconds), `POST …/seen`, `…/cancel`, `…/resume {fromNode}` (a new run that keeps what the
  blocks before it made; the saved workflow is used, so a fixed step runs). A failed step makes the job failed.
  The heartbeat answer has `jobsDone` (finished, not yet told). Limited tokens reach their own user's jobs.
- **H4:** per-robot settings (`micSensitivity` 1–10, `volume` 0–100, `conversationMode`, `showText`, `backlight`
  {dimAfterS, dimPercent, lowAfterS, lowPercent}) on the Robots page, in the robot config as `settings`; what the robot
  reports in its heartbeat (`settings`) shows next to each.
- **H5:** non-streamed `/v1` answers carry `hivemind.stats` (per AI block: node, model, provider, tokensPerSecond,
  promptTokens, completionTokens, firstTokenMs, loadMs) and `usage.tokensPerSecond` of the answering block; streamed
  answers end with `usage` (+ tokensPerSecond), and with `hivemind_vars.progress: true` also send
  `{type: "progress", node}` when a block starts, `{type: "stats", …}` when an AI block ends and `{type: "stats",
  live: true, tokensPerSecond}` about once a second. `node_done` events have `firstTokenMs`.
- **H6:** `keepAlive` is passed per block as before (HiveBot's "5m" works); the search block needs nothing special
  for robot-token runs.
- Tests: `server/test/robotJobs.test.ts`, the Activity details in `server/test/v1models.test.ts`.
- **Ghost** (HiveBot's fifth character): the robot config lists `{ id: 'ghost', wakeWord: 'ghost' }`, and the Voice
  trainer knows "Ghost" in the upload message (voice `ghost`).
- **Fold the side panels**: on a PC the blocks panel (◂ in its header) and the Inspector/Builder panel (▸ at its
  left) fold to a thin edge with the panel's name; click the edge to open it again. The choice is remembered.

## M23 — Settings → T3 Code: pick the models T3 offers, update T3 with one button

- **Folder:** an optional template path **T3 Code OpenCode folder** → `/t3/opencode` (`T3_OPENCODE_DIR`): T3 Code's
  OpenCode config folder (in T3's appdata: `.config/opencode`). No Docker socket and no SSH: HiveMind only writes files
  in that folder. Without it, the page explains the template step and **Download opencode.json** gives the same file.
- **List:** every `/v1` model of this person (single models and workflows, from the same code as `GET /v1/models`,
  now `v1ModelData()`), with a checkbox, provider, local/cloud, "edits files" or "chat only", size, context and
  "in T3" for the ones in the file now. A search box (name, id, provider, description) and filters: chosen, local,
  cloud, workflows, edits files, in T3 now. Chosen models first.
- **Per chosen model:** an own name, a short description, a role (fast, planner, coder, slow + best, check) and
  "thinks" (OpenCode then offers a reasoning setting). In T3 the model is called
  `<name> · <where> · <role> (<description>)`, where is GPU, GPU+CPU (Ollama models over 15 GB), Colibri CPU, cloud
  or workflow. Without a description it gets a short one from its kind and size ("very fast: simple code, quick
  checks", "best local, slow: hard code", "chat only, no file edits"). Saved per user (`user:<id>:t3`).
- **Update T3** (`POST /api/t3/update`) replaces only `provider.hivemind` in `opencode.json`; every other provider and
  key stays. A file that isn't a JSON object is left alone (409). The block has `@ai-sdk/openai-compatible`, the
  address T3 uses (saved, else the one in the file, else this page's), the key as
  `{file:~/.config/opencode/hivemind-token}`, and per model `tool_call`, `reasoning`, `limit.context` (Ollama: the
  32768 HiveMind gives API calls; others their own) and `limit.output`. Chosen models that are no longer offered
  are left out and reported. One backup (`opencode.json.hivemind-backup`); files are written via a temp file and
  given the owner set on the page (default `99:100`, the user T3 runs as on Unraid).
- **Token:** when T3 has no `hivemind-token`, Update T3 makes a full API token "T3 Code" for this user and writes it
  (mode 600). **New token** (`POST /api/t3/token`) revokes the one made before and writes a new one. The token is
  never shown or put in the downloaded file.
- `/v1/models` single models also carry `hivemind.providerKind`, `modelName`, `local` and `sizeBytes`.
- API: `GET/PUT /api/t3`, `POST /api/t3/update`, `POST /api/t3/token`, `GET /api/t3/opencode.json`.
- Tests: `server/test/t3sync.test.ts`.

---

## M24 — Quick answers when the GPU is busy (HiveBot H8), and talking to the house from Home Assistant

- **Quick fallback per AI block** (`config.fallback {model, afterSeconds}`, Block settings → "Quick answer when the
  GPU is busy"): when the block's local model has not got the GPU after `afterSeconds` (other work ahead in the
  queue), the block leaves the queue and answers with the fallback model (the CPU-only Ollama or a cloud model). The
  big model is not unloaded. `node_done` gets `fallback: true, fallbackFor`; the /v1 `stats` chunk and
  `hivemind.stats` carry them, so a robot can say it gave a quick answer.
- **Cloned voices back on the GPU**: a cloned voice that fell back to the CPU (under 4 GB free) checks every 2 minutes
  while loaded and moves back to the GPU by itself once there is room (not while it is speaking).
- **Home Assistant block, "My devices"** (`haOp: 'devices'`): lists the house's devices that can be switched, opened,
  locked or set (light, switch, lock, cover, climate, fan, media_player, scene, script, vacuum …) with their names
  and states, live from `/api/states`; `entities` narrows it to some kinds.
- **"Voice smart home" template** reads the devices from Home Assistant instead of a hand-typed list, knows
  locks/covers ("open the garage door"), and answers other questions with the conversation history.
- **Standard workflow "Home Assistant voice"** (folder Home Assistant): added by itself once Home Assistant is
  connected (Settings → Home Assistant → Test), with a button to add it again. Use it as the conversation agent of
  Home Assistant's Assist through the HiveMind integration (HACS); HA keeps its own speech to text and text to speech.
- Tests: fallback in `server/test/engine.test.ts`, devices in `server/test/actions.test.ts`.

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

