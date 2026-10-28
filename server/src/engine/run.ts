import type { CanvasGraph, CanvasNode, ModelInfo, ModelRef, OutputFile, RunEvent, RunStatus } from '@hivemind/shared';
import { NODES, type ChatContext, type NodeInput, type NodeServices } from '../nodes/index.js';
import type { ChatMessage, ProviderAdapter } from '../providers/types.js';
import { callCost } from '../services/pricing.js';
import { validateGraph } from './graph.js';

export interface ResolvedProvider {
  adapter: ProviderAdapter;
  /** Runs on local hardware (shows the GPU bar). */
  local: boolean;
  /** Local and not switched to parallel: one job at a time per host (VRAM). */
  exclusive?: boolean;
  hostKey: string;
  modelInfo(model: string): Promise<ModelInfo | undefined>;
  /** Remembered timings per model on this provider, to show real progress next time. */
  stats?: {
    expectLoad(model: string, sizeBytes?: number): { ms: number; estimated: boolean };
    record(model: string, s: { loadMs?: number; tokensPerSec?: number }): void;
  };
}

/** One model call: what it used and cost (for the Stats page). */
export interface UsageRecord {
  nodeId: string;
  nodeType: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD; undefined when the price is unknown. */
  cost?: number;
  /** Pure generation time, when the provider reports it. */
  genMs?: number;
}

/** A Judge or Vote picked the best of the answers wired into it. */
export interface WinnerRecord {
  nodeId: string;
  nodeType: string;
  /** The winning upstream block, its name and model. */
  winnerNodeId: string;
  winnerLabel: string;
  winnerModel?: string;
  /** Model (or block name) of every answer it chose from, the winner included. */
  contenders: string[];
}

export interface EngineDeps {
  resolve(providerId: string): Promise<ResolvedProvider>;
  emit(ev: Omit<RunEvent, 'seq' | 'ts' | 'runId'>): void;
  services?: NodeServices;
  /** Gets every model call and every Judge/Vote pick, to store for stats. */
  record?: {
    usage(u: UsageRecord): void;
    winner(w: WinnerRecord): void;
  };
}

export interface RunResult {
  status: RunStatus;
  final?: string;
  cost: number;
}

/** One lock per local host, so a 16 GB GPU never loads two models at once. */
const hostLocks = new Map<string, Promise<void>>();

async function withHostLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  hostLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (hostLocks.get(key) === chained) hostLocks.delete(key);
  }
}

/** Context size within what Ollama accepts; undefined = the model's own default. */
const numCtxOf = (node: CanvasNode) => {
  const n = node.config.numCtx;
  return n && Number.isFinite(n) ? Math.round(Math.min(131072, Math.max(2048, n))) : undefined;
};

export async function runGraph(
  graph: CanvasGraph,
  question: string,
  deps: EngineDeps,
  signal: AbortSignal,
  vars: Record<string, string> = {},
  chat: ChatContext = { system: '', history: [] },
): Promise<RunResult> {
  validateGraph(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parents = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  const children = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    parents.get(e.target)!.push(e.source);
    children.get(e.source)!.push(e.target);
  }

  const outputs = new Map<string, string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();
  /** Wires a Router did not choose ("source->target"). */
  const blocked = new Set<string>();
  const started = new Set<string>();
  const allFiles: OutputFile[] = [];
  let cost = 0;

  deps.emit({ type: 'run_start', graph, question });

  const runNode = async (node: CanvasNode): Promise<void> => {
    const def = NODES[node.type];
    const model = node.config.model;
    const base = { nodeId: node.id, nodeType: node.type, model: model?.model };
    const ps = parents.get(node.id)!;
    const usable = ps.filter((p) => outputs.has(p) && !blocked.has(`${p}->${node.id}`));
    const inputs: NodeInput[] = usable.map((p) => {
      const src = byId.get(p)!;
      return { nodeId: p, type: src.type, label: src.label || src.config.model?.model || src.type, text: outputs.get(p)! };
    });

    if (ps.length > 0 && usable.length === 0) {
      // Nothing to work with: skipped when a Router sent the run elsewhere, failed when inputs broke.
      if (ps.some((p) => failed.has(p))) {
        failed.add(node.id);
        deps.emit({ ...base, type: 'error', error: 'All inputs failed' });
      } else {
        skipped.add(node.id);
        deps.emit({ ...base, type: 'node_skipped' });
      }
      return;
    }

    // The block's main model decides the GPU lock: local blocks wait their turn on that GPU.
    const primary: ModelRef | undefined = model ?? node.config.models?.[0];
    const usesModels = def.usesModel || !!def.minModels;
    const provider = usesModels && primary ? await deps.resolve(primary.providerId).catch(() => undefined) : undefined;
    const heldHost = provider?.local && provider.exclusive !== false ? provider.hostKey : undefined;

    const exec = async () => {
      const t0 = Date.now();
      let firstToken = 0;
      let firstAnswer = 0;
      let tokens = 0;
      let genMs: number | undefined;
      let inputTokens: number | undefined;
      let nodeCost: number | undefined;
      let loading = false;
      let ready = false;
      let loadMs: number | undefined;
      let sizeBytes: number | undefined;
      const files: OutputFile[] = [];
      deps.emit({ ...base, type: 'node_start', ...(provider?.local && { local: true }) });
      const markReady = () => {
        if (ready) return;
        ready = true;
        deps.emit({ ...base, type: 'model_ready', warm: !loading });
      };

      const call = async (messages: ChatMessage[], ref: ModelRef, think?: boolean, json?: boolean): Promise<string> => {
        const p = await deps.resolve(ref.providerId);
        let out = '';
        let thought = false;
        let callLoad: number | undefined;
        let callTokens = 0;
        let callGen: number | undefined;
        let callIn = 0;
        let callCostUsd: number | undefined;
        for await (const chunk of p.adapter.stream({ model: ref.model, messages, temperature: node.config.temperature, think, json, numCtx: numCtxOf(node) }, signal)) {
          if (chunk.type === 'loading') {
            loading = true;
            sizeBytes = (await p.modelInfo(ref.model).catch(() => undefined))?.sizeBytes;
            const expect = p.stats?.expectLoad(ref.model, sizeBytes);
            deps.emit({ ...base, type: 'model_loading', model: ref.model, sizeBytes, expectedMs: expect?.ms, estimated: expect?.estimated });
          } else if (chunk.type === 'warm') {
            sizeBytes ??= (await p.modelInfo(ref.model).catch(() => undefined))?.sizeBytes;
          } else if (chunk.type === 'thinking') {
            thought = true;
            markReady();
            if (!firstToken) firstToken = Date.now();
            deps.emit({ ...base, type: 'thinking', model: ref.model, text: chunk.text });
          } else if (chunk.type === 'token') {
            markReady();
            if (!firstToken) firstToken = Date.now();
            // Live speed counts from the first word of the answer, not from the start of thinking.
            if (!firstAnswer) firstAnswer = Date.now();
            tokens++;
            callTokens++;
            out += chunk.text;
            const secs = (Date.now() - firstAnswer) / 1000;
            deps.emit({ ...base, type: 'token', model: ref.model, text: chunk.text, tokens, tokensPerSec: secs > 0.2 ? tokens / secs : undefined });
          } else {
            // Prefer the provider's exact token count over the number of chunks.
            if (chunk.outputTokens) {
              tokens += chunk.outputTokens - callTokens;
              callTokens = chunk.outputTokens;
            }
            if (chunk.genMs) {
              genMs = (genMs ?? 0) + chunk.genMs;
              callGen = chunk.genMs;
            }
            // Only a real load is worth remembering (a warm model reports a few ms).
            if (chunk.loadMs && chunk.loadMs > 300) callLoad = chunk.loadMs;
            if (callLoad && loadMs === undefined) loadMs = callLoad;
            inputTokens = (inputTokens ?? 0) + (chunk.inputTokens ?? 0);
            callIn += chunk.inputTokens ?? 0;
            // Provider prices first (OpenRouter), then the pricing table (OpenAI, Anthropic); free models cost 0.
            const info = await p.modelInfo(ref.model).catch(() => undefined);
            const c = callCost(info, ref.model, chunk.inputTokens ?? 0, callTokens);
            if (c !== undefined) {
              nodeCost = (nodeCost ?? 0) + c;
              callCostUsd = (callCostUsd ?? 0) + c;
            }
          }
        }
        try {
          deps.record?.usage({ nodeId: node.id, nodeType: node.type, providerId: ref.providerId, model: ref.model, inputTokens: callIn, outputTokens: callTokens, cost: callCostUsd, genMs: callGen });
        } catch {}
        p.stats?.record(ref.model, { loadMs: callLoad, tokensPerSec: callGen ? callTokens / (callGen / 1000) : undefined });
        // Small local thinking models sometimes think until they stop and never answer: ask once more without thinking.
        if (!out.trim() && thought && think === undefined && p.local && !signal.aborted) {
          deps.emit({ ...base, type: 'node_progress', note: 'Only thought, no answer — asking again without thinking' });
          return call(messages, ref, false, json);
        }
        return out;
      };

      const text = await def.execute({
        node,
        question,
        vars,
        chat,
        inputs,
        outgoing: children.get(node.id)!.map((id) => {
          const n = byId.get(id)!;
          return { id, label: n.label || n.type, type: n.type };
        }),
        callModel: async (messages, ref, opts) => {
          const m = ref ?? primary;
          const json = opts?.json;
          if (!m) throw new Error('This block has no model');
          const p = await deps.resolve(m.providerId);
          // Another AI server on the same GPU (ComfyUI) gives its memory back before a local model loads.
          if (p.local && p.exclusive !== false) await deps.services?.freeGpu?.(p.hostKey, m.providerId).catch(() => {});
          // A different local GPU than the one this block holds: wait for that GPU too.
          if (p.local && p.exclusive !== false && p.hostKey !== heldHost) return withHostLock(p.hostKey, () => call(messages, m, undefined, json));
          return call(messages, m, undefined, json);
        },
        choose: (ids) => {
          for (const c of children.get(node.id)!) if (!ids.includes(c)) blocked.add(`${node.id}->${c}`);
        },
        progress: (note) => deps.emit({ ...base, type: 'node_progress', note }),
        pickWinner: (winnerId, contenderIds) => {
          const nameOf = (id: string) => {
            const n = byId.get(id);
            return n ? n.config.model?.model ?? n.label ?? n.type : id;
          };
          const w = byId.get(winnerId);
          if (!w) return;
          try {
            deps.record?.winner({
              nodeId: node.id,
              nodeType: node.type,
              winnerNodeId: winnerId,
              winnerLabel: w.label || w.config.model?.model || w.type,
              winnerModel: w.config.model?.model,
              contenders: contenderIds.map(nameOf),
            });
          } catch {}
        },
        attach: (f) => {
          files.push(f);
          allFiles.push(f);
        },
        generateImage: async (prompt) => {
          if (!primary) throw new Error('Pick an image model for this block');
          const p = await deps.resolve(primary.providerId);
          if (!p.adapter.image) throw new Error(`${primary.model} cannot make images — pick an image model (ComfyUI or an image API)`);
          if (!deps.services?.saveFile) throw new Error('Saving images is not available here');
          // On a shared GPU, Ollama's idle models are cleared first so the image model fits.
          if (p.local && p.exclusive !== false) await deps.services.freeGpu?.(p.hostKey, primary.providerId).catch(() => {});
          const c = node.config;
          const images = await p.adapter.image(
            { model: primary.model, prompt, negative: c.negative, width: c.width ?? 1024, height: c.height ?? 1024, steps: c.steps, cfg: c.cfg, lora: c.lora, loraStrength: c.loraStrength },
            signal,
            (note) => {
              markReady();
              deps.emit({ ...base, type: 'node_progress', note });
            },
          );
          markReady();
          const saved = images.map((img, i) =>
            deps.services!.saveFile!(`outputs/image-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${images.length > 1 ? `-${i + 1}` : ''}.${img.ext}`, img.data),
          );
          for (const f of saved) {
            files.push(f);
            allFiles.push(f);
          }
          return saved;
        },
        services: deps.services ?? {},
        signal,
      });

      // A model that only "thought" (or returned nothing) must not pass an empty answer on to the judge.
      if (usesModels && !text.trim()) throw new Error('The model returned no answer (it may have spent everything on thinking)');
      outputs.set(node.id, text);
      if (nodeCost) cost += nodeCost;
      // Provider-reported generation time is exact; otherwise time since the first token (incl. thinking).
      const genSecs = genMs ? genMs / 1000 : firstToken ? (Date.now() - firstToken) / 1000 : 0;
      deps.emit({
        ...base,
        type: 'node_done',
        label: node.label || node.id,
        ...(files.length && { files }),
        text,
        tokens: usesModels ? tokens : undefined,
        inputTokens,
        tokensPerSec: genSecs > 0 ? tokens / genSecs : undefined,
        cost: nodeCost,
        elapsedMs: Date.now() - t0,
        loadMs,
        sizeBytes,
      });
    };

    try {
      if (heldHost) {
        deps.emit({ ...base, type: 'node_queued' });
        await withHostLock(heldHost, exec);
        return;
      }
      await exec();
    } catch (err) {
      failed.add(node.id);
      deps.emit({ ...base, type: 'error', error: signal.aborted ? 'Cancelled' : (err as Error).message });
    }
  };

  // Start every node as soon as all its parents are finished (done, failed or skipped).
  await new Promise<void>((resolve) => {
    let running = 0;
    const tick = () => {
      for (const n of graph.nodes) {
        if (started.has(n.id)) continue;
        if (!parents.get(n.id)!.every((p) => outputs.has(p) || failed.has(p) || skipped.has(p))) continue;
        started.add(n.id);
        running++;
        runNode(n).finally(() => {
          running--;
          tick();
        });
      }
      if (running === 0) resolve();
    };
    tick();
  });

  const outNodes = graph.nodes.filter((n) => n.type === 'output');
  // With output nodes, only they count; a failed judge must not pass off one council answer as final.
  const finalNode = outNodes.length
    ? outNodes.find((n) => outputs.has(n.id))
    : [...graph.nodes].reverse().find((n) => outputs.has(n.id) && n.type !== 'input');
  const final = finalNode ? outputs.get(finalNode.id) : undefined;
  // Partial failures still count as done when an answer came out; the error events show what broke.
  const status: RunStatus = signal.aborted ? 'cancelled' : final !== undefined ? 'done' : 'error';
  deps.emit({ type: 'run_done', status, final, cost, ...(allFiles.length && { files: allFiles }) });
  return { status, final, cost };
}
