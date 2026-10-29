import type { DecisionSpec, ModelRef } from '@hivemind/shared';
import { fill, jsonCall, labelled, type NodeContext, type NodeDefinition } from './index.js';

/**
 * Training blocks: build datasets inside workflows (Generate examples, Add to dataset), train on them (Train),
 * compare models (Evaluate) and put the winner to work (Deploy). They use the run's training services, which are
 * only there for users who may train (not viewers or limited API tokens).
 */

const services = (ctx: NodeContext) => {
  const t = ctx.services.training;
  if (!t) throw new Error('Training blocks need a user who may train (viewers and limited API tokens may not)');
  return t;
};

const datasetName = (ctx: NodeContext) => {
  const name = fill(ctx.node.config.dataset ?? '', ctx).trim();
  if (!name) throw new Error('Name the dataset in this block');
  return name;
};

/** What flows in: the last answer wired in (not the bare question). */
const lastText = (ctx: NodeContext) => {
  const prev = ctx.inputs.filter((i) => i.type !== 'input');
  return prev.length ? prev[prev.length - 1].text : '';
};

/** Generate examples for a decision dataset: the block's first question (as in a Decide block) is what is taught. */
function decisionSpec(ctx: NodeContext): DecisionSpec | undefined {
  const q = ctx.node.config.questions?.[0];
  if (ctx.node.config.datasetKind !== 'decision' || !q?.instructions?.trim()) return;
  if (q.type === 'score') return { question: q.instructions, type: 'score', options: q.levels ?? [] };
  if (q.type === 'choice') return { question: q.instructions, type: 'choice', options: Object.fromEntries((q.options ?? []).map((o) => [o.name, o.description ?? ''])) };
  return { question: q.instructions, type: 'noul' };
}

const specKeys = (s: DecisionSpec) =>
  s.type === 'noul' ? ['true', 'false'] : s.type === 'score' ? ((s.options as string[]) ?? []) : Object.keys((s.options as Record<string, string>) ?? {});

const modelName = (m: ModelRef) => m.model.split('/').pop()!.replace(/:latest$/, '');
const BATCH = 10;

export const TRAINING_NODES: Record<'generate' | 'dataset' | 'train' | 'evaluate' | 'deploy', NodeDefinition> = {
  generate: {
    usesModel: true,
    check: (c) => (!c.prompt?.trim() ? 'Describe the examples to write' : undefined),
    async execute(ctx) {
      const want = Math.max(1, Math.min(200, ctx.node.config.count ?? 10));
      const task = fill(ctx.node.config.prompt ?? '', ctx, labelled(ctx.inputs.filter((i) => i.type !== 'input')));
      const spec = decisionSpec(ctx);
      if (ctx.node.config.datasetKind === 'decision' && !spec) throw new Error('A decision dataset needs its question: fill in the question and options in this block');
      const keys = spec ? specKeys(spec) : [];
      const shape = spec
        ? `Each example is a "state" (a realistic text the model reads) and the right answer to the question "${spec.question}", which is exactly one of: ${keys.join(', ')}${
            spec.type === 'choice' ? ` (${Object.entries(spec.options as Record<string, string>).map(([k, d]) => (d ? `${k} = ${d}` : k)).join('; ')})` : ''
          }. Spread the answers over all options. Reply as JSON: {"examples": [{"input": "<state>", "output": "<one option>"}]}`
        : 'Reply as JSON: {"examples": [{"input": "…", "output": "…"}]}';
      const examples: { input: string; output: string }[] = [];
      // In batches, each told what came before, so the teacher doesn't repeat itself.
      while (examples.length < want) {
        const n = Math.min(BATCH, want - examples.length);
        ctx.progress(`Writing examples ${examples.length + 1}–${examples.length + n} of ${want}…`);
        const seen = examples.length ? `\n\nAlready written (don't repeat these):\n${examples.map((e) => `- ${e.input.slice(0, 120)}`).join('\n')}` : '';
        const reply = await jsonCall(ctx, [
          {
            role: 'system',
            content:
              (ctx.node.config.system ? `${fill(ctx.node.config.system, ctx)}\n\n` : '') +
              'You write training examples for fine-tuning a model. Each example is an input (what a user says) and the ideal output (what the trained model should answer). Make them varied, realistic and correct.',
          },
          { role: 'user', content: `Write ${n} new examples for this:\n${task}${seen}\n\n${shape}` },
        ]);
        const got = ((JSON.parse(reply) as { examples?: { input?: unknown; output?: unknown }[] }).examples ?? [])
          .map((e) => ({ input: String(e.input ?? '').trim(), output: String(e.output ?? '').trim() }))
          .filter((e) => e.output && (!spec || keys.includes(e.output)));
        if (!got.length) throw new Error('The teacher model wrote no usable examples');
        examples.push(...got.slice(0, n));
      }
      let note = '';
      if (ctx.node.config.dataset?.trim()) {
        const r = services(ctx).addExamples(datasetName(ctx), examples, {
          source: 'generated',
          review: ctx.node.config.review,
          ...(spec && { kind: 'decision' as const, question: spec }),
        });
        note = `Added ${r.added} to "${r.name}" (${r.items} ready${r.pending ? `, ${r.pending} to review` : ''})`;
        ctx.progress(note);
      }
      return `${note ? `${note}\n\n` : ''}${examples.map((e) => JSON.stringify(e)).join('\n')}`;
    },
  },

  dataset: {
    usesModel: false,
    check: (c) => (!c.dataset?.trim() ? 'Name the dataset' : undefined),
    async execute(ctx) {
      const output = lastText(ctx);
      if (!output.trim()) throw new Error('Wire in the answer to keep (the question alone is not an example)');
      const input = fill(ctx.node.config.prompt || '{{question}}', ctx).trim();
      // Pictures wired in (an Image block): each one is an example, captioned with its prompt (or the input above).
      const pictures = [...output.matchAll(/\(hm-file:([^)\s]+)\)/g)].map((m) => m[1]);
      const caption = (output.match(/\nPrompt: ([^\n]+)/)?.[1] ?? input).trim();
      const items = pictures.length
        ? pictures.map((f) => ({ input: '', output: ctx.node.config.prompt ? input : caption, files: [f], ref: `file:${f}` }))
        : [{ input, output, ...(ctx.node.config.system && { system: fill(ctx.node.config.system, ctx) }) }];
      const r = services(ctx).addExamples(datasetName(ctx), items, {
        source: 'block',
        review: ctx.node.config.review,
        kind: pictures.length ? 'image' : ctx.node.config.datasetKind,
      });
      ctx.progress(`${r.pending && ctx.node.config.review ? 'Waiting for review in' : 'Kept in'} "${r.name}" · ${r.items} examples`);
      return output;
    },
  },

  train: {
    usesModel: false,
    check: (c) =>
      !c.dataset?.trim() ? 'Name the dataset to train on' : !c.trainBase?.trim() ? 'Pick a base model' : !c.trainName?.trim() ? 'Name the new model (e.g. my-model:v1)' : undefined,
    async execute(ctx) {
      const c = ctx.node.config;
      const name = fill(c.trainName ?? '', ctx).trim().toLowerCase();
      const t = services(ctx);
      const job = await t.startTrain({
        dataset: datasetName(ctx),
        base: c.trainBase!.trim(),
        name,
        target: c.trainTarget,
        epochs: c.epochs,
        steps: c.trainSteps,
        trigger: c.trainTrigger,
        flavor: c.trainFlavor,
        maxUsd: c.trainMaxUsd,
      });
      const where = job.backend === 'hf-jobs' ? ` on Hugging Face (about $${job.estimateUsd?.toFixed(2)})` : job.backend === 'comfyui' ? ' in ComfyUI' : '';
      ctx.progress(`Queued ${job.name}${where} · ${job.rows} examples`);
      if (!c.trainWait)
        // Training takes hours: the run goes on; the job shows in Lab → New model.
        return `Training ${job.name}${where} on ${job.rows} examples from "${datasetName(ctx)}" (base ${c.trainBase}). Job ${job.id} — follow it in Lab → New model; it waits for the GPU when it's busy.`;
      const end = await t.waitTrain(job.id, ctx.signal ?? new AbortController().signal, (note) => ctx.progress(`${job.name}: ${note}`));
      if (end.state !== 'done') throw new Error(`Training ${job.name} ended: ${end.state}${end.error ? ` — ${end.error}` : ''}`);
      return end.lora ? `The LoRA ${end.lora} is ready: pick it in an Image block.` : `${job.name} is ready in Ollama.`;
    },
  },

  evaluate: {
    usesModel: true,
    minModels: 1,
    check: (c) => (!c.dataset?.trim() ? 'Name the dataset with test examples' : undefined),
    async execute(ctx) {
      const models = ctx.node.config.models!;
      const tests = services(ctx).sample(datasetName(ctx), Math.max(1, Math.min(50, ctx.node.config.count ?? 5)));
      if (!tests.length) throw new Error(`"${datasetName(ctx)}" has no examples to test with`);
      const total = new Map<string, number[]>();
      for (let i = 0; i < tests.length; i++) {
        const t = tests[i];
        const answers: string[] = [];
        for (const m of models) {
          ctx.progress(`Test ${i + 1}/${tests.length} · ${modelName(m)} answers…`);
          answers.push(await ctx.callModel([...(t.system ? [{ role: 'system' as const, content: t.system }] : []), { role: 'user', content: t.input }], m).catch((err: Error) => `(error: ${err.message})`));
        }
        ctx.progress(`Test ${i + 1}/${tests.length} · judging…`);
        const verdict = JSON.parse(
          await jsonCall(ctx, [
            { role: 'system', content: 'You grade answers against a reference answer. Score each from 1 (wrong or useless) to 10 (as good as or better than the reference).' },
            {
              role: 'user',
              content: `Input:\n${t.input}\n\nReference answer:\n${t.output}\n\n${answers.map((a, j) => `### Answer ${j + 1}\n${a}`).join('\n\n')}\n\nReply as JSON: {"scores": [one number per answer, in order]}`,
            },
          ]),
        ) as { scores?: unknown[] };
        models.forEach((m, j) => {
          const s = Number(verdict.scores?.[j]);
          if (Number.isFinite(s)) total.set(m.model, [...(total.get(m.model) ?? []), Math.max(0, Math.min(10, s))]);
        });
      }
      const rows = models
        .map((m) => {
          const s = total.get(m.model) ?? [];
          return { model: m.model, avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0, n: s.length };
        })
        .sort((a, b) => b.avg - a.avg);
      ctx.progress(`Best: ${modelName({ providerId: '', model: rows[0].model })} · ${rows[0].avg.toFixed(1)}/10`);
      return `Evaluation on ${tests.length} examples from "${datasetName(ctx)}":\n\n| Model | Score /10 | Graded |\n|---|---|---|\n${rows
        .map((r, i) => `| ${i === 0 ? '🏆 ' : ''}${r.model} | ${r.avg.toFixed(1)} | ${r.n} |`)
        .join('\n')}`;
    },
  },

  deploy: {
    usesModel: true,
    check: (c) => (!c.canvasPattern?.trim() ? 'Name the canvases to update (e.g. dnd-*)' : undefined),
    async execute(ctx) {
      const pattern = fill(ctx.node.config.canvasPattern ?? '', ctx);
      const r = services(ctx).deploy(pattern, ctx.node.config.model!);
      if (!r.canvases) throw new Error(`None of your canvases match "${pattern}"`);
      ctx.progress(`${ctx.node.config.model!.model} → ${r.blocks} blocks in ${r.canvases} canvases`);
      return `${ctx.node.config.model!.model} is now the model of ${r.blocks} AI model blocks in ${r.canvases} canvases (${pattern}).`;
    },
  },
};
