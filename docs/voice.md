# Voice

- **🎤 Speak.** In **Use mode**, next to Ask, and on the canvas **Question** block: click it, speak, then click again. HiveMind transcribes what you said, puts it in as the question and runs the canvas. A recording stops by itself after 60 seconds.
- **🔊 Read aloud.** On answers in Use mode and on the canvas's final answer. In Use mode, a question asked by voice is answered aloud automatically; you can switch this off under the answer.

Everything is set up in **Settings → Voice** (admins change it; everyone uses it). Errors show as a message and are logged in **Problems** with the source *voice*.

## Speech to text

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

Both routes accept the session cookie or an API token. A phone app can use them too.
