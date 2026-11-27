# Blocks

A workflow (canvas) is a set of blocks joined by wires. The question comes in at the **Question** block, flows along the wires, and the **Final answer** block gives the result. Blocks with no wire between them run at the same time.

In prompts you can use `{{question}}` (the question), `{{inputs}}` (what the wired blocks wrote), `{{vars.name}}` (run variables, for example from the API), `{{history}}` (the chat so far) and `{{now}}` (date and time).

**Example — a small council:**

```
Question ─┬─▶ AI model (A) ─┐
          ├─▶ AI model (B) ─┼─▶ Review ─▶ Judge ─▶ Final answer
          └─▶ AI model (C) ─┘
```

Below, every block, grouped as in the block panel on the left of the canvas.

## Core

| Block | What it does |
|---|---|
| **Question** (`input`) | Where the question comes in. Every canvas starts here. You can attach pictures, files and audio. |
| **AI model** (`llm`) | Answers with one model. Gets the question, or the answers of the blocks wired into it. Has its own system prompt, temperature, context size, JSON mode and skills. |
| **Agent** (`agent`) | A character that does a task itself, step by step, with tools: memory, search, project files, shell, browser, its own workflows and teammates. |
| **Review** (`review`) | Critiques and ranks the answers wired into it. Model names are hidden (Answer A, B, C), so no model is favoured. |
| **Judge** (`judge`) | Merges all incoming answers and reviews into one final answer, and notes where the models disagreed. |
| **Final answer** (`output`) | The result of the canvas: what Use mode, the API, HiveBot and Home Assistant get back. |

## Logic

| Block | What it does |
|---|---|
| **Router** (`router`) | A model picks which of the blocks after it gets the question; the other branches are skipped. Give those blocks clear names, like "Coding" or "Cooking". |
| **Condition** (`condition`) | No model: if the incoming text contains a word (or a `/pattern/`), the branch named "yes" runs, else the one named "no". |
| **Workflow (make/run)** (`workflow`) | A HiveBot character makes, changes, runs or deletes its own workflows, only in its own workspace folder. |
| **Decide** (`decide`) | A decision model answers yes/no, choice and score questions in about 0.1 s, with probabilities. Name the next blocks "yes", "no", an option or "fallback": only the winning branch runs. See [decisions.md](decisions.md). |
| **Debate** (`debate`) | Several models answer, read each other's answers and improve their own, for a number of rounds. |
| **Vote** (`vote`) | One or more models vote for the best of the answers wired in; the winner is passed on. |
| **Review panel** (`panel`) | Several AIs, picked at random from a pool, each review what is wired in. A reviewer that fails is replaced from the pool. |
| **Pause** (`pause`) | Stops the run and waits for you. You see what came in (and changed files, with a preview), then Continue, Reject or Stop. |
| **For each** (`foreach`) | Runs the blocks between it and its **Collect** block once per item of a list (a JSON list, or one item per line). |
| **Collect** (`collect`) | Ends a For each: gathers what every item gave, in order, and passes it on. |

## Data

| Block | What it does |
|---|---|
| **Text template** (`template`) | Fixed text with `{{question}}` and `{{inputs}}` filled in. Good for instructions or for reshaping a question. |
| **File** (`file`) | Text from a file (txt, md, csv, json or PDF) for the models to use. Wire it into a model block. |
| **Web search** (`search`) | Searches the web: Wikipedia for free, or Brave, Tavily or your own SearXNG (set them up in **Settings → Web search**). |
| **Deep search** (`deepSearch`) | Searches in rounds: reads a few sites, then decides to stop, read more or search with other words. Gives the sites it read. |
| **Memory** (`memory`) | **Recall** what was saved under a name, **Search** for the best matching entries, or **Save** what flows through it. See [memory.md](memory.md). |

## Create

| Block | What it does |
|---|---|
| **Image** (`image`) | Makes a picture with your ComfyUI or an image API. Put a model before it that writes the prompt. 1–8 pictures per run. |
| **Save file** (`save`) | Saves what is wired into it as a file in the files folder (`outputs/`): a website, Markdown, text, JSON, CSV or code, with a preview. |

## Action

| Block | What it does |
|---|---|
| **Home Assistant** (`homeassistant`) | Reads entity states (live facts for the models), or calls a service like `light.turn_on`. Connect Home Assistant in **Settings** first. |
| **Webhook / HTTP** (`webhook`) | Calls any web address (GET, POST, …) with your headers and a body template, and passes the response on. |
| **Discord** (`discord`) | Posts the text (or your message template) to a Discord channel through a webhook. |

More about these: [action-blocks.md](action-blocks.md).

## Project

| Block | What it does |
|---|---|
| **Read project** (`readProject`) | Reads a project (a folder of files, such as a website): its file list, `PROJECT.md` and the files you pick. Put it before a model that changes the project. |
| **Write files** (`writeFiles`) | Writes the files from the answer into the project, from code blocks like ` ```html path=pages/about.html ` or JSON `{"files": [...]}`. |
| **Update notes** (`updateNotes`) | A model keeps `PROJECT.md` up to date (what the site is, its style, pages, decisions), so the next run knows what was chosen before. |
| **Build** (`build`) | Runs `npm install` and an npm script for projects with a `package.json`. The output folder (`dist/`) is what the preview shows. |
| **Git** (`git`) | Commits and pushes the project to its GitHub repo, pulls, or opens a pull request. Never force-pushes. Needs a token in **Settings → GitHub**. |
| **Shell** (`shell`) | Runs bash or PowerShell commands in a sandbox: build, test, make a Windows .exe with Go or .NET, run it with Wine. Admins and HiveBot only. The Docker image has all the tools. |
| **Browser** (`browser`) | A headless browser: open pages, click, type, take screenshots, read console errors, check links, or test every page of a project. The Docker image has Chromium built in. |

More about projects: [projects.md](projects.md).

## Train

| Block | What it does |
|---|---|
| **Generate examples** (`generate`) | A teacher model writes training examples (an input and the ideal answer) and stores them in a dataset. |
| **Add to dataset** (`dataset`) | Keeps the answer as a training example. Put a Decide or Judge before it to keep only the good ones. |
| **Train model** (`train`) | Trains a new model on a dataset in the background. It lands in Ollama under its own name. Needs a GPU. |
| **Evaluate** (`evaluate`) | Gives test examples to several models; a judge grades their answers. The scores come out as a table. |
| **Deploy model** (`deploy`) | Puts a model (for example the one you just trained) into the AI model blocks of the canvases you name. |

More about training: [lab.md](lab.md).

## Voice

| Block | What it does |
|---|---|
| **Audio prep** (`audioPrep`) | Cuts the recordings attached to the question into clean 3–15 s clips and throws away the bad ones. |
| **Voice dataset** (`voiceDataset`) | Writes down what is said in each clip and keeps the clips in a voice dataset. |
| **Voice clone** (`voiceClone`) | Builds a voice (`clone:<character>`) from the best clips. The app and HiveBot can then speak with it. |
| **Speak** (`speak`) | Says text in a built-in or cloned voice, as audio files you can play in the run. |

## Blocks made by the Builder, HiveBot or apps

These are not in the block panel. The Builder AI, HiveBot or a workflow saved as JSON can add them.

| Block | What it does |
|---|---|
| **Read memory** (`readMemory`) | Reads Markdown memory files and passes their text on. Give it paths, or put a small "picker" model before it. |
| **Write memory** (`writeMemory`) | Writes what is wired into it to a memory file (replace, append or move). Keeps versions and who changed it. |
| **Skill** (`skill`) | **Read:** lists your skills, or gives one whole. **Save:** the `SKILL.md` wired in becomes a skill. See [skills.md](skills.md). |
| **Run workflow** (`runWorkflow`) | Starts another saved canvas as a background job, so a long build runs while the conversation goes on. |
| **Say now** (`sayNow`) | Sends a short line to the robot or app straight away while the rest of the workflow keeps running. |
