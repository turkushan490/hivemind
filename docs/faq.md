# FAQ & troubleshooting

Every error in HiveMind is shown live and kept in the **Problems** tab, also after a restart. Look there first.

## Install

**I can't open the page.**
Check that the container runs (`docker ps`) and that port 4820 is published (`-p 4820:4820`). Open `http://your-server:4820`, not `https`, unless you set up a reverse proxy. `http://your-server:4820/api/health` should answer `{"ok":true,…}`.

**Who is the admin?**
The first person who opens HiveMind creates the admin account. Add other people in **Settings → Users**.

**The image is huge.**
Yes, about 16 GB: it carries the training stack (PyTorch, CUDA), Colibri, voice engines and the sandbox tools. The first pull takes a while; updates reuse most layers.

**Docker says it can't find a GPU (`could not select device driver`).**
Install the NVIDIA Container Toolkit, or remove `--gpus=all`. Without a GPU everything except training and Colibri's GPU mode still works.

## Ollama

**"Ollama is not reachable".**
In Docker, `localhost` is the HiveMind container itself. Use the machine's real address (`http://your-server:11434`) or `http://host.docker.internal:11434` with the `extra_hosts` line from [`docker-compose.yml`](../docker-compose.yml). Make Ollama listen on the network: set `OLLAMA_HOST=0.0.0.0` for Ollama.

**I see no models.**
Download one in **Settings → Download models**, or with `ollama pull gemma3:4b` on the Ollama machine.

**Local models are slow or wait a long time.**
Local models on one Ollama take turns on the GPU. Look at **Activity** to see what is waiting, and use smaller models or a lower **Prio** number for the job that should go first. See [ollama.md](ollama.md).

**The GPU is full.**
Click the loaded models in the header and **Unload all**.

## Voice

**The 🎤 button does nothing.**
Browsers only allow the microphone over HTTPS or on `localhost`. Put HiveMind behind a reverse proxy with HTTPS and set `SECURE_COOKIES=true`.

## Runs

**A run stops after 30 minutes.**
That is `RUN_TIMEOUT_MINUTES`. Raise it for long jobs.

**A Webhook block can't reach my LAN.**
`BLOCK_PRIVATE_ADDRESSES=true` blocks it, and workflows of non-admins never reach the LAN. Loopback addresses are always blocked.

## Windows .exe

**Where is my data?**
In `%LOCALAPPDATA%\HiveMind`, with a log file `hivemind.log`.

**Windows SmartScreen warns about the file.**
The .exe is not signed. Click *More info → Run anyway* if you downloaded it from this repository's Releases page.

**Some features are missing.**
Colibri, the Training Lab and the built-in Kokoro voice are only in the Docker image. The Shell and Browser blocks need bash or PowerShell and a Chromium browser on the PC.

## Data

**What should I back up?**
The data folder: `/data` (Docker), `/mnt/user/appdata/hivemind` (Unraid default) or `%LOCALAPPDATA%\HiveMind` (Windows). If you set `SECRET_KEY`, keep it too: stored API keys can't be read without it.

**I lost `SECRET_KEY` / `secret.key`.**
The stored provider keys can't be decrypted. Paste them again in **Settings → AI providers**.

## Still stuck?

Open an [issue](https://github.com/turkushan490/hivemind/issues) with what you did, what you expected and the error from **Problems**.
