# Projects, GitHub, Pause, Site builder and skills

HiveMind can build real websites: folders of files that stay between runs, a workflow that keeps building one site
run after run, a check moment before anything is published, a push to GitHub, and your own skills.

Everything runs inside the HiveMind container and is stored under `/data`. Nothing is installed on the server
outside the image, and no second container is needed.

## Projects

A **project** is a folder with an owner (`/data/files/projects/<id>/`). Open the **Projects** tab:

- **Files:** a file tree with New file, New folder, Upload (also a `.zip`), Move/Rename, Delete, and an editor
  for text files (Ctrl+S saves). **Download .zip** gives the whole project.
- **Preview:** the project as a website. It runs sandboxed on a signed link that works for 12 hours: the page
  can't use your HiveMind login or read HiveMind's pages. **Open in a new tab** works too.
- **History:** what each run, upload or edit changed, with a diff per file, and the git commits.
- **GitHub** and **Build**: see below.

Only the owner (and admins) can see or change a project. Limits: 200 MB per project, 5,000 files, 2 MB per file
written by a block (50 MB per uploaded file). Paths can't leave the project (`..`, absolute paths, links), and
nothing can write into `.git`.

## Project blocks

Each has a **Project** setting: one of your projects, or *From the run*, which uses `vars.project` (a project
name or id). With that, one workflow works for many sites:

```json
POST /api/runs  { "canvasId": "…", "question": "Add a contact page", "vars": { "project": "My site" } }
```

| Block | What it does |
|---|---|
| **Read project** | The file list, `PROJECT.md` (always) and the files matching its patterns (`*.html, css/*, src/**`), up to a character budget (default 60,000). Files that don't fit are listed by name. *Only the files named in the input* reads just the files a plan names. |
| **Write files** | Writes the files in the answer wired into it, making folders: code blocks with a path (` ```html path=pages/about.html `) or JSON `{"files": [{"path", "content"}], "delete": ["old.html"]}`. Overwrite (default) or *only new files*. Refuses `.sh`, `.bat`, `.exe` and other scripts. Its output lists what changed (+/− lines). |
| **Update notes** | A model rewrites `PROJECT.md`: what the site is, its style, its pages and the decisions made (dated). Every Read project includes it, so each run knows what was chosen before. |
| **Build** | `npm ci` (or `npm install`) and an npm script (default `build`) for projects with a `package.json`. See *Builds*. |
| **Git** | Commit + push (default), commit, push, pull, or a pull request. Passes when the project isn't connected to GitHub. |
| **Pause** | Waits for you. See *Pause*. |
| **For each … Collect** | The blocks between a For each and its Collect run once per item of the list wired in (a JSON list such as `{"files": [...]}`, or one item per line). Blocks inside may also use blocks from before the For each. |

## Builds

The **Build** block (and **Build** on the project page) runs inside the HiveMind container:

- on a copy of the project in `/data/builds/<id>` (`node_modules` stays there between builds, not in the project);
- as the unprivileged user `hmbuild`, with the database, the secret key and everyone's files closed to it;
- with an empty environment (`PATH`, `HOME`, `NODE_ENV` and npm's cache only), so HiveMind's keys don't leak in;
- for at most 10 minutes, with a 2 MB log.

The output folder (`dist/`, else `build/` or `out/`, or the one you set) is copied back into the project, and the
preview shows it. The build can reach the internet (npm needs it) and your network.

Plain HTML sites need no build.

## GitHub

**Settings → GitHub** (each user their own): a fine-grained personal access token, stored encrypted and never sent
back (the page shows its last four characters, **Test** and **Remove**), and who commits (default: your login and
its noreply address).

Token rights: **Contents: read and write** for the repos you want (and **Pull requests: read and write** for pull
requests). Add **Administration: read and write** only if HiveMind should make new repos.

**Projects → GitHub → Connect:**

- an existing repo: an empty project gets the repo's files; a project with files starts a branch that is still
  empty on GitHub (otherwise you're asked to connect an empty project or pick a new branch);
- or a new private repo.

Then **Commit**, **Push**, **Pull** and **Pull request** work from the page and from the Git block.

- The token is never written into `.git/config` or a remote URL: each git call gets it through its environment,
  and it is masked in every message.
- Push never forces. When GitHub has newer commits, the push fails with git's message: **Pull** first. Pull puts
  your commits on top of GitHub's; when both sides changed the same lines, nothing changes and the message names
  the files.
- A pull request goes from a new branch (`hivemind/<date>` unless you name one) into the project's branch. After it,
  the project shows its own branch again; Pull once the request is merged.

## Pause

A **Pause** block stops the run there and shows a title, a message, what came into it (editable), the files the
run changed so far (with diffs) and the preview link. It shows on the canvas, in Use, and at the top of
**Activity → Waiting for you**; the Activity tab gets an orange badge.

- **Continue** sends the text on (your edited version when you changed it).
- **Reject** with a comment goes to the blocks wired after it whose name starts with **rejected** (e.g. a model
  that fixes things). Without such a block, Reject ends the run.
- **Stop** stops the run.

A waiting run holds no GPU. The time it waits doesn't count towards `RUN_TIMEOUT_MINUTES`, `maxSeconds` or
`cancelWhenAlone`. An optional time limit per block continues, rejects or stops by itself. A restart closes paused
runs (*Stopped by a restart*).

API: `POST /api/runs/:id/resume {"action": "continue" | "reject" | "stop", "text"?, "comment"?, "nodeId"?}` — the
run's owner or an admin (a limited token: its own runs).

## Site builder

**Workflow → Templates → Website → Site builder (project)** keeps building one site, run after run. Picking it asks
which project to use.

1. **Read project** — the file list, `PROJECT.md` and the pages, styles and scripts.
2. **Planner** — a JSON plan of the files to create, change or delete, with a reason each, following `PROJECT.md`.
3. **Pause: Check the plan** — edit the plan if you like.
4. **For each file in the plan:** *Read this file* → **Coder** (writes that one file) → **Write file**.
5. **Read the site** → **Reviewer** — checks links between pages, missing files and broken HTML, and writes fixes.
6. **Pause: Check the site** — the changed files with diffs, and the preview.
7. **Push to GitHub** — only when the project is connected.
8. **Update PROJECT.md** — what was done, for the next run.

The Coder and Reviewer get room for long answers on local models (16,384 tokens, a 32K context, an hour per
call). Writing one file per call keeps each answer short enough for them.

**Site: quick change** is the small version: Read project → Coder → Write files → Pause → Git.

## Skills

A skill is a folder with a `SKILL.md`, the same format as Claude skills:

```markdown
---
name: dark-report
description: When to use this skill, in one or two lines.
---
Instructions for the model…
```

**Settings → Skills:** upload a `.zip` (SKILL.md at the top or in one folder), import from a GitHub repo (with your
token for private ones), or write one in the editor. Only text files are kept (at most 1 MB each, 10 MB per skill);
nothing in a skill is ever run. An admin can share a skill with everyone.

**In a block** (AI model, Review, Judge): **Skills** →

- **These skills:** their instructions go into the system prompt.
- **Auto:** a short first call with the block's model picks 0–3 skills from the list of names and descriptions.

A loaded skill counts towards the context; above 30,000 characters it is cut off with a note. The run shows
*Skills loaded: …* on the block, also in the replay. You see your own skills and the shared ones. Limited API
tokens can use and list them, not change them.
