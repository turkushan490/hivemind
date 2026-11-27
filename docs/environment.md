# Environment variables

Set these with `-e NAME=value` in `docker run`, under `environment:` in compose, or in the Unraid template. Most settings are changed later in **Settings** inside the app; the variables below are for the start.

## The common ones

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4820` | The web and API port inside the container. |
| `OLLAMA_URL` | `http://localhost:11434` | Added as the first Ollama provider on a fresh install. In Docker, use the real address of the machine. |
| `COMFYUI_URL` | empty | Optional ComfyUI, added once as an image provider. Keep ComfyUI's own port inside your network: anyone who reaches it can see its pictures. |
| `TYPESAFE_API_KEY` | empty | Optional TypeSafe key, added once (encrypted) as the Jev decision provider. |
| `SECRET_KEY` | generated | Encrypts stored API keys. Empty: one is made once and kept in `/data/secret.key`. If you set it, never lose or change it. |
| `SECURE_COOKIES` | `false` | `true` when HiveMind is served over HTTPS (behind a reverse proxy). HTTPS is also needed for the microphone on other devices. |
| `TZ` | `Etc/UTC` | Your time zone, for workflow schedules and the training window. Unraid sets it for you. |
| `LOG_LEVEL` | `info` | Container log detail: `debug`, `info`, `warn`, `error`. |

## Safety and limits

| Variable | Default | What it does |
|---|---|---|
| `BLOCK_PRIVATE_ADDRESSES` | `false` | `true` stops Webhook blocks and image links from reaching private (LAN) addresses. Set it when other people use your server. Loopback and cloud-metadata addresses are always blocked, and workflows of non-admins never reach the LAN. |
| `RUN_TIMEOUT_MINUTES` | `30` | A run that takes longer is stopped, so a server that never answers can't hold the GPU. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which reverse proxies may set `X-Forwarded-For` (used for the login limit). |

## Folders

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `/data` (Docker), `%LOCALAPPDATA%\HiveMind` (Windows) | Where everything is stored: database, files, keys, models. Back this up. |
| `COMFYUI_DIR` | `/comfyui` if mounted | ComfyUI's own folder (with `input`, `output`, `models`), so HiveMind can train image LoRAs into it. |
| `COLIBRI_MODELS` | `$DATA_DIR/colibri/models` | Where Colibri models are stored. |
| `HF_HOME` | `/data/trainer-cache/huggingface` | Hugging Face cache for the Training Lab. |

## Logging and the Windows app

| Variable | Default | What it does |
|---|---|---|
| `LOG_FILE` | on for the .exe, off in Docker | A plain-text log of problems and crashes. A path, `true` (the default place: `$DATA_DIR/hivemind.log`) or `false`. **Settings → Log file** overrides it. |
| `HIVEMIND_OPEN_BROWSER` | `app` for the .exe | `app` opens an app window, `browser` the default browser, `off` nothing. |

## Advanced

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `0.0.0.0` | The address the server listens on. |
| `STT_TIMEOUT_S` | `20` | Longest time for one speech-to-text recording, in seconds. |
| `TRAIN_GPU_FREE_MB` | `1536` | Free GPU memory (MB) a training job needs before it starts. |
| `COLIBRI_PORT` | `8790` | Internal port of the Colibri engine. |
| `BROWSER_PATH` | built in | Chromium for the Browser block, if you use your own. |

## Example

```yaml
services:
  hivemind:
    image: ghcr.io/turkushan490/hivemind:latest
    ports:
      - "4820:4820"
    volumes:
      - ./data:/data
    environment:
      - OLLAMA_URL=http://your-server:11434
      - COMFYUI_URL=http://your-server:8188
      - SECURE_COOKIES=true
      - BLOCK_PRIVATE_ADDRESSES=true
      - TZ=Europe/London
```
