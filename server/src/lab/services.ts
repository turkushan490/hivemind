import type { CanvasGraph, ModelRef, TrainJob } from '@hivemind/shared';
import { db } from '../db/index.js';
import type { NodeServices } from '../nodes/index.js';
import { matches } from '../api/scope.js';
import { parseDecisionSpec } from '@hivemind/shared';
import { addItems, ensureDataset, findDataset, updateDataset, type NewItem } from './datasets.js';
import { cloudEstimate, newExamples, startTrain, type TrainDeps } from './train.js';

/** What the training blocks (Generate examples, Add to dataset, Train, Evaluate, Deploy) may do for one user. */
export type TrainingServices = NonNullable<NodeServices['training']>;

/**
 * Puts a model into the AI model blocks of the owner's canvases whose id matches ("dnd-*", or ids separated by
 * commas). Auto-model blocks keep their own setting. Returns how many canvases and blocks changed.
 */
export function setCanvasModel(ownerId: string, pattern: string, model: ModelRef, allowCanvas: (id: string) => boolean = () => true): { canvases: number; blocks: number } {
  const patterns = pattern
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!patterns.length) throw new Error('Name the canvases, e.g. dnd-* or my-canvas-id');
  const rows = (db.prepare('SELECT id, graph FROM canvases WHERE owner_id = ?').all(ownerId) as { id: string; graph: string }[]).filter((r) => matches(patterns, r.id) && allowCanvas(r.id));
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

export function trainingServices(
  ownerId: string,
  deps: TrainDeps & { defaultTarget(): string | undefined; defaultComfy?(): string | undefined },
  opts: {
    /** Every job waits for the training window (a scheduled run). */
    nightly?: boolean;
    /** The API token of the run, remembered on its jobs. */
    tokenId?: string;
    /** A limited token: the datasets (by name) and canvases it may use. */
    allowDataset?(name: string): boolean;
    allowCanvas?(id: string): boolean;
  } = {},
): TrainingServices {
  const check = (name: string) => {
    if (opts.allowDataset && !opts.allowDataset(name)) throw new Error(`This API token may not use dataset "${name}"`);
  };
  return {
    addExamples(dataset, items: NewItem[], o) {
      check(dataset);
      const ds = ensureDataset(ownerId, dataset, o.kind ?? 'text');
      // A decision dataset made by a block gets the block's question (an existing question is kept).
      if (ds.kind === 'decision' && o.question && !parseDecisionSpec(ds.system)) updateDataset(ownerId, ds.id, { system: JSON.stringify(o.question) });
      if (ds.kind === 'image' && items.some((it) => !it.files?.length)) throw new Error(`"${ds.name}" is a picture dataset: wire in a block that makes pictures (Image)`);
      const added = addItems(ds.id, o.source, items.map((it) => ({ ...it, ...(o.review && { review: 'pending' as const }) })));
      const now = findDataset(ownerId, ds.id)!;
      return { name: now.name, added, items: now.items, pending: now.pending, kind: now.kind };
    },
    sample(dataset, n) {
      check(dataset);
      const ds = findDataset(ownerId, dataset);
      if (!ds) throw new Error(`No dataset called "${dataset}"`);
      return db
        .prepare("SELECT input, output, system FROM dataset_items WHERE dataset_id = ? AND (review IS NULL OR review = 'accepted') ORDER BY random() LIMIT ?")
        .all(ds.id, Math.max(1, n)) as { input: string; output: string; system: string | null }[];
    },
    async startTrain(t): Promise<TrainJob> {
      check(t.dataset);
      const ds = findDataset(ownerId, t.dataset);
      if (!ds) throw new Error(`No dataset called "${t.dataset}" — fill it first (Add to dataset, Generate examples, 👍)`);
      const when = { nightly: !!(t.nightly || opts.nightly), tokenId: opts.tokenId };
      if (ds.kind === 'image') {
        const comfy = t.target || deps.defaultComfy?.();
        if (!comfy) throw new Error('Picture datasets are trained by ComfyUI: add it under Settings → Providers');
        return startTrain(ownerId, { base: t.base, name: t.name, providerId: comfy, datasetId: ds.id, steps: t.steps, trigger: t.trigger, ...when }, deps);
      }
      const target = t.target || deps.defaultTarget();
      if (!target) throw new Error('No Ollama server to put the new model on (Settings → Providers)');
      const base = { base: t.base, name: t.name, providerId: target, datasetId: ds.id, epochs: t.epochs, ...when };
      if (!t.flavor) return startTrain(ownerId, base, deps);
      if (opts.allowDataset) throw new Error('This API token may not rent a Hugging Face machine (cloud training)');
      // A workflow can't ask: the block's own limit is the confirmation.
      const est = await cloudEstimate(ownerId, { ...base, flavor: t.flavor });
      if (t.maxUsd === undefined || est.usd > t.maxUsd)
        throw new Error(`Training on ${est.label} costs about $${est.usd.toFixed(2)} (${est.hours} h), more than this block allows ($${(t.maxUsd ?? 0).toFixed(2)}): raise its limit`);
      return startTrain(ownerId, { ...base, flavor: t.flavor, confirmUsd: est.usd }, deps);
    },
    newExamples(dataset, name) {
      check(dataset);
      const ds = findDataset(ownerId, dataset);
      return ds ? newExamples(ownerId, ds.id, name) : 0;
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
    deploy: (pattern, model) => setCanvasModel(ownerId, pattern, model, opts.allowCanvas),
  };
}
