# Ollama & machines

[Ollama](https://ollama.com) runs models on your own GPU or CPU. HiveMind talks to it over HTTP, so Ollama can run on the same machine or on another one.

## Connect Ollama

- **On install:** set `OLLAMA_URL`, for example `http://your-server:11434`. It is added as the first AI provider on the first start.
- **Later:** **Settings → AI providers → Ollama**, paste the address. The card tests it.

In Docker, `localhost` means the HiveMind container itself. Use the machine's real address, or `http://host.docker.internal:11434` (the [`docker-compose.yml`](../docker-compose.yml) sets this up). The Windows .exe finds a local Ollama at `http://localhost:11434`.

## Get models

**Settings → Download models**:

- live search of the whole Ollama library;
- recommendations for your GPU size (*fits*, *slow*, *too big*);
- Hugging Face GGUF search with every quant and its size;
- live download progress, and delete.

Good small models to start with: `gemma3:4b`, `qwen3:4b`, `llama3.2:3b`.

## Several machines

Add one Ollama provider per machine (**Settings → AI providers → Add**), each with its own address and name, for example *Ollama (desktop)* and *Ollama (server)*. Every model block can then pick a model from either machine.

Per provider you can switch on:

- **Run models at the same time:** by default local models on one Ollama run one after another, so they don't fight over VRAM. Switch this on if your GPU has room for several.
- **CPU only:** the model never uses the GPU, so it can answer while the GPU is busy with something else (for example a fast decision model next to a big image job).

## The GPU queue

Ollama, ComfyUI and Colibri on the same machine take turns on the GPU. Every run and API call has a **priority from 1 to 200** (1 first, 100 is normal, 200 last). When the GPU is busy, the waiting job with the lowest number goes next. A job that is already writing is never cut off.

- The **Workflow** page has a **Prio** box.
- The API takes `"hivemind_vars": {"priority": 10}` or `"priority": 10` on `/api/runs`.
- **Activity** shows what runs and what waits.

## See what is loaded

The header shows which Ollama models are in RAM/VRAM. Click to **unload** one or all of them and free the GPU.

## Example

Two machines, one council:

```
Question ─┬─▶ AI model: Ollama (desktop) · qwen3:8b  ─┐
          └─▶ AI model: Ollama (server)  · gemma3:4b ─┴─▶ Judge: a cloud model ─▶ Final answer
```

Both local models run at the same time because they are on different machines.
