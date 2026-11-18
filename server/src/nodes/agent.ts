// H21: the Agent block — a character that uses tools in turns. The model answers with one JSON step at a time:
// {"tool": "...", "input": {...}} or {"answer": "..."}; HiveMind runs the tool (through the same blocks a workflow
// uses), shows the step on the run, and gives the result back, until it answers or runs out of steps or time.
import type { NodeType } from '@hivemind/shared';
import type { ChatMessage } from '../providers/types.js';
import type { NodeContext, NodeDefinition, NodeInput } from './index.js';
import { fill, NODES } from './index.js';

export const AGENT_TOOLS = ['readMemory', 'writeMemory', 'search', 'readProject', 'writeFiles', 'shell', 'browser', 'workflow', 'runWorkflow', 'askCharacter', 'sayNow', 'pause'] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** How each tool is called: what goes in "input", for the model. */
const TOOL_HELP: Record<AgentTool, string> = {
  readMemory: '{"paths": ["topics/food.md"], "index": true} — read memory files (index: also the list of all files)',
  writeMemory: '{"path": "topics/food.md", "text": "...", "mode": "replace" | "append"} — write a memory file',
  search: '{"query": "..."} — search the web',
  readProject: '{"project": "name or id", "globs": "*.html, *.js"} — read a project\'s files',
  writeFiles: '{"project": "name or id", "files": [{"path": "index.html", "content": "..."}]} — write files into a project',
  shell: '{"commands": "...", "project": "name (optional)", "shell": "bash" | "pwsh"} — run commands in a sandbox (go, dotnet, node, python, wine)',
  browser: '{"steps": "goto /index.html\\nclick Shop\\neval document.querySelector(\'#score\').textContent\\ntext #score\\nscreenshot\\nconsole", "project": "name (optional)"} or {"test": true, "project": "name"} — a headless browser. "eval <js>" returns a value; "text <selector>" returns one element\'s text.',
  workflow: '{"op": "list" | "create" | "update" | "run" | "delete", "id": "hivebot-ws-<you>-1", "graph": {...}, "question": "..."} — your own workflows',
  runWorkflow: '{"canvas": "id or name", "question": "..."} — start another workflow as a background job',
  askCharacter: '{"character": "jarvis", "question": "..."} — ask a teammate one question and get the answer',
  sayNow: '{"text": "..."} — tell the owner something right away (a progress line)',
  pause: '{"question": "..."} — ask the owner and wait (do this before paying, ordering, sending or pushing to GitHub)',
};

/** The model's step: a tool call or the answer. */
export function parseStep(reply: string): { tool: string; input: Record<string, unknown> } | { answer: string } | undefined {
  const t = reply.trim();
  const body = /```(?:json)?[^\n]*\n([\s\S]*?)```/.exec(t)?.[1] ?? t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  try {
    const j = JSON.parse(body) as { tool?: unknown; input?: unknown; answer?: unknown };
    if (typeof j.answer === 'string') return { answer: j.answer };
    if (typeof j.tool === 'string') return { tool: j.tool, input: j.input && typeof j.input === 'object' ? (j.input as Record<string, unknown>) : {} };
  } catch {}
  return undefined;
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
      'Each reply is ONLY one JSON object, nothing else:',
      '  {"tool": "<name>", "input": {...}}  to use a tool (you get its result back), or',
      '  {"answer": "<text>"}  when the task is done (or cannot be done: say why).',
      'Tools:',
      ...allowed.map((t) => `- ${t}: ${TOOL_HELP[t]}`),
      `You have at most ${maxSteps} steps. Check your work (run it, open it, read it back) before you answer.`,
      'Never pay, order, send messages or push to GitHub without a pause step the owner approved, unless the task says so.',
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: task },
    ];
    let approved = false;
    const log: string[] = [];
    for (let n = 1; n <= maxSteps; n++) {
      if (ctx.signal?.aborted) throw new Error('Cancelled');
      if (Date.now() > deadline) {
        log.push(`(stopped: the ${c.maxMinutes ?? 20} minutes were up)`);
        break;
      }
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
      ctx.progress(`step ${n}: ${tool} ${str(i).slice(0, 120)}`);
      try {
        if (!allowed.includes(tool)) throw new Error(`"${tool}" is not one of your tools (${allowed.join(', ')})`);
        switch (tool) {
          case 'readMemory':
            result = await asBlock(ctx, 'readMemory', { memoryPaths: Array.isArray(i.paths) ? i.paths.join('\n') : str(i.paths ?? i.path), memoryIndex: !!i.index }, '', n);
            break;
          case 'writeMemory':
            result = await asBlock(ctx, 'writeMemory', { memoryPath: str(i.path), memoryMode: i.mode === 'append' ? 'append' : 'replace', memoryBy: ctx.vars.character || 'agent' }, str(i.text), n);
            break;
          case 'search':
            result = await asBlock(ctx, 'search', {}, str(i.query), n);
            break;
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
