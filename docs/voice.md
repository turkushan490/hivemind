# Voice

- **🎤 Speak.** In **Use mode**, next to Ask, and on the canvas **Question** block: click it, speak, then click again. HiveMind transcribes what you said, puts it in as the question and runs the canvas. A recording stops by itself after 60 seconds.
- **🔊 Read aloud.** On answers in Use mode and on the canvas's final answer. In Use mode, a question asked by voice is answered aloud automatically; you can switch this off under the answer.

Everything is set up in **Settings → Voice** (admins change it; everyone uses it). Errors show as a message and are logged in **Problems** with the source *voice*.

## Speech to text

There are three engines. Pick one in **Settings → Voice → Speech to text**.

### Built-in, fast (faster-whisper) — Docker image

[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) runs inside HiveMind's voice engine, the same worker that speaks cloned voices.

- **The model stays loaded** between recordings (until the voice engine has been idle for its "keep loaded" time), so the microphone, the Voice trainer and the check on cloned voices don't load it again for every clip.
- **GPU when it has room:** it follows the Voice engine's device setting. On *auto* it uses the GPU when that has enough free memory for the model (about 2.5 GB for Large v3 Turbo), so ComfyUI and Ollama are never pushed out. Otherwise it runs on the processor (int8), and it moves back to the GPU once there is room again.
- **Models:** download one in the list and pick it.
  - **Large v3 Turbo** (recommended with a GPU): about large-v3 accuracy, many languages including Dutch.
  - **Small:** quick on the processor.
  - **Medium**, **Large v3**, **Distil Large v3** (English only), **Base** and **Tiny** are also offered.
  - Models are stored in `/data/whisper/fast`.
- **Fallback:** if the fast engine fails (for example the GPU libraries don't load), the local whisper.cpp engine below takes over when it has a downloaded model, and the reason is logged in **Problems**. When the GPU failed but the processor worked, that is logged in Problems too.
- **Not switched off with cloned voices:** it works even when the Voice engine is switched off for cloned voices.

### Built-in (whisper.cpp)

A small CPU program that ships in the Docker image and in the Windows app. It loads the model for every recording, so it is slower than the fast engine on bigger models. Models are stored in `/data/whisper/models`.

### Speech server

HiveMind uses any server with the OpenAI `POST /audio/transcriptions` endpoint:

| Choice | Address | Model | Key |
|---|---|---|---|
| Groq (free tier) | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | Groq key |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini-transcribe` or `whisper-1` | OpenAI key |
| Local [speaches](https://github.com/speaches-ai/speaches) / faster-whisper | `http://<server>:8000/v1` | e.g. `Systran/faster-whisper-small` | none |

- **Language:** leave it empty to detect it, or set `en`, `nl`, `de` and so on.
- **API key:** leave it empty when an AI provider with the same address is set up. HiveMind then reuses that provider's key, so a Groq provider is enough for free voice input.

### Microphone and https

Browsers only allow the microphone on **https** or **localhost**. On plain `http://192.168.x.x:4820`, the 🎤 button says so and opens a file picker instead. On a phone, that picker can record a voice memo directly. For live recording on other devices, serve HiveMind over https, for example through Nginx Proxy Manager or a Tailscale/Cloudflare tunnel, and set `SECURE_COOKIES=true`.

The server takes recordings up to 25 MB in any common format: webm/opus from Chrome and Firefox, mp4 from Safari, and mp3, wav, ogg or flac files.

## Text to speech

- **Browser voice** (default): free and needs no setup. It uses the voices built into the device. Quality depends on the browser and operating system.
- **Speech server:** any OpenAI-compatible `POST /audio/speech` server. HiveMind asks it for mp3.

| Choice | Address | Model | Voice |
|---|---|---|---|
| OpenAI TTS | `https://api.openai.com/v1` | `gpt-4o-mini-tts` or `tts-1` | `alloy`, `nova`, … |
| [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (local) | `http://<server>:8880/v1` | `kokoro` | `af_bella`, … |
| Piper via [openedai-speech](https://github.com/matatonic/openedai-speech) (local) | `http://<server>:8000/v1` | `tts-1` | `alloy`, … |

Markdown, links and code blocks are stripped before the text is spoken. Answers are cut at 4096 characters.

## Server routes

- `POST /api/voice/transcribe`: the body is the raw recording (`audio/*`); the answer is `{ "text": "…" }`.
- `POST /api/voice/speak`: the body is `{ "text": "…" }`; the answer is the audio (`audio/mpeg`).
- `GET`/`PUT /api/settings/voice`: keys are never sent back, only whether one is saved.
- `GET /api/voice/fast-whisper`, `POST /api/voice/fast-whisper/:id/download`, `DELETE /api/voice/fast-whisper/:id`: the fast engine's models (download and delete are for admins); `/api/voice/whisper/…` does the same for whisper.cpp.

Both routes accept the session cookie or an API token. A phone app can use them too.
