import type { DatasetKind } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import {
  addItems,
  createDataset,
  deleteDataset,
  deleteItem,
  ensureDataset,
  exportDataset,
  getDataset,
  listDatasets,
  listItems,
  parseUpload,
  updateDataset,
  updateItem,
} from '../lab/datasets.js';
import { captionPictures, picturesFromFolder } from '../lab/imageLora.js';
import { requireUser } from './auth.js';
import { trainDepsFor } from './providers.js';
import { datasetAllowed } from './scope.js';

/** Training data for every kind of model. Viewers can't change anything (the viewer guard blocks writes). */
export function datasetRoutes(app: FastifyInstance) {
  // A limited token sees only the datasets its scope names.
  app.get('/api/datasets', { preHandler: requireUser }, async (req) => listDatasets(req.user!.id).filter((d) => datasetAllowed(req.user!, d.name)));

  app.post('/api/datasets', { preHandler: requireUser }, async (req) => {
    const b = (req.body ?? {}) as { name?: string; kind?: DatasetKind; description?: string; system?: string };
    return createDataset(req.user!.id, { name: String(b.name ?? ''), kind: b.kind, description: b.description, system: b.system });
  });

  app.patch('/api/datasets/:id', { preHandler: requireUser }, async (req) => {
    const b = (req.body ?? {}) as { name?: string; description?: string; system?: string };
    return updateDataset(req.user!.id, (req.params as { id: string }).id, b);
  });

  app.delete('/api/datasets/:id', { preHandler: requireUser }, async (req, reply) =>
    deleteDataset(req.user!.id, (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Dataset not found' }),
  );

  app.get('/api/datasets/:id/items', { preHandler: requireUser }, async (req, reply) => {
    const ds = getDataset(req.user!.id, (req.params as { id: string }).id);
    if (!ds) return reply.code(404).send({ error: 'Dataset not found' });
    const q = req.query as { review?: string; limit?: string; offset?: string };
    return listItems(ds.id, { review: q.review, limit: Number(q.limit) || 100, offset: Number(q.offset) || 0 });
  });

  /** Add examples by hand, or a whole upload: {items: [...]} or {text, format} (JSONL, CSV or plain text). */
  app.post('/api/datasets/:id/items', { preHandler: requireUser, bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const ds = getDataset(req.user!.id, (req.params as { id: string }).id);
    if (!ds) return reply.code(404).send({ error: 'Dataset not found' });
    const b = (req.body ?? {}) as { items?: { input?: string; output?: string; system?: string }[]; text?: string; format?: 'jsonl' | 'csv' | 'txt' };
    const items = b.text !== undefined ? parseUpload(String(b.text), b.format) : Array.isArray(b.items) ? b.items : [];
    if (!items.length) return reply.code(400).send({ error: 'No examples found in what was sent' });
    if (items.length > 50_000) return reply.code(413).send({ error: 'At most 50 000 examples at once' });
    return { added: addItems(ds.id, b.text !== undefined ? 'upload' : 'manual', items), dataset: getDataset(req.user!.id, ds.id) };
  });

  /** Image datasets: every picture in a Files folder (a same-named .txt is its caption). */
  app.post('/api/datasets/:id/pictures', { preHandler: requireUser }, async (req, reply) => {
    const ds = getDataset(req.user!.id, (req.params as { id: string }).id);
    if (!ds) return reply.code(404).send({ error: 'Dataset not found' });
    if (ds.kind !== 'image') return reply.code(400).send({ error: 'Pictures go into an image dataset' });
    const pics = picturesFromFolder(String((req.body as { folder?: string } | undefined)?.folder ?? ''));
    if (!pics.length) return reply.code(400).send({ error: 'No pictures (.png, .jpg, .webp) in that folder' });
    return { added: addItems(ds.id, 'upload', pics.map((p) => ({ input: '', output: p.caption, files: [p.file], ref: `file:${p.file}` }))), dataset: getDataset(req.user!.id, ds.id) };
  });

  /** Captions a few uncaptioned pictures with a vision model in Ollama; the page calls again until none are left. */
  app.post('/api/datasets/:id/caption', { preHandler: requireUser }, async (req, reply) => {
    const ds = getDataset(req.user!.id, (req.params as { id: string }).id);
    if (!ds) return reply.code(404).send({ error: 'Dataset not found' });
    const b = (req.body ?? {}) as { providerId?: string; model?: string };
    const ollamaUrl = trainDepsFor(req.user!).ollamaUrl(String(b.providerId ?? ''));
    if (!ollamaUrl || !b.model) return reply.code(400).send({ error: 'Pick an Ollama model that can see pictures' });
    return captionPictures(ds.id, { ollamaUrl, model: String(b.model) });
  });

  app.patch('/api/datasets/items/:itemId', { preHandler: requireUser }, async (req) => {
    const b = (req.body ?? {}) as { input?: string; output?: string; review?: 'pending' | 'accepted' | 'rejected' | null };
    updateItem(req.user!.id, Number((req.params as { itemId: string }).itemId), b);
    return { ok: true };
  });

  app.delete('/api/datasets/items/:itemId', { preHandler: requireUser }, async (req, reply) =>
    deleteItem(req.user!.id, Number((req.params as { itemId: string }).itemId)) ? { ok: true } : reply.code(404).send({ error: 'Example not found' }),
  );

  app.get('/api/datasets/:id/export.jsonl', { preHandler: requireUser }, async (req, reply) => {
    const ds = getDataset(req.user!.id, (req.params as { id: string }).id);
    if (!ds) return reply.code(404).send({ error: 'Dataset not found' });
    const name = ds.name.replace(/[^\w.-]+/g, '-').toLowerCase();
    reply.header('content-type', 'application/jsonl; charset=utf-8').header('content-disposition', `attachment; filename="${name}.jsonl"`);
    return exportDataset(ds.id);
  });

  /** 👍 on an answer: the run's question and final answer (or one block's output) become an example. */
  app.post('/api/runs/:id/thumbs', { preHandler: requireUser }, async (req, reply) => {
    const b = (req.body ?? {}) as { dataset?: string; label?: string };
    const run = db.prepare('SELECT question, final, events FROM runs WHERE id = ? AND owner_id = ?').get((req.params as { id: string }).id, req.user!.id) as
      | { question: string; final: string | null; events: string | null }
      | undefined;
    if (!run) return reply.code(404).send({ error: 'Run not found (or still going)' });
    let output = run.final ?? '';
    if (b.label) {
      const done = (JSON.parse(run.events ?? '[]') as { type: string; label?: string; text?: string }[]).find((e) => e.type === 'node_done' && e.label === b.label);
      output = done?.text ?? output;
    }
    if (!output.trim()) return reply.code(400).send({ error: 'This run has no answer to keep' });
    const ds = ensureDataset(req.user!.id, String(b.dataset || 'My good answers').trim());
    addItems(ds.id, 'thumbs', [{ input: run.question, output, ref: `run:${(req.params as { id: string }).id}${b.label ? `:${b.label}` : ''}` }]);
    return { dataset: getDataset(req.user!.id, ds.id) };
  });
}
