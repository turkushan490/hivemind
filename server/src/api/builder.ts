import type { CanvasGraph, ModelInfo, ModelRef } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { builderSystemPrompt, builderUserPrompt, parseReply, toGraph } from '../builder/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { describe, logError } from '../errors.js';
import type { ChatMessage } from '../providers/types.js';
import { requireUser, type User } from './auth.js';
import { allowedModelsOf, resolverFor, usableRows } from './providers.js';
import { allowedFor, notAllowed } from '../services/access.js';
import { canvasesFor } from './runs.js';
import { routeCanvas } from '../services/canvasRouter.js';

/** Per-user preferences: finished the setup wizard, and which model the Builder uses. */
export interface Prefs {
  setupDone?: boolean;
  builderModel?: ModelRef;
  /** Voice and /v1 model "auto": a decision model picks the canvas for each request. */
  canvasRouter?: ModelRef;
  /** /v1 also offers single models ("colibri/qwen36-35b"), for coding agents; default on for admins. */
  apiModels?: boolean;
}

/** Whether /v1 offers this person single models: their setting, and for a limited token its "models" permission. */
export function apiModelsOn(u: User): boolean {
  if (u.scope && u.scope.models !== true) return false;
  return getPrefs(u).apiModels ?? u.role === 'admin';
}

const prefsKey = (u: User) => `user:${u.id}:prefs`;
export function getPrefs(u: User): Prefs {
  try {
    return JSON.parse(getSetting(prefsKey(u)) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}

/** The models this user may use (Settings → Access): the Builder only proposes these. */
async function allModels(user: User): Promise<ModelInfo[]> {
  const access = allowedFor(user);
  const rows = usableRows(user, access).filter((r) => r.enabled);
  const lists = await Promise.allSettled(rows.map((r) => allowedModelsOf(r, access, true)));
  return lists.flatMap((l) => (l.status === 'fulfilled' ? l.value : []));
}

export function builderRoutes(app: FastifyInstance) {
  app.get('/api/me/prefs', { preHandler: requireUser }, async (req) => getPrefs(req.user!));

  app.put('/api/me/prefs', { preHandler: requireUser }, async (req) => {
    const body = (req.body ?? {}) as Prefs;
    const next: Prefs = { ...getPrefs(req.user!) };
    if (body.setupDone !== undefined) next.setupDone = !!body.setupDone;
    if (body.builderModel !== undefined) next.builderModel = body.builderModel?.providerId && body.builderModel.model ? body.builderModel : undefined;
    if (body.canvasRouter !== undefined) next.canvasRouter = body.canvasRouter?.providerId && body.canvasRouter.model ? body.canvasRouter : undefined;
    if (body.apiModels !== undefined) next.apiModels = !!body.apiModels;
    setSetting(prefsKey(req.user!), JSON.stringify(next));
    return next;
  });

  /** Which canvas should answer this (voice in Use mode): needs Settings → Voice → Canvas router. */
  app.post('/api/route-canvas', { preHandler: requireUser }, async (req, reply) => {
    const text = String((req.body as { text?: string } | undefined)?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'Send the text to route' });
    const decider = getPrefs(req.user!).canvasRouter;
    if (!decider) return reply.code(400).send({ error: 'Turn on the canvas router first (Settings → Voice)' });
    if (!allowedFor(req.user!).model(decider.providerId, decider.model)) return reply.code(403).send({ error: notAllowed(decider.model).message });
    try {
      return await routeCanvas(text, canvasesFor(req.user!), decider, resolverFor(req.user!));
    } catch (err) {
      const message = `Canvas router: ${(err as Error).message}`;
      logError({ source: 'voice', message, userId: req.user!.id });
      return reply.code(502).send({ error: message });
    }
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
    if (!allowedFor(req.user!).model(model.providerId, model.model)) return reply.code(403).send({ error: notAllowed(model.model).message });

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
