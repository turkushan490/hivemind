# HiveMind changes for DungeonMind

**Status:** spec, not built yet. Start here for HiveMind milestone **M0** (API changes) and the **Lab track** (L1–L4).

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
- Commits carry no Claude co-author line.

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

DungeonMind shows what's missing and refuses to start a game until the required ones are there. Add each flag in the same commit as its feature. This lives in `server/src/app.ts:54`.

## 10. Nice to have

- **Canvas-scoped tokens:** a token limited to a list of canvas ids and memory key prefixes (`dnd:*`, `rules:*`).
- **"Tabletop" template set** in `web/src/canvas/templates.ts` with the DungeonMind canvases (below), so people can see and tweak them.

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

Each step is one commit with its tests, CI green, then deploy to Unraid (template `my-hivemind.xml` + rebuild_container).

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

## L3 — Local fine-tune (Unraid T4)

- **Unsloth Docker container** (`unsloth/unsloth`) as a separate Unraid template. HiveMind starts the job over its API, or through `docker exec` from a small helper script on Unraid.
- **QLoRA SFT** on the L1 dataset: T4 = fp16, 4-bit load. 7–9B fits comfortably, and 12–14B is tight.
- **GPU:** HiveMind takes the GPU host lock for the whole job and unloads Ollama and ComfyUI first, using the existing `freeGpu`. The UI shows "Training — local AI paused".
- **Output:** a LoRA → merge → **GGUF** (q4_k_m and q8_0) → `ollama create dungeonmind-dm:<version>` from a Modelfile. The new model shows up in HiveMind and on the scoreboard straight away.

## L4 — Hugging Face training + publishing

- **Settings → Hugging Face:** the token is stored encrypted like other provider keys, and there's a **daily GPU-minutes limit**. The default is 40 min/day, matching his plan, and a usage bar shows today's minutes.
- Before **every** job, HiveMind shows the estimated minutes and cost, and the user must confirm.
- ⚠️ **Check first:** HF Pro's daily minutes are **ZeroGPU quota for Spaces**, while **HF Jobs** (`hf jobs uv run` with a TRL/Unsloth script) are billed per use. Find out which one fits:
  - (a) HF Jobs within the budget;
  - (b) a private ZeroGPU Space that trains in short chunks with checkpoints pushed to the Hub;
  - (c) fall back to L3 on the T4.
- **Publish:** the merged GGUF goes **public** to his HF account (e.g. `turkushan490/dungeonmind-dm-8b-gguf`). It gets a model card (base model, dataset description, scores from L2, license) and is pulled with `ollama pull hf.co/turkushan490/…`. DungeonMind's setup offers this as a one-click model download.
- **Base model licenses:** only use base models whose license allows publishing fine-tunes (Apache-2.0/MIT, e.g. Qwen, Mistral). Record the license in the model card.

## Lab order

L1 can start **right after M0 §1, §3, §5 and §6**, because it needs vars, JSON mode, node outputs and rules search. Running the sim early means data keeps building up while DungeonMind is being built. After that comes L2, then L3 once there are a few thousand reviewed turns, then L4.

## Verification

- **Unit tests:** the mini bookkeeper's counter math, the judge verdict parser, JSONL export format, and that the GPU lock lets a real run in between two sim turns.
- **A 10-turn sim** with a fake provider must produce 10 `lab_turns` and a valid JSONL.
- **On Unraid:** run the sim for 1 hour on a real model, check that the scoreboard numbers look sane, and check that a HiveMind run started by hand during the sim still goes first.
