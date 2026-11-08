---
name: hivemind-workflows
description: How to build HiveMind workflows (canvases) as JSON - the format, what every block does, and the rules that make them fast and correct. Use when a model or an app has to design, change or install a HiveMind workflow.
---

# Building HiveMind workflows

A workflow (canvas) is a graph of blocks. A question goes in at the Question block, flows along the wires, and the
Final answer block gives the result. Blocks with no wire between them run at the same time.

## The JSON

```json
{
  "name": "Weather in one line",
  "folder": "HiveBot",
  "nodes": [
    { "id": "in", "type": "input", "position": { "x": 0, "y": 0 }, "config": {} },
    { "id": "search", "type": "search", "position": { "x": 260, "y": 0 }, "config": { "source": "wikipedia", "count": 3 } },
    { "id": "answer", "type": "llm", "label": "answer", "position": { "x": 520, "y": 0 },
      "config": { "model": { "providerId": "ollama", "model": "gemma4:e2b" }, "prompt": "Answer in one sentence: {{question}}\n\n{{inputs}}",
                  "think": false, "numCtx": 4096, "keepAlive": "30m" } },
    { "id": "out", "type": "output", "position": { "x": 780, "y": 0 }, "config": {} }
  ],
  "edges": [
    { "id": "e1", "source": "in", "target": "search" },
    { "id": "e2", "source": "search", "target": "answer" },
    { "id": "e3", "source": "answer", "target": "out" }
  ]
}
```

- Install or update it with `PUT /api/canvases/<id>` (an app keeps its own ids, e.g. `hivebot-task-...`), run it with
  `POST /api/runs {"canvasId": "<id>", "question": "...", "vars": {...}}` or `POST /v1/chat/completions` with
  `"model": "<id>"`.
- Every workflow needs exactly one `input` and at least one `output`, and no loops (For each/Collect aside).
- `position` only matters for people looking at it: put blocks left to right, about 260 px apart.
- Models are `{ "providerId", "model" }`. `GET /api/models` lists what the token may use; pick from that list, never
  guess a name.

## Text in prompts

- `{{question}}` = the question of the run, `{{inputs}}` = what the blocks wired in wrote (with their labels),
  `{{vars.name}}` = a value the caller sent in `vars` (also in memory keys: `"hivebot:{{vars.user}}"`).
- An AI model block with no `prompt` gets the question, or the inputs when something is wired in.
- `system` sets the character or the rules of a block.

## The blocks

| type | what it does | main config |
|---|---|---|
| input | where the question comes in | - |
| llm | one model answers | model, system, prompt, think, numCtx, maxTokens, keepAlive, json, useMessages, pictures |
| template | fixed text with {{question}} / {{inputs}} | prompt |
| router | a model (or Jev) picks ONE of the blocks wired after it; the others are skipped | model or decideWith: "jev" + decider |
| decide | a decision model answers yes/no, choice or score questions in ~0.2 s; runs the block whose label is the answer | model (decision model), questions, threshold |
| review / judge / vote / debate / panel | several answers: critique, merge, vote, discuss, random reviewers | models, jevScore |
| search | web search | source, count, readPages, searchList |
| deepSearch | searches in rounds until it knows enough | model, count |
| memory | recall / save / search text under a key | key, mode, limit, query |
| file | a fixed text or file | text, fileName |
| save | writes a file into outputs/ | fileName, format |
| image | a picture (ComfyUI or an image API) | model, width, height, steps, lora |
| homeassistant | read states, call a service, or "assist" (a spoken sentence) | haOp, entities, service, body |
| webhook | any HTTP call; the response flows on | url, method, headers, body |
| discord | posts to a Discord webhook | url |
| readProject / writeFiles / updateNotes / build / git | work on a project folder (websites, apps) | project |
| pause | waits for a person: continue, reject or stop | - |
| foreach ... collect | runs the blocks between them once per item of a list | - |
| generate / dataset / train / evaluate / deploy | training data and models | dataset, trainBase, ... |
| output | the final answer | - |

## Rules learned the hard way

1. **Router and Decide pick by label.** Name the blocks after them exactly like the choices ("code", "chat", "home",
   "yes", "no", "fallback"). An unsure Decide goes to the block labelled "fallback" (or "no").
2. **Same `numCtx` on every local block that uses the same model** (e.g. 4096 everywhere for gemma4:e2b). A different
   context size makes Ollama load the model again (~20 s).
3. **`think: false`** on blocks that must answer fast; thinking models otherwise reason first.
4. **`keepAlive: "30m"`** on local models that answer often, so the next question starts warm.
5. **Decisions: Jev** (an Ollama decision model such as clef-flash) decides in ~0.2 s; colibri decisions take 5-8 s.
6. **Colibri** (very large mixture-of-experts models) runs on the CPU: fine for code and long work, slow to read
   long prompts the first time (a 900-token system prompt costs 12-55 s). Keep its prompts short and the same per
   character, so its prompt cache is reused.
7. **Fixed choices go in `vars`** (sent with the run) instead of in the question; prompts use `{{vars.x}}`.
8. **Pictures**: put `![name](hm-file:uploads/x.jpg)` in the question. Models that can't see get a description from
   HiveMind's picture reader; `pictures: "direct"` on a block sends the picture itself.
9. **Keep it small**: a workflow of 3-6 blocks is fast and easy to follow. Branch with Decide/Router instead of
   running every model on every question.
10. **Set `folder`** (e.g. "HiveBot") so the workflow lands in the right group in the Workflows list.
