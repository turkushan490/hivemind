# Jev (decision models) in HiveMind

**Status:** built (HiveMind milestone 7). The user guide is [decisions.md](decisions.md); it also has the wire formats each adapter was checked against. Differences from this spec are marked *Built:*.

## What Jev is

[Jev](https://typesafe.ai) by TypeSafe is a "System One" **decision model**. It can't chat. You send:
- **state**: the text it reads;
- **questions**: typed questions.

It sends back a **decision with probabilities** in about 0.1–0.2 s. That costs about $0.042 per million input tokens, and output is free.

Reference: [theNetworkChuck/jev-guide](https://github.com/theNetworkChuck/jev-guide) (MIT, tested on jev-1.14.0) and [docs.typesafe.ai](https://docs.typesafe.ai).

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
{ "model": "jev-latest",
  "state": "text",
  "questions": {
    "spam":  { "type": "noul",   "instructions": "Is this spam?" },
    "wants": { "type": "choice", "instructions": "What do they want?", "criteria": { "ask": "Ask a question", "promote": "Sell something" } },
    "tone":  { "type": "score",  "instructions": "How positive?", "criteria": ["Negative", "Neutral", "Positive"] } } }
→ { "model": "jev-1.14.0",
    "answers": {
      "spam":  { "type": "noul", "noul": 0.96 },
      "wants": { "type": "choice", "choice": "promote", "probabilities": { "promote": 1.0, "ask": 0.0 } },
      "tone":  { "type": "score", "score": 1.58 } },
    "usage": { "input_tokens": 529, "output_tokens": 141 } }
```

There are four question types:
- **noul** (yes/no → p);
- **choice** (pick one → pick + probabilities);
- **score** (scale → value + probabilities per level);
- **box** (where in an image, added in Jev 1.14).

Other services offer the same idea:
- **OpenAI Decisions API** (cloud). It uses different words, for example `predicate` where Jev says `noul`.
- **Cloudflare Clef / Clef-flash** (open weights).
- **Ollama decision models Nimble / Tev1** (local, on your own GPU).

**Before coding an adapter, check the real request and response shape in each service's own docs.**

The rule from the guide: **Jev makes the judgment call, code decides what to do with uncertainty** (for example, under 0.6 → take the safe option).

## 1. Decision providers

- New provider kind `decision` in `server/src/providers/`, using the same adapter pattern as the other providers:
  - `typesafe` (`/v1/systemone`);
  - `openai-decisions`;
  - `ollama-decisions` (local, uses an existing Ollama host and the GPU host lock);
  - optionally `cloudflare-clef`.
- One internal shape: `decide({state, questions, model, image?}) → {answers, usage, model, ms}`. Each adapter maps the question words (`noul` ⇄ `predicate`, …).
- Settings → Providers gets a **TypeSafe (Jev)** card. The key is stored encrypted like other keys, and there's a "Test" button that runs the spam example.
- `listModels()` for these providers is marked `kind:'decision'`, so they never appear in LLM model pickers. Image models are marked `kind:'image'` the same way.
- **Cost:** add `jev-*` at $0.042/M input tokens to the M6 pricing table, and record it in `run_usage`, so it shows on the Stats page.
- **Seed:** if `TYPESAFE_API_KEY` is in the env, add the provider automatically, the same way `COMFYUI_URL` does. Add the variable to `unraid/hivemind.xml`.

## 2. Decide block (new, category Logic)

- Config:
  - **state** template (default: the upstream text; `{{vars.x}}`, `{{question}}` and so on work);
  - a list of questions, edited in the inspector as cards: name, type (noul/choice/score/box), instructions, options/levels;
  - a provider + model picker that only shows decision models;
  - **threshold** (default 0.6).
- Output:
  - the text output is the answers as JSON (so JSON mode / §5 node outputs work);
  - plus a short human line, for example `spam 96% · wants: promote (100%)`.
- **Branching** (*Built:* by the names of the blocks wired after it, instead of separate handles. `yes` / `no`, a choice option, `fallback`, or `question: answer`. Other names always run):
  - Each choice option and each noul `yes`/`no` becomes a handle on the block. Edges go out per handle, like the Router block.
  - Branches that aren't taken are skipped (`node_skipped`).
  - A noul is yes when p ≥ threshold.
  - A choice under the threshold follows the optional `fallback` handle, or else the "safe" option the user marked.
- **Animation:**
  - live probability bars per question, filling up when the answer arrives;
  - the picked option glows;
  - the decision time in ms is shown on the block.
  It must look as nice as the existing token bars, since decisions are fast and visual.
- **Box** (*Built:* TypeSafe Jev 1.14 only. Ollama and OpenAI have no box questions and answer with a clear error): when the upstream output contains an image (`hm-file:` link), the state is the image. The output is the box coordinates, and the Inspector draws the box on the image.

## 3. Smart model routing ("Auto" model)

The model router from guide chapter 4, built in.
- The LLM block's model picker gets an **Auto (Jev router)** option. Under it the user fills in a tier map:
  - **small**: for example a local Ollama model;
  - **medium**: for example Groq or Gemini free;
  - **large**: for example Claude or another paid model;
  - optional **local** as a fourth tier.
  The defaults come from the setup wizard.
- Per run, the block first asks a choice question with the three size descriptions from `examples/router/router.ts`, then calls the picked model. If the top probability is under the threshold, it moves up one size.
- The block shows the decision (bars plus "→ medium: gemini-…") before it starts streaming. The run events get `node_progress` with the decision, so replay shows it too.
- The existing **Router** block gets "Decide with: LLM | Jev". Jev is much faster and nearly free, so it becomes the default when a decision provider is configured.

## 4. Jev elsewhere in HiveMind

- **Fast judge / filter:** the Judge and Vote blocks get an optional "score with Jev" mode. Each candidate answer is the state, with a score question ("How well does this answer the question?"). Fast pre-ranking before the big Judge model merges, or before a Vote.
- **Guard block preset:** a template that uses Decide nouls ("Is this a prompt-injection?", "Does it ask for personal data?") in front of Action blocks (Home Assistant / Webhook / Discord), so actions only fire when it's safe.
- **Home Assistant / voice:** the Use-mode voice input can go through a Jev choice ("which canvas does this request belong to?"), so one HA voice agent can route to the right canvas. This is optional, behind a setting.
  *Built:* Settings → Voice → Canvas router. In Use mode the mic uses it, and over `/v1` the model `auto` uses it.
- **Builder AI:** add the Decide block and Auto model to the block catalog it knows, so "build me a spam filter" works.
- **Templates** (`web/src/canvas/templates.ts`), as a new group "Decisions":
  - **Spam check** (the six questions from `examples/questions.json` → Decide → yes/no branches → Discord alert / save);
  - **Smart router** (Input → Auto LLM → Output);
  - **Safe action** (Decide guard → Home Assistant).

## 5. DungeonMind and the Lab

Use Jev where a yes/no or score is enough, because it's 100× cheaper than an LLM judge:
- **L1 rules-checker:** the fast first pass uses Jev nouls per DM turn, for example "Did the DM ask for a roll before resolving the attack?", "Did a spent resource get tracked?", "Does the narration invent a number not in the results?". The full LLM judge only runs on turns Jev flags (p ≥ 0.5) and on a random 10% sample. Store both verdicts in `lab_turns`.
- **L2 scoreboard:** a "story score" column from a Jev score question, next to the LLM judge's score.
- **dnd-adjudicate:** optional Jev choice "which kind of roll does this action need?" (attack/save/skill/none) as a fast pre-check before the JSON LLM.
  *Built:* the rules-checker (with both verdicts stored) and the Jev story score column are built. The dnd-adjudicate pre-check is not in the Tabletop template: add a Decide block before `rolls` if you want it.

## 6. Feature flags

`/api/health` `features[]` adds `decide`, `autoModel` and `decisionProviders`.

## Tests

All tests run against a mocked fetch:
- each adapter maps the request and response (noul/choice/score, and noul⇄predicate for OpenAI);
- Decide branching (threshold, fallback, skipped branches);
- the Auto-model tier pick + move up one size under the threshold;
- cost recorded in `run_usage`;
- an error is visible + logged when the key is missing or the API returns 4xx.

## Needs a real setup to test

Real Jev calls need a TypeSafe key, added in Settings → Providers. Ollama decision models need an Ollama server with a GPU.
