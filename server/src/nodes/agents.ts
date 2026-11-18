// HiveBot round 5: blocks that let the characters act — run commands (shell, H18), use a browser (H19), make their own workflows (H20).
import type { NodeDefinition } from './index.js';
import { fill } from './index.js';
import { projectOf } from './projects.js';

/** What the sandbox service does for the Shell block (services/sandbox.ts). */
export interface SandboxServices {
  run(o: {
    key: string;
    project?: { id: string };
    shell: 'bash' | 'pwsh';
    commands: string;
    timeoutSec?: number;
    network?: boolean;
    keepFiles?: boolean;
    signal?: AbortSignal;
    onLog?: (text: string) => void;
  }): Promise<{ exitCode: number | 'timeout' | 'cancelled'; output: string; ms: number; copied?: string[] }>;
}

/** What the browser service does for the Browser block (services/browser.ts). */
export interface BrowserServices {
  run(
    steps: { op: string; arg: string }[],
    o: { allowRisky?: boolean; internet?: boolean; timeoutMs?: number; signal?: AbortSignal; onStep?: (note: string) => void },
  ): Promise<{ text: string; screenshots: { name: string; data: Buffer }[] }>;
}

/** H20: a character's own workflows (services/workspaces.ts), checked by HiveMind. */
export interface WorkspaceServices {
  list(character: string): { id: string; name: string; updatedAt: string; ttlDays: number; lastRun?: { at: string; status: string }; sizeBytes: number }[];
  save(character: string, o: { id: string; name?: string; graphText: string; ttlDays?: number; create: boolean }): { ok: true; id: string } | { ok: false; problems: string[] };
  remove(character: string, id: string): boolean;
  run(character: string, id: string, question: string, o: { timeoutSec: number; signal?: AbortSignal }): Promise<string>;
}

const inputOf = (ctx: Parameters<NodeDefinition['execute']>[0]) => ctx.inputs.map((i) => i.text).join('\n');

/** Commands from a model often come in a ```bash block: take its contents. */
export function commandsFrom(text: string): string {
  const m = /```(?:bash|sh|shell|pwsh|powershell|ps1)?[^\n]*\n([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

export const AGENT_NODES: Record<'shell' | 'browser' | 'workflow', NodeDefinition> = {
  shell: {
    usesModel: false,
    check: (c) => (c.timeoutSec !== undefined && (c.timeoutSec < 5 || c.timeoutSec > 3600) ? 'Shell: the time limit is 5–3600 seconds' : undefined),
    async execute(ctx) {
      const svc = ctx.services.sandbox;
      if (!svc) throw new Error('The Shell block is only for admins and HiveBot workflows on this HiveMind');
      const c = ctx.node.config;
      const input = inputOf(ctx);
      // The commands: the block's own (with {{inputs}} filled), else what the block before wrote (a ```bash block).
      const commands = commandsFrom(c.commands?.trim() ? fill(c.commands, ctx, input) : input);
      if (!commands) throw new Error('Shell: no commands (write them in the block, or let the block before write them)');
      const project = c.project?.trim() || ctx.vars.project ? projectOf(ctx) : undefined;
      const shell = c.shellKind === 'pwsh' ? 'pwsh' : 'bash';
      ctx.progress(`Running ${shell}${project ? ` in ${project.name}` : ''}…`);
      let lastNote = 0;
      const r = await svc.run({
        key: project ? `project-${project.id}` : `node-${ctx.node.id}`,
        ...(project && { project }),
        shell,
        commands,
        timeoutSec: c.timeoutSec ?? 120,
        network: c.network !== false,
        keepFiles: !!c.keepFiles || !!project,
        signal: ctx.signal,
        onLog: (t) => {
          // A short live line on the block, at most twice a second.
          if (Date.now() - lastNote < 500) return;
          lastNote = Date.now();
          const line = t.trim().split('\n').pop();
          if (line) ctx.progress(line.slice(0, 120));
        },
      });
      const status = r.exitCode === 0 ? 'exit code 0' : r.exitCode === 'timeout' ? `stopped after ${c.timeoutSec ?? 120} s` : r.exitCode === 'cancelled' ? 'cancelled' : `exit code ${r.exitCode}`;
      ctx.progress(`${status} · ${(r.ms / 1000).toFixed(1)} s${r.copied?.length ? ` · copied ${r.copied.join(', ')} into the project` : ''}`);
      if (r.exitCode === 'cancelled') throw new Error('Cancelled');
      if (c.failOnError && r.exitCode !== 0) throw new Error(`The commands failed (${status}):\n${r.output.slice(-2000)}`);
      return `$ ${shell} (${status}, ${(r.ms / 1000).toFixed(1)} s)\n${r.output.trim() || '(no output)'}${r.copied?.length ? `\n\nCopied into the project: ${r.copied.map((d) => `${d}/`).join(', ')}` : ''}`;
    },
  },
  browser: {
    usesModel: false,
    async execute(ctx) {
      const svc = ctx.services.browser;
      if (!svc) throw new Error('The Browser block is not available here (it is in the HiveMind Docker image)');
      const c = ctx.node.config;
      const input = inputOf(ctx);
      const { parseSteps, serveDir } = await import('../services/browser.js');
      // The steps: the block's own ({{inputs}} filled), else the list the block before wrote (a numbered list is fine).
      let steps = parseSteps(commandsFrom(c.commands?.trim() ? fill(c.commands, ctx, input) : input));
      // A project is served to the headless browser from a throwaway localhost server (not the sandboxed preview), so its
      // own JavaScript (localStorage, etc.) works in the test (round 5 fix 2). Closed in the finally below.
      let served: { url: string; close: () => void } | undefined;
      if (c.browserTest || c.project?.trim() || ctx.vars.project) {
        const project = projectOf(ctx);
        const { rootOf } = await import('../services/projects.js');
        served = await serveDir(rootOf(project));
      }
      try {
        if (c.browserTest && served) {
          steps = [{ op: 'test', arg: served.url }];
        } else if (served) {
          // "goto /about.html" on a project goes to its local static server.
          steps = steps.map((st) => (st.op === 'goto' && st.arg.startsWith('/') && !st.arg.startsWith('/api/') ? { ...st, arg: `${served!.url}${st.arg.slice(1)}` } : st));
        }
        if (!steps.length) throw new Error('Browser: no steps (goto, click, type, wait, screenshot, text, eval, console, links — or switch on the test mode)');
        // A Pause right before this block that the owner approved allows pay / order buttons in this run.
        const allowRisky = ctx.inputs.some((i) => i.type === 'pause');
        const r = await svc.run(steps, { allowRisky, internet: !!c.internet, timeoutMs: (c.timeoutSec ?? 120) * 1000, signal: ctx.signal, onStep: (n) => ctx.progress(n) });
        const files: string[] = [];
        for (const sh of r.screenshots) {
          if (!ctx.services.saveFile) break;
          const f = ctx.services.saveFile(`outputs/browser-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${sh.name.replace(/[^a-z0-9-]+/gi, '-').slice(0, 30)}.png`, sh.data);
          ctx.attach(f);
          files.push(`![${sh.name}](hm-file:${f.path})`);
        }
        ctx.progress(`${steps.length} step${steps.length === 1 ? '' : 's'} done${files.length ? ` · ${files.length} screenshot${files.length === 1 ? '' : 's'}` : ''}`);
        return `${r.text}${files.length ? `\n\n${files.join('\n')}` : ''}`;
      } finally {
        served?.close();
      }
    },
  },
  workflow: {
    usesModel: false,
    async execute(ctx) {
      const svc = ctx.services.workspaces;
      if (!svc) throw new Error('The workflow block is for the owner and the HiveBot robot only');
      const c = ctx.node.config;
      const input = inputOf(ctx);
      const character = (c.workspace?.trim() ? fill(c.workspace, ctx, input) : ctx.vars.character ?? '').trim();
      const op = c.wfOp ?? 'list';
      // The id: the block's (filled), else {"id": …} in the input.
      let json: { id?: string; name?: string; question?: string; graph?: unknown; ttlDays?: number } = {};
      try {
        const m = /```(?:json)?[^\n]*\n([\s\S]*?)```/.exec(input);
        const parsed = JSON.parse((m ? m[1] : input).trim()) as unknown;
        if (parsed && typeof parsed === 'object') json = parsed as typeof json;
      } catch {}
      const id = (c.canvas?.trim() ? fill(c.canvas, ctx, input) : json.id ?? '').trim();
      if (op === 'list') {
        const list = svc.list(character);
        ctx.progress(`${list.length} workflow${list.length === 1 ? '' : 's'}`);
        return list.length
          ? list.map((w) => `- ${w.id} "${w.name}" · changed ${w.updatedAt}${w.lastRun ? ` · last run ${w.lastRun.at} (${w.lastRun.status})` : ' · never ran'} · deleted after ${w.ttlDays} days unused`).join('\n')
          : 'No workflows in this workspace yet.';
      }
      if (!id) throw new Error(`workflow (${op}): give the id (on the block, or {"id": "hivebot-ws-<name>-…"} from the block before)`);
      if (op === 'delete') {
        const gone = svc.remove(character, id);
        ctx.progress(gone ? `Deleted ${id}` : `${id} was not there`);
        return gone ? `Deleted ${id}` : `There is no ${id}`;
      }
      if (op === 'run') {
        const question = (c.prompt?.trim() ? fill(c.prompt, ctx, input) : json.question ?? ctx.question).trim();
        ctx.progress(`Running ${id}…`);
        return svc.run(character, id, question, { timeoutSec: c.timeoutSec ?? 300, signal: ctx.signal });
      }
      // create / update: the graph JSON comes from the input (a model wrote it).
      const graphText = json.graph ? JSON.stringify(json.graph) : input;
      const r = svc.save(character, { id, name: json.name, graphText, ttlDays: c.ttlDays ?? json.ttlDays, create: op === 'create' });
      if (!r.ok) {
        ctx.progress(`${r.problems.length} problem${r.problems.length === 1 ? '' : 's'} in the graph`);
        // Back to the model as text, so it can fix its JSON (the run goes on).
        return `NOT SAVED: fix these and send the whole graph again:\n${r.problems.map((p) => `- ${p}`).join('\n')}`;
      }
      ctx.progress(`${op === 'create' ? 'Made' : 'Changed'} ${r.id}`);
      return `${op === 'create' ? 'Made' : 'Changed'} ${r.id}`;
    },
  },
};
