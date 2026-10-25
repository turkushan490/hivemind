import type { CanvasGraph, CanvasNode, ModelInfo, RunEvent, RunStatus } from '@hivemind/shared';
import { NODES, type NodeInput } from '../nodes/index.js';
import type { ProviderAdapter } from '../providers/types.js';
import { validateGraph } from './graph.js';

export interface ResolvedProvider {
  adapter: ProviderAdapter;
  /** Local providers run one job at a time per host (VRAM). */
  local: boolean;
  hostKey: string;
  modelInfo(model: string): Promise<ModelInfo | undefined>;
  /** Remembered timings per model on this provider, to show real progress next time. */
  stats?: {
    expectLoad(model: string, sizeBytes?: number): { ms: number; estimated: boolean };
    record(model: string, s: { loadMs?: number; tokensPerSec?: number }): void;
  };
}

export interface EngineDeps {
  resolve(providerId: string): Promise<ResolvedProvider>;
  emit(ev: Omit<RunEvent, 'seq' | 'ts' | 'runId'>): void;
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

export async function runGraph(graph: CanvasGraph, question: string, deps: EngineDeps, signal: AbortSignal): Promise<RunResult> {
  validateGraph(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parents = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) parents.get(e.target)!.push(e.source);

  const outputs = new Map<string, string>();
  const failed = new Set<string>();
  const started = new Set<string>();
  let cost = 0;

  deps.emit({ type: 'run_start', graph, question });

  const runNode = async (node: CanvasNode): Promise<void> => {
    const inputs: NodeInput[] = parents
      .get(node.id)!
      .filter((p) => outputs.has(p))
      .map((p) => {
        const src = byId.get(p)!;
        return { nodeId: p, type: src.type, label: src.label || src.config.model?.model || src.type, text: outputs.get(p)! };
      });
    const def = NODES[node.type];
    const model = node.config.model;
    const base = { nodeId: node.id, nodeType: node.type, model: model?.model };

    // A node only fails for missing input when every parent failed.
    if (parents.get(node.id)!.length > 0 && inputs.length === 0) {
      failed.add(node.id);
      deps.emit({ ...base, type: 'error', error: 'All inputs failed' });
      return;
    }

    const provider = def.usesModel ? await deps.resolve(model!.providerId).catch(() => undefined) : undefined;

    const exec = async () => {
      const t0 = Date.now();
      let firstToken = 0;
      let tokens = 0;
      let genMs: number | undefined;
      let inputTokens: number | undefined;
      let nodeCost: number | undefined;
      let loading = false;
      let ready = false;
      let loadMs: number | undefined;
      let sizeBytes: number | undefined;
      deps.emit({ ...base, type: 'node_start', ...(provider?.local && { local: true }) });
      const markReady = () => {
        if (ready) return;
        ready = true;
        deps.emit({ ...base, type: 'model_ready', warm: !loading });
      };

      const text = await def.execute({
        node,
        question,
        inputs,
        callModel: async (messages) => {
          const p = await deps.resolve(model!.providerId);
          let out = '';
          for await (const chunk of p.adapter.stream({ model: model!.model, messages, temperature: node.config.temperature }, signal)) {
            if (chunk.type === 'loading') {
              loading = true;
              sizeBytes = (await p.modelInfo(model!.model).catch(() => undefined))?.sizeBytes;
              const expect = p.stats?.expectLoad(model!.model, sizeBytes);
              deps.emit({ ...base, type: 'model_loading', sizeBytes, expectedMs: expect?.ms, estimated: expect?.estimated });
            } else if (chunk.type === 'warm') {
              sizeBytes = (await p.modelInfo(model!.model).catch(() => undefined))?.sizeBytes;
            } else if (chunk.type === 'thinking') {
              markReady();
              if (!firstToken) firstToken = Date.now();
              deps.emit({ ...base, type: 'thinking', text: chunk.text });
            }
            else if (chunk.type === 'token') {
              markReady();
              if (!firstToken) firstToken = Date.now();
              tokens++;
              out += chunk.text;
              const secs = (Date.now() - firstToken) / 1000;
              deps.emit({ ...base, type: 'token', text: chunk.text, tokens, tokensPerSec: secs > 0.2 ? tokens / secs : undefined });
            } else {
              if (chunk.outputTokens) tokens = chunk.outputTokens;
              if (chunk.genMs) genMs = (genMs ?? 0) + chunk.genMs;
              // Only a real load is worth remembering (a warm model reports a few ms).
              if (loading && chunk.loadMs && chunk.loadMs > 300) loadMs = chunk.loadMs;
              inputTokens = chunk.inputTokens;
              const info = await p.modelInfo(model!.model).catch(() => undefined);
              if (info?.free) nodeCost = 0;
              else if (info?.price) nodeCost = ((inputTokens ?? 0) * info.price.input + tokens * info.price.output) / 1e6;
            }
          }
          return out;
        },
      });

      // A model that only "thought" (or returned nothing) must not pass an empty answer on to the judge.
      if (def.usesModel && !text.trim()) throw new Error('The model returned no answer (it may have spent everything on thinking)');
      outputs.set(node.id, text);
      if (nodeCost) cost += nodeCost;
      // Provider-reported generation time is exact; otherwise time since the first token (incl. thinking).
      const genSecs = genMs ? genMs / 1000 : firstToken ? (Date.now() - firstToken) / 1000 : 0;
      if (provider?.stats && model) provider.stats.record(model.model, { loadMs, tokensPerSec: genSecs > 0 ? tokens / genSecs : undefined });
      deps.emit({
        ...base,
        type: 'node_done',
        text,
        tokens: def.usesModel ? tokens : undefined,
        inputTokens,
        tokensPerSec: genSecs > 0 ? tokens / genSecs : undefined,
        cost: nodeCost,
        elapsedMs: Date.now() - t0,
        loadMs,
        sizeBytes,
      });
    };

    try {
      if (def.usesModel) {
        const p = provider ?? (await deps.resolve(model!.providerId));
        if (p.local) {
          deps.emit({ ...base, type: 'node_queued' });
          await withHostLock(p.hostKey, exec);
          return;
        }
      }
      await exec();
    } catch (err) {
      failed.add(node.id);
      deps.emit({ ...base, type: 'error', error: signal.aborted ? 'Cancelled' : (err as Error).message });
    }
  };

  // Start every node as soon as all its parents are finished (done or failed).
  await new Promise<void>((resolve) => {
    let running = 0;
    const tick = () => {
      for (const n of graph.nodes) {
        if (started.has(n.id)) continue;
        if (!parents.get(n.id)!.every((p) => outputs.has(p) || failed.has(p))) continue;
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
  deps.emit({ type: 'run_done', status, final, cost });
  return { status, final, cost };
}
