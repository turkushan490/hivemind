import type { BuildResult, FileChange, PauseAction, PauseInfo, ProjectFile } from '@hivemind/shared';
import type { NodeContext, NodeDefinition } from './index.js';
import { answers, fill, labelled, parseJson } from './index.js';

/**
 * Project blocks: read a project's files into the run, write files from a model's answer, keep PROJECT.md up to
 * date, commit and push with git, build with npm, wait for a person (Pause), and run part of a workflow once per
 * item (For each … Collect).
 */

/** What project blocks may do, for the person who runs the workflow (bound to them in events/runs.ts). */
export interface ProjectServices {
  find(idOrName: string): { id: string; name: string; repo?: string; branch?: string };
  tree(id: string): ProjectFile[];
  read(id: string, path: string): string | undefined;
  write(id: string, path: string, content: string, mode: 'overwrite' | 'new'): FileChange;
  remove(id: string, path: string): FileChange[];
  /** Stores this run's changes in the project's history, and keeps them for a Pause block to show. */
  record(id: string, changes: FileChange[]): void;
  /** Everything this run changed so far (latest change per file). */
  changes(): FileChange[];
  previewUrl(id: string, path?: string): string;
  git(
    id: string,
    action: 'commit' | 'push' | 'commitPush' | 'pull' | 'pr',
    opts: { message: string; body?: string; branch?: string; signal?: AbortSignal },
  ): Promise<{ text: string; url?: string; sha?: string; skipped?: boolean }>;
  build(id: string, opts: { script?: string; outDir?: string; signal?: AbortSignal; onLog?: (t: string) => void }): Promise<BuildResult>;
}

export interface PauseServices {
  /** Waits until the person answers (or the block's time runs out). Stop cancels the run. */
  wait(info: PauseInfo, signal?: AbortSignal): Promise<{ action: PauseAction; text?: string; comment?: string }>;
}

const err = (message: string) => new Error(message);

function needProjects(ctx: NodeContext): ProjectServices {
  if (!ctx.services.projects) throw err('Projects are not available here');
  return ctx.services.projects;
}

/** The block's project: its own setting (may use {{vars.x}}), else vars.project. */
export function projectOf(ctx: NodeContext) {
  const raw = ctx.node.config.project?.trim() ? fill(ctx.node.config.project, ctx).trim() : (ctx.vars.project ?? '').trim();
  if (!raw) throw err('Pick a project on the block, or send it as vars.project');
  return needProjects(ctx).find(raw);
}

const inputText = (ctx: NodeContext) => {
  const prev = answers(ctx.inputs);
  return prev.length ? prev.map((p) => p.text).join('\n\n') : ctx.question;
};

// ---- Read project ----

const DEFAULT_GLOBS = ['*.html', '*.htm', '*.css', '*.js', '*.mjs', '*.jsx', '*.ts', '*.tsx', '*.vue', '*.svelte', '*.md', '*.json'];
const SKIP_DIRS = ['node_modules/', 'dist/', 'build/', '.next/', 'out/'];

/** "*.html" matches in every folder; "css/*" one folder; "**" any depth. */
export function globToRe(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const re = g
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  return g.includes('/') ? new RegExp(`^${re}$`, 'i') : new RegExp(`(^|/)${re}$`, 'i');
}

/** Project paths named in a text: a plan's JSON ({files: [{path}]}, [{path}], {path}), else any tree path the text mentions. */
export function namedPaths(text: string, tree: { path: string }[]): string[] {
  const out = new Set<string>();
  const take = (v: unknown) => {
    if (typeof v === 'string') out.add(v.replace(/^\.?\//, ''));
    else if (Array.isArray(v)) v.forEach(take);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.path === 'string') out.add(o.path.replace(/^\.?\//, ''));
      for (const k of ['files', 'items', 'plan', 'read', 'needs', 'uses']) if (k in o) take(o[k]);
    }
  };
  try {
    take(parseJson(text));
  } catch {}
  for (const f of tree) if (text.includes(f.path)) out.add(f.path);
  return [...out];
}

function fence(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext.length <= 6 ? ext : '';
}

const READ_PROJECT: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    const svc = needProjects(ctx);
    const p = projectOf(ctx);
    const tree = svc.tree(p.id);
    const budget = Math.max(1000, Math.min(500_000, ctx.node.config.budget ?? 60_000));
    const notes = svc.read(p.id, 'PROJECT.md');
    let wanted: ProjectFile[];
    if (ctx.node.config.onlyNamed) {
      const named = new Set(namedPaths(inputText(ctx), tree));
      wanted = tree.filter((f) => named.has(f.path) && f.text);
    } else {
      const globs = (ctx.node.config.globs?.trim() ? ctx.node.config.globs.split(/[\n,]+/) : DEFAULT_GLOBS).map((g) => g.trim()).filter(Boolean).map(globToRe);
      wanted = tree.filter((f) => f.text && f.path !== 'PROJECT.md' && !SKIP_DIRS.some((d) => f.path.startsWith(d)) && globs.some((g) => g.test(f.path)));
    }
    let used = notes?.length ?? 0;
    const parts: string[] = [];
    const left: string[] = [];
    for (const f of wanted) {
      if (f.path === 'PROJECT.md') continue;
      const text = svc.read(p.id, f.path) ?? '';
      if (used + text.length > budget) {
        left.push(`${f.path} (${f.size} bytes)`);
        continue;
      }
      used += text.length;
      parts.push(`### ${f.path}\n\`\`\`${fence(f.path)}\n${text}\n\`\`\``);
    }
    ctx.progress(`${parts.length} file${parts.length === 1 ? '' : 's'} read from ${p.name}${left.length ? `, ${left.length} did not fit` : ''}`);
    const list = tree.filter((f) => !SKIP_DIRS.some((d) => f.path.startsWith(d))).map((f) => `- ${f.path} (${f.size} bytes)`);
    return [
      `# Project: ${p.name}`,
      `## PROJECT.md (the project's notes)\n${notes?.trim() || '(none yet)'}`,
      `## Files (${tree.length})\n${list.slice(0, 1000).join('\n') || '(no files yet)'}${list.length > 1000 ? `\n… and ${list.length - 1000} more` : ''}`,
      parts.length ? `## File contents\n\n${parts.join('\n\n')}` : '## File contents\n(none read)',
      ...(left.length ? [`## Not included (over the ${budget}-character budget)\n${left.map((l) => `- ${l}`).join('\n')}`] : []),
    ].join('\n\n');
  },
};

// ---- Write files ----

export interface ParsedFiles {
  files: { path: string; content: string }[];
  remove: string[];
}

/**
 * The files in a model's answer: JSON {"files": [{"path", "content"}], "delete": [...]}, or fenced blocks with a
 * path (```html path=pages/about.html). The closing fence must be on its own line, so files may hold ``` too.
 */
export function parseFiles(text: string): ParsedFiles {
  try {
    const j = parseJson(text) as { files?: unknown; delete?: unknown };
    if (j && typeof j === 'object' && (Array.isArray(j.files) || Array.isArray(j.delete))) {
      const files = (Array.isArray(j.files) ? j.files : [])
        .filter((f): f is { path: string; content: unknown } => !!f && typeof (f as { path?: unknown }).path === 'string')
        .map((f) => ({ path: f.path, content: typeof f.content === 'string' ? f.content : JSON.stringify(f.content ?? '', null, 2) }));
      const remove = (Array.isArray(j.delete) ? j.delete : []).filter((p): p is string => typeof p === 'string');
      return { files, remove };
    }
  } catch {}
  const files: { path: string; content: string }[] = [];
  const re = /(^|\n)[ \t]*(`{3,})([\w+#.-]*)[ \t]+(?:path|file|filename)\s*=\s*["']?([^\s"'`]+)["']?[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  for (const m of text.matchAll(re)) files.push({ path: m[4], content: m[5] });
  return { files, remove: [] };
}

/** The one fenced block of an answer (a model that wrote a single file without a path). */
function singleFence(text: string): string | undefined {
  const all = [...text.matchAll(/(^|\n)[ \t]*(`{3,})[\w+#.-]*[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g)];
  return all.length === 1 ? all[0][3] : undefined;
}

/** A planned item wired in ({"path": "…"}), for a single file written without a path. */
function plannedPath(ctx: NodeContext): string | undefined {
  for (const i of ctx.inputs) {
    try {
      const j = parseJson(i.text) as { path?: unknown };
      if (j && typeof j.path === 'string') return j.path;
    } catch {}
  }
}

export function changesText(changes: FileChange[]): string {
  if (!changes.length) return 'No files changed.';
  return changes.map((c) => `- ${c.status} ${c.path}${c.status === 'added' || c.status === 'changed' ? ` (+${c.added} −${c.removed})` : ''}`).join('\n');
}

const WRITE_FILES: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    const svc = needProjects(ctx);
    const p = projectOf(ctx);
    // Each answer wired in on its own (a For each item wired in too is only used for its path).
    const prev = answers(ctx.inputs).filter((i) => i.type !== 'foreach');
    const texts = prev.length ? prev.map((x) => x.text) : [ctx.question];
    const parsed: ParsedFiles = { files: [], remove: [] };
    for (const t of texts) {
      const one = parseFiles(t);
      parsed.files.push(...one.files);
      parsed.remove.push(...one.remove);
    }
    if (!parsed.files.length && !parsed.remove.length) {
      const single = singleFence(texts[texts.length - 1]);
      const path = plannedPath(ctx);
      if (single !== undefined && path) parsed.files.push({ path, content: single });
    }
    if (!parsed.files.length && !parsed.remove.length) {
      if (ctx.node.config.optionalWrite) {
        ctx.progress('Nothing to write');
        return texts.join('\n\n');
      }
      throw err('No files found in the answer: write each file as ```html path=folder/name.html … ``` or as JSON {"files": [{"path", "content"}]}');
    }
    const mode = ctx.node.config.writeMode === 'new' || ctx.node.config.writeMode === 'ask' ? 'new' : 'overwrite';
    const changes: FileChange[] = [];
    const problems: string[] = [];
    for (const f of parsed.files) {
      try {
        changes.push(svc.write(p.id, f.path, f.content.endsWith('\n') ? f.content : `${f.content}\n`, mode));
      } catch (e) {
        problems.push(`${f.path}: ${(e as Error).message}`);
      }
    }
    for (const path of parsed.remove) {
      try {
        changes.push(...svc.remove(p.id, path));
      } catch (e) {
        problems.push(`${path}: ${(e as Error).message}`);
      }
    }
    if (!changes.length && problems.length) throw err(problems.join('\n'));
    svc.record(p.id, changes);
    const real = changes.filter((c) => c.status !== 'skipped');
    ctx.progress(`${real.length} file${real.length === 1 ? '' : 's'} changed in ${p.name}${problems.length ? `, ${problems.length} refused` : ''}`);
    return `Changed in ${p.name}:\n${changesText(changes)}${problems.length ? `\n\nRefused:\n${problems.map((x) => `- ${x}`).join('\n')}` : ''}`;
  },
};

// ---- Update notes (PROJECT.md) ----

const NOTES_MAX = 8000;
const NOTES_SYSTEM =
  'You keep PROJECT.md, the notes of a website project, so that the next person (or AI) knows the earlier choices. ' +
  'Sections: "# <name>", "## What it is", "## Style" (colours, fonts, tone, layout rules), "## Pages" (one line each), ' +
  '"## Decisions" (newest first, each "- YYYY-MM-DD: …"). Keep what is still true, add what was decided now, drop what is outdated. ' +
  `Stay under ${NOTES_MAX} characters. Reply with only the full new PROJECT.md, no code fences.`;

const UPDATE_NOTES: NodeDefinition = {
  usesModel: true,
  async execute(ctx) {
    const svc = needProjects(ctx);
    const p = projectOf(ctx);
    const current = svc.read(p.id, 'PROJECT.md') ?? '';
    const done = labelled(answers(ctx.inputs)) || '(nothing wired in)';
    const today = new Date().toISOString().slice(0, 10);
    const user =
      `Project: ${p.name}\nToday: ${today}\n\nWhat was asked:\n${ctx.question}\n\nWhat was done:\n${done.slice(0, 40_000)}\n\n` +
      `Current PROJECT.md:\n${current || '(empty: write it from scratch)'}`;
    let notes = (await ctx.callModel([
      { role: 'system', content: ctx.node.config.system ? fill(ctx.node.config.system, ctx) : NOTES_SYSTEM },
      { role: 'user', content: user },
    ])).trim();
    notes = notes.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1').trim();
    if (!notes) throw err('The model wrote empty notes');
    if (notes.length > NOTES_MAX) notes = `${notes.slice(0, NOTES_MAX)}\n`;
    const change = svc.write(p.id, 'PROJECT.md', `${notes}\n`, 'overwrite');
    svc.record(p.id, [change]);
    ctx.progress(`PROJECT.md updated (${notes.length} characters)`);
    return notes;
  },
};

// ---- Git ----

const GIT: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    const svc = needProjects(ctx);
    const p = projectOf(ctx);
    const action = ctx.node.config.gitAction ?? 'commitPush';
    const pass = inputText(ctx);
    if (!p.repo) {
      // Workflows like the Site builder push only when the project is connected: otherwise this block passes.
      ctx.progress(`${p.name} is not connected to GitHub — nothing to ${action === 'pull' ? 'pull' : 'push'}`);
      return `${pass}\n\n(Git: ${p.name} is not connected to GitHub, skipped.)`;
    }
    const message = fill(ctx.node.config.message?.trim() || '{{question}}', ctx, labelled(answers(ctx.inputs))).trim().slice(0, 2000) || 'Update from HiveMind';
    const changes = svc.changes();
    const body = `${message}\n\nMade by a HiveMind workflow.\n\n${changesText(changes)}`;
    ctx.progress(`git ${action === 'commitPush' ? 'commit + push' : action}…`);
    const r = await svc.git(p.id, action, { message, body, branch: ctx.node.config.branch ? fill(ctx.node.config.branch, ctx).trim() : undefined, signal: ctx.signal });
    ctx.progress(r.text);
    return `${r.text}${r.url ? `\n${r.url}` : ''}`;
  },
};

// ---- Build ----

const BUILD: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    const svc = needProjects(ctx);
    const p = projectOf(ctx);
    ctx.progress(`Building ${p.name}…`);
    let last = 0;
    const r = await svc.build(p.id, {
      script: ctx.node.config.script,
      outDir: ctx.node.config.outDir,
      signal: ctx.signal,
      onLog: (t) => {
        // A line now and then on the block, not every byte.
        if (Date.now() - last < 1500) return;
        last = Date.now();
        const line = t.trim().split('\n').pop()?.slice(0, 120);
        if (line) ctx.progress(line);
      },
    });
    const tail = r.log.split('\n').slice(-40).join('\n');
    if (!r.ok) throw err(`Build failed:\n${tail}`);
    ctx.progress(`Built in ${Math.round(r.ms / 1000)} s → ${r.outDir}/`);
    return `Build OK in ${Math.round(r.ms / 1000)} s. Output: ${r.outDir}/\nPreview: ${svc.previewUrl(p.id, `${r.outDir}/index.html`)}\n\n${tail}`;
  },
};

// ---- Pause ----

/** A wire out of a Pause block to a block named "rejected…" (or "reject…") is the Reject branch. */
export const isRejectBranch = (label: string) => /^\s*reject/i.test(label);

const PAUSE: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    if (!ctx.services.pause) throw err('Pause is not available here (the run has nobody to ask)');
    const input = inputText(ctx);
    const c = ctx.node.config;
    let projectId: string | undefined;
    let previewUrl: string | undefined;
    if (ctx.services.projects && (c.project?.trim() || ctx.vars.project)) {
      try {
        const p = projectOf(ctx);
        projectId = p.id;
        const tree = ctx.services.projects.tree(p.id);
        const page = ['index.html', 'dist/index.html', 'build/index.html'].find((x) => tree.some((f) => f.path === x));
        previewUrl = ctx.services.projects.previewUrl(p.id, page ?? '');
      } catch {}
    }
    const minutes = c.timeoutMinutes && c.timeoutMinutes > 0 ? Math.min(7 * 24 * 60, c.timeoutMinutes) : undefined;
    const info: PauseInfo = {
      nodeId: ctx.node.id,
      title: fill(c.title?.trim() || ctx.node.label || 'Check and continue', ctx).slice(0, 200),
      ...(c.prompt?.trim() && { message: fill(c.prompt, ctx, labelled(answers(ctx.inputs))).slice(0, 5000) }),
      input: input.slice(0, 200_000),
      ...(ctx.services.projects && { changes: ctx.services.projects.changes() }),
      ...(projectId && { projectId }),
      ...(previewUrl && { previewUrl }),
      ...(minutes && { timeoutAt: Date.now() + minutes * 60_000, onTimeout: c.onTimeout ?? 'continue' }),
    };
    ctx.progress('Waiting for you…');
    const r = await ctx.services.pause.wait(info, ctx.signal);
    const rejectIds = ctx.outgoing.filter((o) => isRejectBranch(o.label)).map((o) => o.id);
    const goOn = ctx.outgoing.filter((o) => !isRejectBranch(o.label)).map((o) => o.id);
    if (r.action === 'reject') {
      const why = r.comment?.trim() || 'No reason given';
      if (!rejectIds.length) throw err(`Rejected: ${why}`);
      ctx.choose(rejectIds);
      ctx.progress(`Rejected: ${why.slice(0, 100)}`);
      return `Rejected by the reviewer: ${why}\n\nWhat was rejected:\n${input}`;
    }
    if (r.action === 'stop') throw err('Stopped');
    ctx.choose(goOn);
    ctx.progress(r.text !== undefined && r.text !== input ? 'Continued with your edits' : 'Continued');
    return r.text ?? input;
  },
};

// ---- For each … Collect (the engine runs the blocks between them once per item) ----

/** The items of a list: a JSON array, an object with an array (files, items, plan, list), else one per line. */
export function listItems(text: string): string[] {
  try {
    const j = parseJson(text) as unknown;
    const arr = Array.isArray(j) ? j : j && typeof j === 'object' ? Object.values(j as Record<string, unknown>).find(Array.isArray) : undefined;
    if (Array.isArray(arr)) return arr.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  } catch {}
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

/** A short name for an item ("about.html" from {"path": "pages/about.html"}). */
export function itemLabel(item: string): string {
  try {
    const j = JSON.parse(item) as Record<string, unknown>;
    const v = j.path ?? j.name ?? j.title ?? j.file;
    if (typeof v === 'string') return v.slice(0, 80);
  } catch {}
  return item.slice(0, 60);
}

const FOREACH: NodeDefinition = {
  usesModel: false,
  // The engine runs For each itself (runGraph → runLoop); this only gives the items.
  async execute(ctx) {
    return listItems(inputText(ctx)).join('\n');
  },
};

const COLLECT: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    return labelled(answers(ctx.inputs));
  },
};

export const PROJECT_NODES: Record<'readProject' | 'writeFiles' | 'updateNotes' | 'git' | 'build' | 'pause' | 'foreach' | 'collect', NodeDefinition> = {
  readProject: READ_PROJECT,
  writeFiles: WRITE_FILES,
  updateNotes: UPDATE_NOTES,
  git: GIT,
  build: BUILD,
  pause: PAUSE,
  foreach: FOREACH,
  collect: COLLECT,
};
