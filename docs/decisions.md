# Decision models (Jev and friends)

Decision models don't chat. They read a **state** (text), answer **typed questions** with probabilities and
take about 0.1 s. HiveMind uses them for the **Decide** block, the **Auto (Jev router)** model, **Decide with
Jev** on the Router, **Jev scoring** in Judge and Vote, the optional **canvas router** for voice, and the Lab's
fast rules-checker.

The rule from the [Jev guide](https://github.com/theNetworkChuck/jev-guide): *the model makes the judgment call,
code decides what to do with uncertainty* (the **threshold**, default 0.6).

## Providers (Settings → Providers → Decisions)

| Card | What | Key |
|---|---|---|
| **TypeSafe (Jev)** | `POST https://api.typesafe.ai/v1/systemone`. Models from `GET /v1/models`, plus `jev-1.14.0` for box questions. $0.042 per million input tokens, output free. | Yes, from console.typesafe.ai/keys. Or set `TYPESAFE_API_KEY` on the container: it is added once, encrypted. |
| **Ollama decision models** | Nimble, Tev1, Clef on your own GPU, via Ollama 0.35+ `POST /v1/systemone`. Same shape as TypeSafe; images are sent as base64 `images`. Shares the GPU lock with Ollama and ComfyUI. | No |
| **OpenAI Decisions** | `POST /v1/decisions` with `gpt-6-luna`. | Yes |
| **Clef (Ollama cloud)** | Clef / Clef Flash on `https://ollama.com/v1/systemone`. | Yes, an ollama.com key |

**Test** on a card runs the spam example from the Jev guide and shows the answer as bars. A wrong key or a 4xx
answer shows up there and in **Problems**. Decision models never appear in the model pickers of chat blocks.

### Wire formats (checked against each service)

The adapters map one internal shape to each service. Sources: TypeSafe's API reference (synced into
[typesafe-docs/typesafeai](https://github.com/typesafe-docs/typesafeai)), the
`typesafe-danger-zone-images` / `assets` handling in community SDKs for Jev 1.14 box questions, OpenAI's
`openai-node` SDK (`src/resources/decisions.ts`), and Ollama's own `docs/capabilities/decision.mdx` and
`api/types.go`.

| HiveMind | TypeSafe / Ollama `/v1/systemone` | OpenAI `/v1/decisions` |
|---|---|---|
| request | `{model, state, questions: {name: {type, instructions, criteria}}}` | `{model, input, questions: [{name, type, instructions, …}]}` |
| yes/no | `noul` → `{noul: p}` | `predicate` → `{probability}` |
| choice | `criteria: {option: description}` → `{choice, probabilities, confidence}` | `choices: [{value, description}]` → `probabilities: [{value, probability}]` |
| score | `criteria: [levels low→high]` → `{score, probabilities: {"0": p…}}` | `levels: [{label}]` → `probabilities: [{label, value, probability}]` |
| box | `type: "box"` + `assets` + header `TypeSafe-Danger-Zone-Images: true` (Jev 1.14) → `{box: {top, bottom, left, right}}` | not supported |
| images | TypeSafe: `assets` with a reference in the state. Ollama: `images: [base64]` | `input_image` parts with a data URL |
| usage | `usage.input_tokens` | `usage.input_tokens` |

## Decide block (Logic)

- **State:** a template (default: the text wired in, else the question; `{{vars.x}}` works).
- **Questions:** cards with a name, a type (`noul` / `choice` / `score` / `box`), the instructions, and options
  or levels. A choice can mark a **safe** option.
- **Threshold:** a yes/no is *yes* when p ≥ threshold. A choice under the threshold follows the `fallback`
  branch, or else its safe option.
- **Branches:** name the blocks after it `yes` / `no` (first yes/no question), an option of the first choice
  question, `fallback`, or `question: answer` (e.g. `spam: yes`). Only the winning branch runs; the others are
  skipped. Blocks with other names always run.
- **Output:** the answers as JSON (`{answers, decision, summary, model, ms}`), so JSON mode and per-node outputs
  work downstream.
- **Animation:** probability bars per question fill up when the answer arrives, the pick glows, and the decision
  time in ms is shown. Replay shows it too, because it comes from `node_progress.decision`.
- **Box:** when the text wired in contains a picture (`hm-file:`), that picture is judged. The Inspector draws
  the box on it. TypeSafe Jev 1.14 only; pair it with a yes/no question, because a box always comes back.

## Auto (Jev router) model on the AI model block

Switch an AI model block to **Auto (Jev router)** and fill in **small**, **medium**, **large** (and optionally
**local**). Per question, the decision model answers one choice question ("Which size of AI model does this
request need?") with the size descriptions from the guide's router. If the top probability is under the
threshold, it moves up one size. The block shows the bars and "→ medium: gemini-…" before the model starts.

## Router: Decide with Jev

The Router can pick its branch with one Jev choice over the branch names instead of an LLM call. New Router
blocks use Jev by default when a decision provider is set up.

## Jev scoring in Judge and Vote

"Score with Jev first" gives every answer a quality score (0–3).

- **Judge:** it reads the answers best first, each with its score.
- **Vote without voters:** the best score wins.
- **Vote with voters:** the score breaks ties.

## Canvas router (Settings → Voice, optional)

A decision model picks which canvas a spoken question belongs to, using the canvas names and descriptions. It is
used for the mic in Use mode, and through the OpenAI-compatible API as the model `auto`, so one Home Assistant
agent reaches every canvas.

## Templates (Decisions group)

- **Spam check:** the six questions from the guide, then a Discord alert (`yes`) or a save (`no`).
- **Smart router:** Question → Auto model → Final answer.
- **Safe action (guard):** prompt-injection and personal-data checks before a Home Assistant action may fire.

## Costs

Every decision call is recorded in `run_usage` (Stats page). `jev-*` is priced at $0.042 per million input tokens.

## Feature flags

`/api/health` lists `decisionProviders`, `decide` and `autoModel`.
