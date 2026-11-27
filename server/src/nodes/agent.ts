// H21: the Agent block — a character that uses tools in turns. The model answers with one JSON step at a time:
// {"tool": "...", "input": {...}} or {"answer": "..."}; HiveMind runs the tool (through the same blocks a workflow
// uses), shows the step on the run, and gives the result back, until it answers or runs out of steps or time.
import type { NodeType } from '@hivemind/shared';
import type { ChatMessage } from '../providers/types.js';
import type { NodeContext, NodeDefinition, NodeInput } from './index.js';
import { fill, NODES } from './index.js';

export const AGENT_TOOLS = ['readMemory', 'writeMemory', 'search', 'listProjects', 'createProject', 'readProject', 'writeFiles', 'shell', 'browser', 'workflow', 'runWorkflow', 'askCharacter', 'sayNow', 'pause'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** How each tool is called: what goes in "input", for the model. */
const TOOL_HELP: Record<AgentTool, string> = {
  readMemory: '{"paths": ["topics/food.md"], "index": true} — read memory files (index: also the list of all files)',
  writeMemory: '{"path": "topics/food.md", "text": "...", "mode": "replace" | "append"} — write a memory file',
  search: '{"query": "...", "read": 2} — search the web (DuckDuckGo); read = also read the best 1-3 pages',
  listProjects: '{} — the existing projects (name, last change), newest first: use it to find the one the owner means',
  createProject: '{"name": "JB Clicker"} — make a new project with that name (an existing one with the same name is returned); then write its files with writeFiles',
  readProject: '{"project": "name or id", "globs": "*.html, *.js"} — read a project\'s files',
  writeFiles: '{"project": "name or id", "path": "index.html"} followed by the whole file in a ``` code block after the JSON (one file per step) — or {"project", "files": [{"path", "content"}]} for small files',
  shell: '{"commands": "...", "project": "name (optional)", "shell": "bash" | "pwsh"} — run commands in a sandbox (go, dotnet, node, python, wine)',
  browser: '{"steps": "goto /index.html\\nclick Shop\\neval document.querySelector(\'#score\').textContent\\ntext #score\\nscreenshot\\nconsole", "project": "name (optional)"} or {"test": true, "project": "name"} — a headless browser. "eval <js>" returns a value; "text <selector>" returns one element\'s text.',
  workflow: '{"op": "list" | "create" | "update" | "run" | "delete", "id": "hivebot-ws-<you>-1", "graph": {...}, "question": "..."} — your own workflows',
  runWorkflow: '{"canvas": "id or name", "question": "..."} — start another workflow as a background job',
  askCharacter: '{"character": "jarvis", "question": "..."} — ask a teammate one question and get the answer',
  sayNow: '{"text": "..."} — tell the owner something right away (a progress line)',
  pause: '{"question": "..."} — ask the owner and wait (do this before paying, ordering, sending or pushing to GitHub)',
};

/** The model's step: a tool call or the answer. */
/** The first complete JSON object in a text (strings and escapes respected), or undefined. */
export function firstJsonObject(t: string): { json: string; end: number } | undefined {
  for (let start = t.indexOf('{'); start >= 0; start = t.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') {
        // A model that forgot the last "}" of a step: a new step starts at depth 1 ("}{\"tool\"").
        if (depth === 1 && i > start && /^\{\s*"(tool|answer)"/.test(t.slice(i, i + 12))) {
          const json = `${t.slice(start, i)}}`;
          try {
            JSON.parse(json);
            return { json, end: i };
          } catch {
            break;
          }
        }
        depth++;
      } else if (c === '}' && --depth === 0) {
        const json = t.slice(start, i + 1);
        try {
          JSON.parse(json);
          return { json, end: i + 1 };
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * The model's step: a tool call or the answer. A file may come as a code block after the JSON (big HTML with CSS
 * braces breaks inside JSON): {"tool": "writeFiles", "input": {"project": "x", "path": "index.html"}} then ```html…```.
 */
export function parseStep(reply: string): { tool: string; input: Record<string, unknown> } | { answer: string } | undefined {
  const t = reply.trim();
  const fencedJson = /```json[^\n]*\n([\s\S]*?)```/.exec(t)?.[1];
  const found = fencedJson ? { json: fencedJson, end: t.indexOf(fencedJson) + fencedJson.length } : firstJsonObject(t);
  if (!found) return undefined;
  let j: { tool?: unknown; input?: unknown; answer?: unknown };
  try {
    j = JSON.parse(found.json);
  } catch {
    return undefined;
  }
  if (typeof j.answer === 'string') return { answer: j.answer };
  if (typeof j.tool !== 'string') return undefined;
  const input = j.input && typeof j.input === 'object' ? { ...(j.input as Record<string, unknown>) } : {};
  // A code block after the JSON is the file's content (writeFiles with "path" and no "files").
  const after = t.slice(found.end);
  const block = /```[\w+#.-]*[^\n]*\n([\s\S]*?)\n```/.exec(after)?.[1];
  if (block !== undefined && j.tool === 'writeFiles' && !Array.isArray(input.files)) {
    input.files = [{ path: typeof input.path === 'string' && input.path ? input.path : 'index.html', content: block }];
  }
  // {"path", "content"} without "files": one file.
  if (j.tool === 'writeFiles' && !Array.isArray(input.files) && typeof input.content === 'string') {
    input.files = [{ path: typeof input.path === 'string' && input.path ? input.path : 'index.html', content: input.content }];
  }
  return { tool: j.tool, input };
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** Runs one block as a tool: the agent's run context, with this block's config and the text as its input. */
async function asBlock(ctx: NodeContext, type: NodeType, config: Record<string, unknown>, text: string, n: number, fromType: NodeType = 'llm'): Promise<string> {
  const def = NODES[type];
  // fromType 'pause': the owner approved in this run (the Browser block then may press pay/order buttons).
  const input: NodeInput[] = text || fromType === 'pause' ? [{ nodeId: `${ctx.node.id}~in`, type: fromType, label: 'agent', text }] : [];
  const sub: NodeContext = {
    ...ctx,
    node: { ...ctx.node, id: `${ctx.node.id}~${n}`, type, config: { ...config } as NodeContext['node']['config'] },
    inputs: input,
    outgoing: [],
    choose: () => {},
    progress: (note) => ctx.progress(`step ${n} · ${type}: ${note}`.slice(0, 200)),
  };
  return def.execute(sub);
}

export const AGENT_NODE: NodeDefinition = {
  usesModel: true,
  check: (c) => (c.maxSteps !== undefined && (c.maxSteps < 1 || c.maxSteps > 50) ? 'Agent: 1–50 steps' : undefined),
  async execute(ctx) {
    const c = ctx.node.config;
    const allowed = (c.agentTools?.length ? c.agentTools : ['readMemory', 'search', 'sayNow']).filter((t): t is AgentTool => (AGENT_TOOLS as readonly string[]).includes(t));
    const maxSteps = Math.min(50, Math.max(1, c.maxSteps ?? 12));
    const deadline = Date.now() + Math.min(240, Math.max(1, c.maxMinutes ?? 20)) * 60_000;
    const input = ctx.inputs.map((i) => i.text).join('\n\n');
    const task = (c.prompt?.trim() ? fill(c.prompt, ctx, input) : input || ctx.question).trim();
    const who = ctx.vars.character ? `You are ${ctx.vars.character}. ` : '';
    const system = [
      `${who}${c.system?.trim() ? fill(c.system, ctx, input) : 'You get a task and do it yourself with tools, one step at a time.'}`,
      'Each reply is ONLY one JSON object, nothing else (only writeFiles may add the file in one ``` code block after its JSON):',
      '  {"tool": "<name>", "input": {...}}  to use a tool (you get its result back), or',
      '  {"answer": "<text>"}  when the task is done (or cannot be done: say why).',
      'Tools:',
      ...allowed.map((t) => `- ${t}: ${TOOL_HELP[t]}`),
      `You have at most ${maxSteps} steps. Check your work (run it, open it, read it back) before you answer.`,
      'Never say something is done unless a tool result said so: a failed or missing writeFiles means the site is NOT ready.',
      'Never pay, order, send messages or push to GitHub without a pause step the owner approved, unless the task says so.',
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];
    let approved = false;
    const log: string[] = [];
    // Context: every step adds the model's reply (whole files for writeFiles) and the tool's result. On a big project that
    // is more than the model's context, and the model then loses the start: the owner's task and these rules (HiveBot,
    // 2026-11-19: "it fails to listen to me"). So when the conversation nears ~70% of the context, the older steps are
    // replaced by one short line each (the log); the task, the rules and the last steps stay whole. Files and memory are
    // saved, so the agent can read them again.
    const budget = Math.floor((c.numCtx ?? 32_768) * 3 * 0.7); // ~3 characters per token
    const size = () => messages.reduce((a, m) => a + String(m.content ?? '').length, 0);
    const compact = () => {
      if (size() <= budget || messages.length <= 6) return;
      const head = messages.slice(0, 2);
      const tail = messages.slice(-4);
      const done = log.slice(0, Math.max(0, log.length - 2));
      messages.splice(0, messages.length, ...head, {
        role: 'user',
        content: `Earlier steps, shortened to fit your memory (what you wrote is saved: read files or memory again when you need the details):\n${done.join('\n')}`,
      }, ...tail);
      // still too big (huge files in the last steps): cut the long ones
      for (const m of messages.slice(3)) if (size() > budget && String(m.content).length > 6000) m.content = `${String(m.content).slice(0, 6000)}\n…(cut to fit)`;
      ctx.progress(`memory compressed: ${done.length} earlier steps shortened`);
    };
    let lastKey = '';
    let repeats = 0;
    for (let n = 1; n <= maxSteps; n++) {
      if (ctx.signal?.aborted) throw new Error('Cancelled');
      if (Date.now() > deadline) {
        log.push(`(stopped: the ${c.maxMinutes ?? 20} minutes were up)`);
        break;
      }
      compact();
      const reply = await ctx.callModel(messages);
      const step = parseStep(reply);
      messages.push({ role: 'assistant', content: reply });
      if (!step) {
        messages.push({ role: 'user', content: 'That was not one JSON object. Reply with {"tool": ..., "input": {...}} or {"answer": "..."} only.' });
        ctx.progress(`step ${n}: not JSON, asked again`);
        continue;
      }
      if ('answer' in step) {
        ctx.progress(`done after ${n - 1} tool step${n === 2 ? '' : 's'}`);
        return c.agentLog ? `${step.answer}\n\n---\nSteps:\n${log.join('\n')}` : step.answer;
      }
      const tool = step.tool as AgentTool;
      const i = step.input;
      let result: string;
      // The same call three times in a row: tell the model to use what it has (H29).
      const key = `${tool} ${JSON.stringify(i)}`;
      repeats = key === lastKey ? repeats + 1 : 1;
      lastKey = key;
      if (repeats >= 3) {
        messages.push({ role: 'user', content: `You already did exactly this (${tool}) ${repeats - 1} times and got the same result. Do not repeat it: use what you have, try something different, or answer.` });
        ctx.progress(`step ${n}: same ${tool} again, told to move on`);
        continue;
      }
      ctx.progress(`step ${n}: ${tool} ${str(i).slice(0, 120)}`);
      try {
        if (!allowed.includes(tool)) throw new Error(`"${tool}" is not one of your tools (${allowed.join(', ')})`);
        switch (tool) {
          case 'readMemory':
            result = await asBlock(ctx, 'readMemory', { memoryPaths: Array.isArray(i.paths) ? i.paths.join('\n') : str(i.paths ?? i.path), memoryIndex: !!i.index }, '', n);
            break;
          case 'writeMemory': {
            // Only the files the block allows (e.g. the Prompt coach never touches the history it reads).
            const only = (c.agentWritePaths ?? '').split(/\r?\n|,/).map((x) => x.trim().replace(/^\/+/, '')).filter(Boolean);
            if (only.length) {
              const path = str(i.path).trim().replace(/^\/+/, '');
              if (!only.some((o) => (o.endsWith('/') ? path.startsWith(o) : path === o))) throw new Error(`You may only write: ${only.join(', ')}`);
              // Moves and deletes go by JSON in the text: not with a list of allowed files.
              if (/^\s*\{[\s\S]*"(from|to|delete)"\s*:/.test(str(i.text))) throw new Error('Moving or deleting files is not allowed here; write the whole text');
            }
            result = await asBlock(ctx, 'writeMemory', { memoryPath: str(i.path), memoryMode: i.mode === 'append' ? 'append' : 'replace', memoryBy: ctx.vars.character || 'agent' }, str(i.text), n);
            break;
          }
          case 'search':
            // The web, not Wikipedia (H29): DuckDuckGo unless the model names a source; optionally read the best pages.
            result = await asBlock(ctx, 'search', { source: typeof i.source === 'string' && i.source ? i.source : 'duckduckgo', ...(i.read !== undefined && { readPages: Math.max(0, Math.min(3, Number(i.read) || 0)) }) }, str(i.query), n);
            break;
          case 'listProjects': {
            const svc = ctx.services.projects;
            if (!svc?.list) throw new Error('Listing projects is not available here');
            const ps = svc.list();
            result = ps.length ? ps.map((p) => `- ${p.name} (changed ${p.updated})`).join('\n') : '(no projects yet)';
            break;
          }
          case 'createProject': {
            // H27 (owner, 2026-11-19: a project is made the moment he asks, no confirm)
            const svc = ctx.services.projects;
            if (!svc?.create) throw new Error('Making projects is not available here');
            const name = str(i.name).trim();
            if (!name) throw new Error('createProject needs "name"');
            const p = svc.create(name);
            result = p.existed
              ? `A project "${p.name}" already exists (id ${p.id}): use it.`
              : `Made the new project "${p.name}" (id ${p.id}). Write its files with writeFiles {"project": "${p.name}", ...}.`;
            break;
          }
          case 'readProject':
            result = await asBlock(ctx, 'readProject', { project: str(i.project), ...(i.globs !== undefined && { globs: str(i.globs) }) }, '', n);
            break;
          case 'writeFiles': {
            result = await asBlock(ctx, 'writeFiles', { project: str(i.project) }, JSON.stringify({ files: Array.isArray(i.files) ? i.files : [] }), n);
            break;
          }
          case 'shell':
            result = await asBlock(ctx, 'shell', { commands: str(i.commands), ...(i.project !== undefined && { project: str(i.project) }), shellKind: i.shell === 'pwsh' ? 'pwsh' : 'bash' }, '', n);
            break;
          case 'browser':
            result = await asBlock(
              ctx,
              'browser',
              { commands: str(i.steps), browserTest: !!i.test, internet: !!c.agentInternet, ...(i.project !== undefined && { project: str(i.project) }) },
              '',
              n,
              approved ? 'pause' : 'llm',
            );
            break;
          case 'workflow':
            result = await asBlock(
              ctx,
              'workflow',
              { wfOp: str(i.op) || 'list', ...(i.id !== undefined && { canvas: str(i.id) }), ...(i.question !== undefined && { prompt: str(i.question) }) },
              i.graph ? JSON.stringify({ graph: i.graph }) : '',
              n,
            );
            break;
          case 'runWorkflow':
            result = await asBlock(ctx, 'runWorkflow', { canvas: str(i.canvas), prompt: str(i.question) }, '', n);
            break;
          case 'askCharacter': {
            if (!ctx.services.askCanvas) throw new Error('Asking a teammate is not available here');
            const mate = str(i.character).trim().toLowerCase();
            if (!mate) throw new Error('askCharacter needs "character"');
            result = await ctx.services.askCanvas({ canvas: c.agentAskCanvas?.trim() || 'hivebot', question: str(i.question), vars: { ...ctx.vars, character: mate, from: ctx.vars.character ?? 'agent' }, signal: ctx.signal });
            break;
          }
          case 'sayNow':
            ctx.say?.(str(i.text));
            result = 'Said.';
            break;
          case 'pause': {
            if (!ctx.services.pause) throw new Error('Asking the owner is not available here');
            const r = await ctx.services.pause.wait({ nodeId: ctx.node.id, title: `${ctx.vars.character ?? 'Agent'} asks`, message: str(i.question), input: log.join('\n').slice(-20_000) }, ctx.signal);
            if (r.action === 'stop') throw new Error('Stopped');
            approved = r.action !== 'reject';
            result = r.action === 'reject' ? `The owner said no${r.comment ? `: ${r.comment}` : ''}` : `The owner said yes${r.text ? `: ${r.text}` : ''}${r.comment ? ` (${r.comment})` : ''}`;
            break;
          }
          default:
            throw new Error(`Unknown tool "${tool}"`);
        }
      } catch (e) {
        if ((e as Error).message === 'Cancelled' || (e as Error).message === 'Stopped') throw e;
        result = `ERROR: ${(e as Error).message}`;
        // A project that isn't found: show the ones that exist, so "doc counter" (misheard) finds "Dog Clicker" instead of
        // a new project being made (HiveBot, 2026-11-19).
        if (/Project ".*" not found/.test(result) && ctx.services.projects?.list) {
          const names = ctx.services.projects.list().slice(0, 15).map((p) => p.name);
          if (names.length) result += `\nExisting projects (newest first): ${names.join(', ')}. If the owner means one of these (speech to text mishears names), use that one; only make a new project when he asked for a new one.`;
        }
      }
      const short = result.length > 12_000 ? `${result.slice(0, 12_000)}\n…(cut)` : result;
      log.push(`${n}. ${tool} ${str(i).slice(0, 200)} → ${result.replace(/\s+/g, ' ').slice(0, 200)}`);
      messages.push({ role: 'user', content: `Result of ${tool}:\n${short}\n\nNext step (one JSON object).` });
    }
    // Out of steps: ask for the best answer it has.
    messages.push({ role: 'user', content: 'No steps left. Reply now with {"answer": "..."}: what you did and what is left.' });
    const last = parseStep(await ctx.callModel(messages));
    ctx.progress(`stopped after ${maxSteps} steps`);
    const answer = last && 'answer' in last ? last.answer : `Stopped after ${maxSteps} steps without a final answer.`;
    return c.agentLog ? `${answer}\n\n---\nSteps:\n${log.join('\n')}` : answer;
  },
};
