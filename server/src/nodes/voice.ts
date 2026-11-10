import { fill, type NodeContext, type NodeDefinition } from './index.js';

/**
 * Voice blocks (HiveBot's Voice trainer): Audio prep cuts recordings into clean clips, Voice dataset writes down what
 * is said in each and keeps them as a voice dataset, Voice clone builds a voice from the best clips, and Speak says
 * text in any voice (built-in or cloned) as audio files in the run. They use the run's voice services, which only the
 * person who runs it has (never a viewer, never a limited API token).
 */

const voice = (ctx: NodeContext) => {
  const v = ctx.services.voice;
  if (!v) throw new Error('Voice blocks need the person who runs the workflow (not a viewer or a limited API token)');
  return v;
};

/** The JSON a voice block wrote, from the blocks wired in (the last one that has it). */
function upstream<T>(ctx: NodeContext, key: string): T | undefined {
  for (const i of [...ctx.inputs].reverse()) {
    try {
      const j = JSON.parse(i.text) as Record<string, unknown>;
      if (j && typeof j === 'object' && key in j) return j as T;
    } catch {}
  }
  return undefined;
}

interface PrepOut {
  character: string;
  clips: { path: string; seconds: number; db: number; source: string }[];
}

export const VOICE_NODES: Record<'audioPrep' | 'voiceDataset' | 'voiceClone' | 'speak', NodeDefinition> = {
  audioPrep: {
    usesModel: false,
    async execute(ctx) {
      const v = voice(ctx);
      const character = v.character(ctx.vars, ctx.question);
      const folder = ctx.node.config.folder ? fill(ctx.node.config.folder, ctx) : undefined;
      const files = v.files(ctx.question, folder);
      ctx.progress(`${files.length} recording${files.length === 1 ? '' : 's'} for ${character}: cutting into clips…`);
      const out = await v.prep(files, character, { minSec: ctx.node.config.minSec, maxSec: ctx.node.config.maxSec });
      const thrown = Object.entries(out.dropped).filter(([, n]) => n > 0);
      const total = thrown.reduce((n, [, k]) => n + k, 0);
      ctx.progress(`${out.clips.length} clips kept${total ? `, ${total} thrown away (${thrown.map(([why, n]) => `${n} ${why}`).join(', ')})` : ''}`);
      return JSON.stringify({ character, clips: out.clips, dropped: out.dropped, files: out.files });
    },
  },

  voiceDataset: {
    usesModel: false,
    async execute(ctx) {
      const v = voice(ctx);
      const prep = upstream<PrepOut>(ctx, 'clips');
      if (!prep) throw new Error('Wire an Audio prep block into this one');
      const character = prep.character || v.character(ctx.vars, ctx.question);
      const dataset = fill(ctx.node.config.dataset || 'hivebot-voice-{{vars.character}}', { ...ctx, vars: { ...ctx.vars, character } }).trim();
      const out = await v.dataset(dataset, character, prep.clips, (note) => ctx.progress(note), ctx.signal);
      ctx.progress(`${character}: ${out.minutes} min in ${out.clips} clips (${out.added} new${out.skipped ? `, ${out.skipped} already in it` : ''}${out.failed ? `, ${out.failed} without words` : ''})`);
      return JSON.stringify(out);
    },
  },

  voiceClone: {
    usesModel: false,
    async execute(ctx) {
      const v = voice(ctx);
      const ds = upstream<{ character: string; dataset: string }>(ctx, 'dataset');
      const character = ds?.character || v.character(ctx.vars, ctx.question);
      const name = fill(ctx.node.config.voice || 'clone:{{vars.character}}', { ...ctx, vars: { ...ctx.vars, character } });
      const dataset = ds?.dataset || fill(ctx.node.config.dataset || 'hivebot-voice-{{vars.character}}', { ...ctx, vars: { ...ctx.vars, character } });
      const def = v.clone(dataset, name, ctx.node.config.count ?? 1);
      ctx.progress(`Voice ${def.id} built from ${def.refs.length} clips (${def.minutes} min in the dataset)`);
      return JSON.stringify({ voice: def.id, character, refs: def.refs.map((r) => r.text), minutes: def.minutes });
    },
  },

  speak: {
    usesModel: false,
    async execute(ctx) {
      const v = voice(ctx);
      const built = upstream<{ voice: string; character: string }>(ctx, 'voice');
      const character = built?.character ?? (ctx.vars?.character || '');
      const voiceId = fill(ctx.node.config.voice || built?.voice || 'af_heart', { ...ctx, vars: { ...ctx.vars, character } }).trim();
      // The block's text (one sentence per line), else what is wired in (not JSON from voice blocks), else the question.
      const wired = ctx.inputs.filter((i) => i.type !== 'input' && !/^\s*\{/.test(i.text)).map((i) => i.text);
      const raw = ctx.node.config.prompt ? fill(ctx.node.config.prompt, ctx) : wired.length ? wired.join('\n') : ctx.question;
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 6);
      if (!lines.length) throw new Error('Nothing to say: write the text in the block, or wire in a block that writes it');
      const said: string[] = [];
      for (const [i, line] of lines.entries()) {
        ctx.progress(`Speaking ${i + 1} of ${lines.length} in ${voiceId}…`);
        const out = await v.speak(line, voiceId);
        if (out.note) ctx.progress(out.note);
        ctx.attach(out.file);
        said.push(`${line} → ${out.file.path}`);
      }
      return `Spoken in ${voiceId}:\n${said.join('\n')}`;
    },
  },
};
