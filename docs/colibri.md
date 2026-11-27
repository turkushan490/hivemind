# Colibri

[Colibri](https://github.com/JustVugg/colibri) is a local engine for very large **mixture-of-experts** models (Qwen3, DeepSeek, GLM, Kimi and more). It keeps the experts a model uses most on the GPU or in RAM and streams the rest from disk, so a model much bigger than your VRAM still runs — slower, but locally.

Colibri is built into the **Docker image** (not the Windows .exe). It needs no setup: if the engine is in the image, a `colibri` provider appears by itself.

## Get a model

**Settings → Colibri**:

- the engine (CUDA or CPU), your RAM limit and free disk;
- the **library**: every model family Colibri runs, with size filters and a fit label (*fits*, *tight*, *needs RAM*, *needs disk*);
- **Download** ready-made versions, or **Find GGUF files** on Hugging Face and import one;
- your models: **Load now**, **Delete**;
- the engine log.

Models are stored in `/data/colibri/models`. They are big: check your free disk first.

## Settings that matter

- **GPU or CPU only:** CPU only leaves the GPU free for Ollama and ComfyUI. With a GPU, Colibri waits its turn in the shared [GPU queue](ollama.md#the-gpu-queue).
- **RAM budget:** by default the container's memory limit minus 4 GB. Several models can stay loaded at once; **pin** the ones you want kept.
- **Keep loaded:** a model unloads after some idle minutes (30 by default).
- Docker without `--gpus=all` runs Colibri on the CPU.

## Use it

Pick a `colibri/…` model in any AI model block. Very large ones are marked `(colibri, slow)`. Colibri also gives a decision model (`colibri-decisions`) for **Decide** blocks.

## Example

The **Colibri: start here** template (**New ▾ → Everyday**):

```
Question ─▶ Decide (colibri-decisions: "code or chat?") ─┬─▶ code  (a colibri coder model) ─┐
                                                          └─▶ chat  (a colibri chat model)  ─┴─▶ Final answer
```

Only the branch the decision picks runs. For long jobs, try **Deep research: overnight**, where a big slow Colibri model writes the final answer.
