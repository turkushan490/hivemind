# HiveBot

HiveBot is a **robot companion** that runs on HiveMind. It has characters (Jev, Jarvis, Ultron, Vision, Ghost, and Friday on the robot only), each with its own name, voice, memory and workflows. You talk to it on a small robot device, or in the browser on the **HiveBot** page.

## How it works

- You speak; HiveMind writes down what you said and decides **which character** answers, from the name you used and the conversation so far.
- The character runs its workflows, reads and writes its [memory files](memory.md), and answers out loud.
- Long tasks (such as building a website) run as **background jobs**. The robot keeps talking and tells you when a job is done.
- Quick chat goes ahead of background work in the [GPU queue](ollama.md#the-gpu-queue).

## Set it up

1. **Settings → Voice:** pick speech-to-text and a voice (see [voice.md](voice.md)).
2. **HiveBot** page: try the characters in the browser first.
3. **Settings → Robots & installers** (admins): add a robot. Each robot gets its **own API token**, limited to the robot API, the voice API and the HiveBot workflows, so a lost robot can be revoked on its own. Set the device's PIN (4–8 digits) there too.
4. The robot reports in every minute (battery, Wi-Fi, firmware) and gets its settings back (volume, microphone sensitivity, screen).

## Give a character its own voice

Use the Voice blocks: **Audio prep → Voice dataset → Voice clone**. Attach recordings to the question and type the character's name, for example `Jarvis`. The result is a voice called `clone:jarvis` that the robot and the app can speak with. See [blocks.md](blocks.md#voice).

## Example

On the **HiveBot** page, say or type:

> *"Jarvis, remember that I like my coffee black."*

Jarvis answers and can keep the fact in its memory files (see them on the **Memory** page). Ask *"Jarvis, how do I take my coffee?"* later and it looks it up.
