# Training Lab (DungeonMind)

The **Lab** tab simulates D&D games with fake players, checks every DM turn, builds a fine-tuning dataset and
compares models. It covers L1 (simulator and datasets) and L2 (scoreboard) of
[HIVEMIND_CHANGES.md](HIVEMIND_CHANGES.md); the code lives in `server/src/lab/` and `web/src/lab/`.

## Simulator

- **Setup:**
  - **DM model(s):** pick more than one to compare them. Games take turns between the models, and game *n* of
    every model uses the same seed: same scenario, same party, same dice.
  - **Fake players:** one model plays every persona:
    - a reckless fighter;
    - a rules-lawyer wizard who tries to cheat spell slots;
    - a sneaky rogue;
    - a healer cleric;
    - a typo-heavy casual bard ("ik cast fierbolt op die gast").
  - **Rules-checker:** Jev for the fast pass, an LLM judge, or both.
  - **Size and seed:** party size 2–5, turns per game, and the seed.
- **Each turn:**
  1. The server rolls the dice.
  2. The players act.
  3. The DM answers in JSON mode with narration, the rolls it needs, the resources spent, HP changes,
     conditions and XP.
- **Mini bookkeeper** (`server/src/lab/state.ts`): tracks HP, spell slots, counters (current / max / recharge),
  conditions and XP. It applies the DM's bookkeeping, so spending a resource at 0 (e.g. "Channel Divinity used
  while at 0/1") is caught for certain.
- **Rules-checker:**
  - The **Jev fast pass** asks four yes/no questions per turn (missing roll, untracked resource, invented
    number, contradiction) plus a story score.
  - The **LLM judge** only checks turns that Jev flags (p ≥ 0.5), that the bookkeeper caught, or that fall in a
    random 10% sample. Without Jev it checks every turn.
  - The judge also reads matching rules from `rules:srd51` memory when that has been imported.
  - Both verdicts are stored.
- **Start / Stop:**
  - The sim runs until you press Stop.
  - The status panel shows games, turns, errors per 100 turns and turns per minute.
  - A failed turn shows the error and is logged to **Problems**. Five failures in a row stop the run.
- **Real runs first:** every simulated model call takes the GPU host lock and gives it back right after, so a
  HiveMind or DungeonMind run that is waiting goes next.

## Datasets

- `lab_turns` keeps per turn:
  - the input (exactly what the DM saw) and the output;
  - both verdicts and the error types;
  - the story scores;
  - tokens/s and time;
  - the correction.
- Bad turns go to the **review queue**: accept the judge's correction (or edit it first) or reject the turn.
- **Export JSONL** gives chat format (`{"messages":[system, user, assistant]}`) for SFT: clean turns as they
  were, bad turns only with their accepted correction.

## Scoreboard

Per model and prompt version, best first:
- JSON valid %;
- rule and number errors per 100 turns;
- missed resources per 100 turns;
- story score (LLM judge and Jev);
- tokens/s and time per turn;
- VRAM (from what Ollama has loaded right now).

**Set as DungeonMind default** puts the model into the AI model blocks of your `dnd-*` canvases.

## API

| Method + path | What |
|---|---|
| `GET /api/lab` | The running sim's status and the past runs |
| `POST /api/lab/start` | `{dm: [ModelRef], players, judge?, jev?, partySize?, turnsPerGame?, seed?, maxGames?, maxTurns?, sample?, rulesKey?}` |
| `POST /api/lab/stop` | Stops it after the current call |
| `GET /api/lab/turns?runId=&pending=1` | Turns, or the review queue |
| `PATCH /api/lab/turns/:id` | `{review: "accepted" \| "rejected", corrected?}` |
| `GET /api/lab/export.jsonl?runId=` | The dataset |
| `GET /api/lab/scoreboard?runId=` | The scoreboard |
| `POST /api/lab/default` | `{model}`: set as the DungeonMind default |

## Not built yet (L3 / L4)

See the TODO at the end of [HIVEMIND_CHANGES.md](HIVEMIND_CHANGES.md): local QLoRA fine-tuning with Unsloth on
the T4, and Hugging Face training and publishing.
