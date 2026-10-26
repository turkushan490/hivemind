import type { CanvasGraph, ModelInfo, ModelRef } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { builderSystemPrompt, builderUserPrompt, parseReply, toGraph } from '../builder/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { describe, logError } from '../errors.js';
import type { ChatMessage } from '../providers/types.js';
import { requireUser, type User } from './auth.js';
import { resolverFor, visibleRows, adapterFor } from './providers.js';

/** Per-user preferences: finished the setup wizard, and which model the Builder uses. */
export interface Prefs {
  setupDone?: boolean;
  builderModel?: ModelRef;
}

const prefsKey = (u: User) => `user:${u.id}:prefs`;
export function getPrefs(u: User): Prefs {
  try {
    return JSON.parse(getSetting(prefsKey(u)) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}

async function allModels(user: User): Promise<ModelInfo[]> {
  const rows = visibleRows(user).filter((r) => r.enabled);
  const lists = await Promise.allSettled(rows.map((r) => adapterFor(r).listModels()));
  return lists.flatMap((l) => (l.status === 'fulfilled' ? l.value : []));
}

export function builderRoutes(app: FastifyInstance) {
  app.get('/api/me/prefs', { preHandler: requireUser }, async (req) => getPrefs(req.user!));

  app.put('/api/me/prefs', { preHandler: requireUser }, async (req) => {
    const body = (req.body ?? {}) as Prefs;
    const next: Prefs = { ...getPrefs(req.user!) };
    if (body.setupDone !== undefined) next.setupDone = !!body.setupDone;
    if (body.builderModel !== undefined) next.builderModel = body.builderModel?.providerId && body.builderModel.model ? body.builderModel : undefined;
    setSetting(prefsKey(req.user!), JSON.stringify(next));
    return next;
  });

  /**
   * Body: { message, history?: [{role, content}], graph? }. Returns { reply, graph?, fixes, model }.
   * One retry with the exact problem when the model's canvas can't be used.
   */
  app.post('/api/builder', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { message?: string; history?: ChatMessage[]; graph?: CanvasGraph };
    const message = body.message?.trim();
    if (!message) return reply.code(400).send({ error: 'Tell the Builder what you need' });
    const model = getPrefs(req.user!).builderModel;
    if (!model) return reply.code(409).send({ error: 'Pick a model for the Builder first (Settings → Builder AI)' });

    const models = await allModels(req.user!);
    const provider = await resolverFor(req.user!)(model.providerId).catch((err) => {
      throw Object.assign(new Error(`The Builder's model is not available: ${(err as Error).message}`), { statusCode: 409 });
    });
    const history = (body.history ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-6);
    const messages: ChatMessage[] = [
      { role: 'system', content: builderSystemPrompt(models) },
      ...history,
      { role: 'user', content: builderUserPrompt(message, body.graph) },
    ];

    const ask = async (msgs: ChatMessage[]) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 240_000);
      try {
        let out = '';
        for await (const c of provider.adapter.stream({ model: model.model, messages: msgs, json: true, temperature: 0.2 }, ctl.signal)) if (c.type === 'token') out += c.text;
        return out;
      } finally {
        clearTimeout(timer);
      }
    };

    const t0 = Date.now();
    let text = '';
    let problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        text = await ask(attempt === 0 ? messages : [...messages, { role: 'assistant', content: text }, { role: 'user', content: `That did not work: ${problem}. Answer again with only the JSON object.` }]);
        const parsed = parseReply(text);
        if (!parsed.canvas) return { reply: parsed.reply || 'Nothing to change.', model, ms: Date.now() - t0, fixes: [] };
        const { graph, fixes } = toGraph(parsed.canvas, models);
        return { reply: parsed.reply || 'Here is your canvas.', graph, fixes, model, ms: Date.now() - t0 };
      } catch (err) {
        problem = describe(err).message;
        if ((err as Error).name === 'AbortError') break;
      }
    }
    logError({ source: 'run', message: `Builder (${model.model}) could not make a canvas: ${problem}`, detail: text.slice(0, 4000), userId: req.user!.id });
    return reply.code(502).send({ error: `The Builder's model (${model.model}) gave no usable canvas: ${problem}. A bigger model usually helps.` });
  });
}
