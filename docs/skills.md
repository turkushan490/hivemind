# Skills

A **skill** is a folder with a `SKILL.md` file: instructions a model follows, plus any extra files it needs. HiveMind uses the common `SKILL.md` format, and it can import many other formats too (Codex/ChatGPT, OpenCode, Cursor, Copilot, Gemini, plain Markdown, JSON, YAML, TOML).

## Add a skill

On the **Skills** page you can:

- **write** one in the editor;
- **upload** a `.zip`, `.skill`, `.tar.gz`, a folder or a single file;
- **paste** instructions as text;
- **import from GitHub** (`owner/name`, optionally a folder path and a branch).

Admins can **share** a skill with everyone. HiveMind ships with one shared skill, `hivemind-workflows`, which teaches a model how to build HiveMind workflows.

## Use a skill in a workflow

In an **AI model**, **Review** or **Judge** block, open **Skills** and pick:

- **Off** — no skills;
- **Fixed** — always follow the skills you pick;
- **Auto** — the model picks the skills it needs from the list.

Picked skills come first in the model's instructions. Where a skill and the block's own instructions differ (format, style, settings), the skill wins.

## Example

`SKILL.md`:

```markdown
---
name: short-answers
description: Answer in at most three sentences, plain words, no lists. Use for quick questions.
---

# Short answers

- At most three sentences.
- No bullet lists, no headings.
- End with one concrete tip.
```

Save it on the **Skills** page, set an AI model block to **Fixed → short-answers**, and every answer of that block is short.

The **Skill** block (added by the Builder or HiveBot) can also read your skills or save a new one from inside a workflow. See [blocks.md](blocks.md).
