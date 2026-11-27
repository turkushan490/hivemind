# API

HiveMind has two APIs. Both use an **API token**: make one in **Settings → API tokens** (it starts with `hm_`) and send it as `Authorization: Bearer hm_...`.

## OpenAI-compatible (`/v1`)

Every saved canvas is a **model**. Point any OpenAI client at `http://your-server:4820/v1`.

```bash
# list the models (your canvases)
curl -H "Authorization: Bearer hm_..." http://your-server:4820/v1/models

# ask a canvas
curl http://your-server:4820/v1/chat/completions \
  -H "Authorization: Bearer hm_..." -H "Content-Type: application/json" \
  -d '{"model": "Council", "messages": [{"role": "user", "content": "Why is the sky blue?"}]}'
```

Python:

```python
from openai import OpenAI

client = OpenAI(base_url="http://your-server:4820/v1", api_key="hm_...")
reply = client.chat.completions.create(
    model="Council",
    messages=[{"role": "user", "content": "Why is the sky blue?"}],
)
print(reply.choices[0].message.content)
```

- `model` is the canvas **name or id**. **Settings → OpenAI API** shows your base URL, ids and copyable examples.
- `"stream": true` sends the answer in chunks.
- Send the whole conversation in `messages`; the canvas gets it as `{{history}}`.
- `hivemind_vars` fills `{{vars.name}}`, and `"hivemind_vars": {"priority": 10}` sets the GPU priority (1–200, 1 first).
- **Coding agents** (OpenCode, T3 Code, Continue): every provider model you may use is also a model here, such as `ollama/qwen3:8b`, with tools and streaming. **Settings → T3 Code** writes the config for you.

Works with Open WebUI, Home Assistant, the `openai` package and anything else that speaks OpenAI. Details: [openai-api.md](openai-api.md).

## Native API

```bash
# start a run of a saved canvas (variables and priority are optional)
curl -H "Authorization: Bearer hm_..." -H "content-type: application/json" \
  -d '{"question":"Why is the sky blue?","canvasId":"<canvas id>","vars":{"tone":"short"},"priority":100}' \
  http://your-server:4820/api/runs
# → {"runId":"..."}

# follow it live (server-sent events)
curl -N -H "Authorization: Bearer hm_..." http://your-server:4820/api/runs/<runId>/events

# the result, with the output of every labelled block
curl -H "Authorization: Bearer hm_..." http://your-server:4820/api/runs/<runId>
```

`GET /api/health` (no token) gives the version and the feature flags.

## Limited tokens

A token can be limited to some canvases, memory keys (`notes-*`, `rules:*`) and datasets, and get its own access profile (which providers and models it may use). It then can't reach anything else. All endpoints: [HIVEMIND_CHANGES.md](HIVEMIND_CHANGES.md).
