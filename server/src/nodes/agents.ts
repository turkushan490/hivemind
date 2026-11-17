// HiveBot round 5: blocks that let the characters act — run commands (shell, H18), use a browser (H19).
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

const inputOf = (ctx: Parameters<NodeDefinition['execute']>[0]) => ctx.inputs.map((i) => i.text).join('\n');

/** Commands from a model often come in a ```bash block: take its contents. */
export function commandsFrom(text: string): string {
  const m = /```(?:bash|sh|shell|pwsh|powershell|ps1)?[^\n]*\n([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

export const AGENT_NODES: Record<'shell' | 'browser', NodeDefinition> = {
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
      const { parseSteps } = await import('../services/browser.js');
      // The steps: the block's own ({{inputs}} filled), else the list the block before wrote (a numbered list is fine).
      let steps = parseSteps(commandsFrom(c.commands?.trim() ? fill(c.commands, ctx, input) : input));
      // Test mode on a project: open its preview and test every page.
      if (c.browserTest) {
        const project = projectOf(ctx);
        steps = [{ op: 'test', arg: ctx.services.projects!.previewUrl(project.id) }];
      } else if (c.project?.trim() || ctx.vars.project) {
        // "goto /about.html" on a project goes to its preview.
        const project = projectOf(ctx);
        const base = ctx.services.projects!.previewUrl(project.id);
        steps = steps.map((st) => (st.op === 'goto' && st.arg.startsWith('/') && !st.arg.startsWith('/api/') ? { ...st, arg: `${base}${st.arg.slice(1)}` } : st));
      }
      if (!steps.length) throw new Error('Browser: no steps (goto, click, type, wait, screenshot, text, console, links — or switch on the test mode)');
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
    },
  },
};
