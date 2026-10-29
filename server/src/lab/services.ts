import type { CanvasGraph, ModelRef, TrainJob } from '@hivemind/shared';
import { db } from '../db/index.js';
import type { NodeServices } from '../nodes/index.js';
import { matches } from '../api/scope.js';
import { addItems, ensureDataset, findDataset, type NewItem } from './datasets.js';
import { startTrain, type TrainDeps } from './train.js';

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

export function trainingServices(ownerId: string, deps: TrainDeps & { defaultTarget(): string | undefined }): TrainingServices {
  return {
    addExamples(dataset, items: NewItem[], opts) {
      const ds = ensureDataset(ownerId, dataset);
      const added = addItems(ds.id, opts.source, items.map((it) => ({ ...it, ...(opts.review && { review: 'pending' as const }) })));
      const now = findDataset(ownerId, ds.id)!;
      return { name: now.name, added, items: now.items, pending: now.pending };
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
      const target = opts.target || deps.defaultTarget();
      if (!target) throw new Error('No Ollama server to put the new model on (Settings → Providers)');
      return startTrain(ownerId, { base: opts.base, name: opts.name, providerId: target, datasetId: ds.id, epochs: opts.epochs }, deps);
    },
    deploy: (pattern, model) => setCanvasModel(ownerId, pattern, model),
  };
}
