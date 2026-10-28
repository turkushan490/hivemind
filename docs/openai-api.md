# OpenAI-compatible API

Every saved canvas is a **model**. Any app that speaks the OpenAI chat API (Home Assistant, Open WebUI, LibreChat, n8n, the `openai` Python or JS package) can use your canvases.

- **Base URL:** `http://<server>:4820/v1`
- **API key:** an API token from **Settings → API tokens** (`hm_…`), sent as `Authorization: Bearer hm_…`. Each token sees the canvases of the user who made it.
- **Settings → OpenAI API** shows the base URL, your canvas ids and copyable examples.

## `GET /v1/models`

Lists your canvases:

```json
{
  "object": "list",
  "data": [
    { "id": "AOsZT_05rIdJ", "object": "model", "created": 1767261600, "owned_by": "hivemind", "name": "Kitchen helper", "slug": "kitchen-helper" }
  ]
}
```

## `POST /v1/chat/completions`

```json
{ "model": "kitchen-helper", "messages": [{ "role": "user", "content": "What can I cook with eggs?" }], "stream": false }
```

- **`model`:** the canvas id. The slug of the canvas name (`kitchen-helper`) and the exact name (`Kitchen helper`) work too, and so does a `hivemind/` prefix.
- **`messages`:** the **last user message with text** becomes the canvas question. System messages and earlier turns are ignored, because the canvas decides how to answer. Text parts of multi-part content are joined.
- **The answer** is the canvas's **Final answer**. When a canvas has no Final answer block, the last block that produced text gives the answer.
- **`usage`** is the token total of every block in the run.
- **`hivemind_vars`** (HiveMind extra, optional): an object of strings, filled in wherever a block says `{{vars.name}}`. Same limits as `vars` on `POST /api/runs` (below): at most 64 keys named `[a-zA-Z0-9_]{1,40}`, 1 MB in total, otherwise 400.
- **Other parameters** (`temperature`, `max_tokens`, …) are accepted and ignored. Each block uses its own settings.

Every API call is a normal run: it shows up in History, can be replayed on the canvas, and its errors are listed in **Problems**. If the client disconnects before the answer is ready, the run is cancelled.

### Streaming (`"stream": true`)

The response is server-sent events in OpenAI's chunk format, ending with `data: [DONE]`:

- **One block feeds the Final answer:** that block's tokens stream live as they are written.
- **Several blocks feed it** (a join, or Router branches): the full answer arrives as one chunk at the end, because it is only known then.
- **Long waits:** while the canvas works (for example while models load), comment lines (`: working`) keep the connection open.

### Errors

Errors use OpenAI's shape, `{"error": {"message", "type", "code"}}`:

| Status | When |
|---|---|
| 400 | No `model`, no user message, or the canvas can't run (for example a block without a model) |
| 401 | Missing or unknown token (`invalid_api_key`) |
| 404 | No such canvas (`model_not_found`) |
| 500 | The run gave no answer (`run_failed`); the message lists the block errors and the run id |

A failed streamed run sends one error object as a data line before `[DONE]`.

## Examples

```bash
curl http://server:4820/v1/chat/completions \
  -H "Authorization: Bearer hm_..." -H "Content-Type: application/json" \
  -d '{"model": "kitchen-helper", "stream": true, "messages": [{"role": "user", "content": "Hi!"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://server:4820/v1", api_key="hm_...")
print(client.chat.completions.create(model="kitchen-helper", messages=[{"role": "user", "content": "Hi!"}]).choices[0].message.content)
```

**Open WebUI:** under Settings → Connections, add an OpenAI connection with the base URL and token above. Your canvases then appear as models.

## HiveMind's own run API (for apps)

Apps that need more than one answer text (like [DungeonMind](https://github.com/turkushan490/dungeonmind)) use the native API with the same `hm_…` token. `GET /api/health` lists the `features` a client can rely on.

| Feature flag | What it adds |
|---|---|
| `vars` | `POST /api/runs {canvasId, question, vars:{name:"…"}}` fills `{{vars.name}}` in prompts, system prompts, the image prompt, the Save file name and Webhook/Home Assistant/Discord templates (JSON-escaped in JSON bodies). Unknown vars are empty. |
| `memoryKeyTemplate` | A Memory block's key is filled too, so one canvas keeps one memory per campaign: `dnd:{{vars.tableId}}`. Trimmed, at most 120 chars, `default` when empty. |
| `nodeOutputs` | `GET /api/runs/:id` adds `outputs: {<label>: {nodeId, type, text}}`, one per finished block (label, else the block id; a duplicate label gets `#2`). Skipped and failed blocks are left out. The SSE `node_done` event carries `label`. |

```bash
H=http://server:4820; T="Authorization: Bearer hm_..."
R=$(curl -s -X POST $H/api/runs -H "$T" -H 'content-type: application/json' \
  -d '{"canvasId":"t-vars","question":"x","vars":{"name":"Turks"}}' | jq -r .runId)
curl -sN $H/api/runs/$R/events -H "$T"     # live events until "event: end"
curl -s $H/api/runs/$R -H "$T"             # the stored run (409 while it still runs)
```
