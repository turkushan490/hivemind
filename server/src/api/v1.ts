import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validateGraph } from '../engine/graph.js';
import { checkVars } from '../engine/vars.js';
import { cancelRun, startRun, subscribe } from '../events/runs.js';
import { apiError, chatFrom, chunk, LiveText, completion, findCanvas, modelList, streamSource, usageOf, type CanvasModelRow } from '../services/openaiCompat.js';
import { authenticate } from './auth.js';
import { getPrefs } from './builder.js';
import { routeCanvas } from '../services/canvasRouter.js';
import { logError } from '../errors.js';
import { gpuFreerFor, resolverFor } from './providers.js';
import { canvasesFor, runSetup } from './runs.js';


/** Bearer API token (or the web session), answered in OpenAI's error format. */
async function requireToken(req: FastifyRequest, reply: FastifyReply) {
  req.user = authenticate(req);
  if (!req.user) return reply.code(401).send(apiError('Missing or wrong API token. Send "Authorization: Bearer hm_…" (Settings → API tokens).', 'authentication_error', 'invalid_api_key'));
}


/**
 * OpenAI-compatible API: every saved canvas is a model. Works with any OpenAI client
 * (Home Assistant, Open WebUI, scripts) pointed at http://<hivemind>/v1.
 */
export function v1Routes(app: FastifyInstance) {
  app.get('/v1/models', { preHandler: requireToken }, async (req) => {
    const rows = canvasesFor(req.user!).map((r): CanvasModelRow => ({ id: r.id, name: r.name, description: r.description, updatedAt: r.updated_at }));
    // With the canvas router on, "auto" picks the right canvas per request.
    if (getPrefs(req.user!).canvasRouter && rows.length) rows.unshift({ id: 'auto', name: 'Auto (picks the canvas)', description: 'A decision model picks the canvas for each request', updatedAt: rows[0].updatedAt });
    return modelList(rows);
  });

  app.post('/v1/chat/completions', { preHandler: requireToken }, async (req, reply) => {
    const body = (req.body ?? {}) as { model?: string; messages?: unknown; stream?: boolean; hivemind_vars?: unknown };
    if (!body.model) return reply.code(400).send(apiError('"model" is required: the id or name of a saved canvas (see GET /v1/models)'));
    let question: string;
    let vars: Record<string, string>;
    let chat: { system: string; history: { role: 'user' | 'assistant'; content: string }[] };
    try {
      // HiveMind extra: named values for {{vars.name}}, as with POST /api/runs.
      vars = checkVars(body.hivemind_vars);
      const c = chatFrom(body.messages);
      question = c.question;
      chat = { system: c.system, history: c.history };
    } catch (err) {
      return reply.code(400).send(apiError((err as Error).message));
    }
    // Model "auto": the canvas router (Settings → Voice) picks the canvas, so one Home Assistant agent reaches all of them.
    const all = canvasesFor(req.user!);
    let row = findCanvas(all, body.model);
    const router = getPrefs(req.user!).canvasRouter;
    if (!row && /^(hivemind[/:])?auto$/i.test(body.model.trim()) && router) {
      try {
        const picked = await routeCanvas(question, all, router, resolverFor(req.user!));
        row = all.find((r) => r.id === picked.canvasId);
      } catch (err) {
        logError({ source: 'voice', message: `Canvas router: ${(err as Error).message}`, userId: req.user!.id });
        return reply.code(502).send(apiError(`Canvas router: ${(err as Error).message}`, 'server_error', 'router_failed'));
      }
    }
    if (!row) return reply.code(404).send(apiError(`No canvas "${body.model}". GET /v1/models lists yours.`, 'invalid_request_error', 'model_not_found'));
    // A canvas from the API always runs as saved (shared ones with their owner's providers).
    const { graph = JSON.parse(row.graph) as CanvasGraph, providerUser } = runSetup(req.user!, row, undefined);
    try {
      validateGraph(graph);
    } catch (err) {
      return reply.code(400).send(apiError(`Canvas "${row.name}" can't run: ${(err as Error).message}`));
    }

    const user = req.user!;
    const runId = startRun({ ownerId: user.id, user, canvasId: row.id, graph, question, vars, chat, resolve: resolverFor(providerUser), freeGpu: gpuFreerFor(providerUser) });
    const model = body.model;
    const live = streamSource(graph);
    const events: RunEvent[] = [];
    const errors: string[] = [];

    // Client went away before the answer: stop the run (its GPU time is better spent elsewhere).
    let finished = false;
    reply.raw.on('close', () => {
      if (!finished) cancelRun(runId, user.id);
    });

    if (!body.stream) {
      const done = await new Promise<RunEvent | undefined>((resolve) => {
        const sub = subscribe(
          runId,
          user.id,
          (ev) => {
            events.push(ev);
            if (ev.type === 'error' && ev.error) errors.push(ev.error);
            if (ev.type === 'run_done' && ev.seq >= 0) resolve(ev);
          },
          () => resolve(undefined),
        );
        if (!sub) resolve(undefined);
      });
      finished = true;
      if (!done || done.final === undefined)
        return reply.code(500).send(apiError(`The canvas "${row.name}" gave no answer${errors.length ? `: ${errors.join('; ')}` : ''} (run ${runId}, see Problems)`, 'server_error', 'run_failed'));
      return completion(runId, model, done.final, usageOf(events));
    }

    // Streaming: the only block feeding the Final answer streams live; otherwise the answer comes in one piece at the end.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send(chunk(runId, model, { role: 'assistant', content: '' }));
    const ping = setInterval(() => res.write(': working\n\n'), 10_000);
    const liveText = new LiveText();
    await new Promise<void>((resolve) => {
      const sub = subscribe(
        runId,
        user.id,
        (ev) => {
          events.push(ev);
          if (ev.type === 'error' && ev.error) errors.push(ev.error);
          if (ev.type === 'token' && ev.nodeId === live && ev.text) {
            const out = liveText.push(ev.text);
            if (out) send(chunk(runId, model, { content: out }));
          }
          if (ev.type === 'run_done' && ev.seq >= 0) {
            if (ev.final !== undefined) {
              // Whatever was not streamed live (all of it, or a tail held back or sent only at the end).
              const rest = liveText.finish(ev.final);
              if (rest) send(chunk(runId, model, { content: rest }));
              send(chunk(runId, model, {}, 'stop'));
            } else {
              send(apiError(`The canvas "${row.name}" gave no answer${errors.length ? `: ${errors.join('; ')}` : ''} (run ${runId}, see Problems)`, 'server_error', 'run_failed'));
            }
            resolve();
          }
        },
        () => resolve(),
      );
      if (!sub) resolve();
    });
    finished = true;
    clearInterval(ping);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}
