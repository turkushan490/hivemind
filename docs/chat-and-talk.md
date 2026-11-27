# Chat & Talk

The easiest way to use HiveMind is to **ask a saved workflow**, by typing or by speaking.

> **Coming soon:** a Chat block that keeps a whole conversation on the canvas. Until then, use the ways below.

## Use mode

**Use** in the top menu is the simple screen: pick a canvas, type a question, get the answer. A compact view under the answer shows how it was made (which models, how long, the cost). You can attach pictures, files and audio to a question.

Viewers (a role for people who only use shared canvases) see only this screen.

## Talk with your voice

- **🎤** next to *Ask* (and on the canvas Question block): click, speak, click again. HiveMind writes down what you said and runs the canvas.
- **🔊 Read aloud** on answers. A question asked by voice is answered aloud by itself.

Set it up in **Settings → Voice**. The Docker image has built-in speech-to-text and a built-in voice; the Windows .exe has built-in speech-to-text. You can also use Groq (free tier), OpenAI or your own speech server. Details: [voice.md](voice.md).

> The microphone only works in the browser over **HTTPS** (or on `localhost`). Behind a reverse proxy, set `SECURE_COOKIES=true`.

## Chat from other apps

Every saved canvas is a chat model on the [OpenAI-compatible API](api.md). Send the whole conversation in `messages` and the canvas gets it as `{{history}}`. This works with Open WebUI, Home Assistant, phone apps and anything that speaks OpenAI.

## Example

1. On the **Workflow** page, click **New ▾ → Voice → Voice assistant** and save it.
2. Open **Use**, pick it, press 🎤 and say *"What's a quick dinner with potatoes?"*.
3. The answer appears and is read aloud.
