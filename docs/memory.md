# Memory

HiveMind has two kinds of memory. Both live in your data folder and belong to your account.

## 1. Memory keys (the Memory block)

The **Memory** block stores entries under a name (a *key*), like `recipes` or `rules:srd51`.

- **Save:** remembers what flows through it.
- **Recall:** brings back the newest entries.
- **Search:** finds the best matching entries (full-text search), for example one rule out of a whole rulebook.

Keys can use templates, such as `notes:{{vars.user}}`. See and delete keys in **Settings → Memory**.

**Example — research that remembers** (the **Research with memory** template):

```
Question ─▶ Memory (Recall "research") ─▶ Web search ─▶ AI model ─┬─▶ Final answer
                                                                  └─▶ Memory (Save "research")
```

Import a whole document over the API and search it:

```bash
curl -H "Authorization: Bearer hm_..." -H "content-type: application/json" \
  -d '{"replace":true,"entries":[{"text":"Grapple: ..."},{"text":"Shove: ..."}]}' \
  http://your-server:4820/api/memory/keys/rules/import

curl -H "Authorization: Bearer hm_..." -H "content-type: application/json" \
  -d '{"query":"grapple","limit":3}' \
  http://your-server:4820/api/memory/keys/rules/search
```

## 2. Memory files (the Memory page)

The **Memory** page is a tree of Markdown files, such as `topics/food/potatoes.md`. HiveBot characters and Agent blocks read them before they answer and write to them after.

- You can view, edit, move and search the files.
- Every change keeps up to 20 older versions and records **who** changed it (you, a character or a job). You can restore an older version.
- Deleting moves a file to `archive/deleted`, so nothing is lost by accident.

In workflows, use the **Read memory** and **Write memory** blocks (the Builder and HiveBot add them), or give an **Agent** block the memory tools.
