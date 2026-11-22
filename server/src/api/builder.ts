import type { CanvasGraph, ModelInfo, ModelRef } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { builderSystemPrompt, builderUserPrompt, parseReply, toGraph } from '../builder/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { describe, logError } from '../errors.js';
import type { ChatMessage } from '../providers/types.js';
import { requireUser, type User } from './auth.js';
import { allowedModelsOf, gpuFreerFor, resolverFor, usableRows } from './providers.js';
import { runEnded, runSnapshot, startRun } from '../events/runs.js';
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
   * The Builder runs as a real workflow run (shown live in Active workflows, never cut off by a proxy's timeout):
   * POST starts it and returns { runId } at once; GET /api/builder/:runId gives { status: "running" } until the plan
   * is there, then { reply, graph?, fixes, model, ms }. A plan that can't be used is asked again once (a new runId).
   */
  app.post('/api/builder', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { message?: string; history?: ChatMessage[]; graph?: CanvasGraph };
    const message = body.message?.trim();
    if (!message) return reply.code(400).send({ error: 'Tell the Builder what you need' });
    const model = getPrefs(req.user!).builderModel;
    if (!model) return reply.code(409).send({ error: 'Pick a model for the Builder first (Settings → Builder AI)' });
    if (!allowedFor(req.user!).model(model.providerId, model.model)) return reply.code(403).send({ error: notAllowed(model.model).message });
    const models = await allModels(req.user!);
    const history = (body.history ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-6);
    const runId = startBuilderRun(req.user!, { model, system: builderSystemPrompt(models), history, prompt: builderUserPrompt(message, body.graph) });
    builderJobs.set(runId, { userId: req.user!.id, model, t0: Date.now(), attempt: 0, history, prompt: builderUserPrompt(message, body.graph) });
    return { runId };
  });

  app.get('/api/builder/:runId', { preHandler: requireUser }, async (req, reply) => {
    const runId = (req.params as { runId: string }).runId;
    const job = builderJobs.get(runId);
    if (!job || job.userId !== req.user!.id) return reply.code(404).send({ error: 'No such Builder run' });
    // Wait up to 20 s for the run to end (short enough for any proxy), else "still running".
    const ended = await runEnded(runId, 20_000);
    if (!ended) return { status: 'running', runId };
    const snap = runSnapshot(runId, req.user!.id);
    const done = snap?.events.find((e) => e.type === 'run_done');
    const text = done?.final ?? snap?.final ?? '';
    const failed = snap?.events.find((e) => e.type === 'error')?.error;
    const models = await allModels(req.user!);
    let problem = failed ?? '';
    if (text) {
      try {
        const parsed = parseReply(text);
        builderJobs.delete(runId);
        if (!parsed.canvas) return { status: 'done', reply: parsed.reply || 'Nothing to change.', model: job.model, ms: Date.now() - job.t0, fixes: [] };
        const { graph, fixes } = toGraph(parsed.canvas, models);
        return { status: 'done', reply: parsed.reply || 'Here is your canvas.', graph, fixes, model: job.model, ms: Date.now() - job.t0 };
      } catch (err) {
        problem = describe(err).message;
      }
    }
    builderJobs.delete(runId);
    if (job.attempt === 0 && text && done?.status !== 'cancelled') {
      // Once more, with the exact problem.
      const next = startBuilderRun(req.user!, {
        model: job.model,
        system: builderSystemPrompt(models),
        history: [...job.history, { role: 'user', content: job.prompt }, { role: 'assistant', content: text }],
        prompt: `That did not work: ${problem}. Answer again with only the JSON object.`,
      });
      builderJobs.set(next, { ...job, attempt: 1 });
      return { status: 'running', runId: next, note: `Asking again: ${problem.slice(0, 120)}` };
    }
    logError({ source: 'run', message: `Builder (${job.model.model}) could not make a canvas: ${problem || 'no answer'}`, detail: text.slice(0, 4000), userId: req.user!.id });
    return reply.code(502).send({ error: `The Builder's model (${job.model.model}) gave no usable canvas: ${problem || 'no answer'}. A bigger model usually helps.` });
  });
}

/** Builder runs waiting for their result (by runId). */
const builderJobs = new Map<string, { userId: string; model: ModelRef; t0: number; attempt: number; history: ChatMessage[]; prompt: string }>();

/** One Builder call as a workflow run: question → the Builder's model (JSON) → the plan. Shown as "Builder". */
function startBuilderRun(user: User, o: { model: ModelRef; system: string; history: ChatMessage[]; prompt: string }): string {
  const graph: CanvasGraph = {
    nodes: [
      { id: 'q', type: 'input', position: { x: 0, y: 0 }, label: 'What you asked', config: {} },
      {
        id: 'b',
        type: 'llm',
        position: { x: 320, y: 0 },
        label: 'Builder: design the workflow',
        config: { model: o.model, system: o.system, prompt: '{{history}}\n\n{{question}}', json: true, temperature: 0.2, think: false, maxTokens: 8192, maxSeconds: 900, useMessages: false },
      },
      { id: 'o', type: 'output', position: { x: 640, y: 0 }, label: 'The plan', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'q', target: 'b' },
      { id: 'e2', source: 'b', target: 'o' },
    ],
  };
  return startRun({
    ownerId: user.id,
    user,
    graph,
    question: o.prompt,
    chat: { system: '', history: o.history.map((m) => ({ role: m.role, content: m.content })) as never },
    resolve: resolverFor(user),
    freeGpu: gpuFreerFor(user),
    source: 'Builder',
    title: 'Builder',
  });
}
