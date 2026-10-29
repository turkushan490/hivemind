import type { CanvasGraph, ModelRef, TrainJob } from '@hivemind/shared';
import { db } from '../db/index.js';
import type { NodeServices } from '../nodes/index.js';
import { matches } from '../api/scope.js';
import { parseDecisionSpec } from '@hivemind/shared';
import { addItems, ensureDataset, findDataset, updateDataset, type NewItem } from './datasets.js';
import { cloudEstimate, startTrain, type TrainDeps } from './train.js';

/** What the training blocks (Generate examples, Add to dataset, Train, Evaluate, Deploy) may do for one user. */
export type TrainingServices = NonNullable<NodeServices['training']>;

/**
 * Puts a model into the AI model blocks of the owner's canvases whose id matches ("dnd-*", or ids separated by
 * commas). Auto-model blocks keep their own setting. Returns how many canvases and blocks changed.
 */
export function setCanvasModel(ownerId: string, pattern: string, model: ModelRef): { canvases: number; blocks: number } {
  const patterns = pattern
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!patterns.length) throw new Error('Name the canvases, e.g. dnd-* or my-canvas-id');
  const rows = (db.prepare('SELECT id, graph FROM canvases WHERE owner_id = ?').all(ownerId) as { id: string; graph: string }[]).filter((r) => matches(patterns, r.id));
  let blocks = 0;
  for (const r of rows) {
    const g = JSON.parse(r.graph) as CanvasGraph;
    for (const n of g.nodes) {
      if (n.type !== 'llm' || n.config.auto) continue;
      n.config.model = model;
      blocks++;
    }
    db.prepare("UPDATE canvases SET graph = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(g), r.id);
  }
  return { canvases: rows.length, blocks };
}

export function trainingServices(ownerId: string, deps: TrainDeps & { defaultTarget(): string | undefined; defaultComfy?(): string | undefined }): TrainingServices {
  return {
    addExamples(dataset, items: NewItem[], opts) {
      const ds = ensureDataset(ownerId, dataset, opts.kind ?? 'text');
      // A decision dataset made by a block gets the block's question (an existing question is kept).
      if (ds.kind === 'decision' && opts.question && !parseDecisionSpec(ds.system)) updateDataset(ownerId, ds.id, { system: JSON.stringify(opts.question) });
      if (ds.kind === 'image' && items.some((it) => !it.files?.length)) throw new Error(`"${ds.name}" is a picture dataset: wire in a block that makes pictures (Image)`);
      const added = addItems(ds.id, opts.source, items.map((it) => ({ ...it, ...(opts.review && { review: 'pending' as const }) })));
      const now = findDataset(ownerId, ds.id)!;
      return { name: now.name, added, items: now.items, pending: now.pending, kind: now.kind };
    },
    sample(dataset, n) {
      const ds = findDataset(ownerId, dataset);
      if (!ds) throw new Error(`No dataset called "${dataset}"`);
      return db
        .prepare("SELECT input, output, system FROM dataset_items WHERE dataset_id = ? AND (review IS NULL OR review = 'accepted') ORDER BY random() LIMIT ?")
        .all(ds.id, Math.max(1, n)) as { input: string; output: string; system: string | null }[];
    },
    async startTrain(opts): Promise<TrainJob> {
      const ds = findDataset(ownerId, opts.dataset);
      if (!ds) throw new Error(`No dataset called "${opts.dataset}" — fill it first (Add to dataset, Generate examples, 👍)`);
      if (ds.kind === 'image') {
        const comfy = opts.target || deps.defaultComfy?.();
        if (!comfy) throw new Error('Picture datasets are trained by ComfyUI: add it under Settings → Providers');
        return startTrain(ownerId, { base: opts.base, name: opts.name, providerId: comfy, datasetId: ds.id, steps: opts.steps, trigger: opts.trigger }, deps);
      }
      const target = opts.target || deps.defaultTarget();
      if (!target) throw new Error('No Ollama server to put the new model on (Settings → Providers)');
      const base = { base: opts.base, name: opts.name, providerId: target, datasetId: ds.id, epochs: opts.epochs };
      if (!opts.flavor) return startTrain(ownerId, base, deps);
      // A workflow can't ask: the block's own limit is the confirmation.
      const est = await cloudEstimate(ownerId, { ...base, flavor: opts.flavor });
      if (opts.maxUsd === undefined || est.usd > opts.maxUsd)
        throw new Error(`Training on ${est.label} costs about $${est.usd.toFixed(2)} (${est.hours} h), more than this block allows ($${(opts.maxUsd ?? 0).toFixed(2)}): raise its limit`);
      return startTrain(ownerId, { ...base, flavor: opts.flavor, confirmUsd: est.usd }, deps);
    },
    async waitTrain(id, signal, onProgress) {
      for (;;) {
        const r = db.prepare('SELECT state, error, progress, settings FROM lab_trains WHERE id = ? AND owner_id = ?').get(id, ownerId) as
          | { state: string; error: string | null; progress: string | null; settings: string }
          | undefined;
        if (!r) throw new Error(`Training job ${id} is gone`);
        if (['done', 'error', 'cancelled', 'interrupted'].includes(r.state))
          return { state: r.state, ...(r.error && { error: r.error }), ...(JSON.parse(r.settings).lora && { lora: JSON.parse(r.settings).lora }) };
        const p = r.progress ? (JSON.parse(r.progress) as { step?: number; totalSteps?: number; note?: string }) : {};
        onProgress(`${r.state}${p.totalSteps ? ` · step ${p.step ?? 0}/${p.totalSteps}` : ''}${p.note ? ` · ${p.note}` : ''}`);
        if (signal.aborted) throw new Error('Cancelled (the training keeps going; stop it in Lab → New model)');
        await new Promise((res) => setTimeout(res, Number(process.env.TRAIN_POLL_MS) || 5000));
      }
    },
    deploy: (pattern, model) => setCanvasModel(ownerId, pattern, model),
  };
}
