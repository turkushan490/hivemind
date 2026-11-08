import type { CanvasGraph, CanvasNode, ModelInfo, ModelRef, OutputFile, RunEvent, RunLimits, RunStatus, SentCall } from '@hivemind/shared';
import { NODES, type ChatContext, type NodeInput, type NodeServices } from '../nodes/index.js';
import type { DecisionRequest, DecisionResult } from '../providers/decisions.js';
import type { ChatMessage, ProviderAdapter } from '../providers/types.js';
import { callCost } from '../services/pricing.js';
import { seesPictures } from '@hivemind/shared';
import { loopsOf, validateGraph, type Loop } from './graph.js';
import { itemLabel, listItems } from '../nodes/projects.js';

export interface ResolvedProvider {
  adapter: ProviderAdapter;
  /** Runs on local hardware (shows the GPU bar). */
  local: boolean;
  /** Local and not switched to parallel: one job at a time per host (VRAM). */
  exclusive?: boolean;
  hostKey: string;
  /** Seconds a call may take when the block sets none (slow providers like colibri); else the run limit. */
  callSeconds?: number;
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
  /** Settings → Run limits; default 600 s per call, 4096 tokens and a 16K context on local models. */
  limits?: RunLimits;
  /** Who this run is, for "Waiting for the GPU behind …" ("DungeonMind", a workflow name); the block's name is added. */
  lockLabel?: string;
  /**
   * Settings → Access: what the person who started the run may use. Checked again on every call, because Auto
   * model blocks and Routers pick models while the run goes. Left out: everything (engine tests).
   */
  access?: { model(providerId: string, model: string): boolean; lora(providerId: string, name: string): boolean };
  /** A run that goes on after a restart: what its blocks had already done. */
  resume?: Checkpoint;
  /** Called after every finished block (and every For each item), to store the run's progress. */
  save?(cp: Checkpoint): void;
  /** Settings → Pictures: the model that describes pictures for models that can't see (left out: none). */
  pictureReader?(): Promise<ModelRef | undefined>;
}

/** A run's progress, stored as it goes, so it can go on after a restart instead of starting over. */
export interface Checkpoint {
  outputs: Record<string, string>;
  failed: string[];
  skipped: string[];
  blocked: string[];
  /** For each blocks part-way through their items: the results so far. */
  loops: Record<string, { results: string[]; ok: number }>;
}

/** The message a refused model or LoRA gives (the same as at the start of a run). */
const refused = (what: string) => Object.assign(new Error(`You can't use ${what} (ask the admin to add it to your access)`), { statusCode: 403 });

export interface RunResult {
  status: RunStatus;
  final?: string;
  cost: number;
}

/** Settings → Run limits when nothing is saved (services/runLimits.ts). 600 s: a cold load counts, and a slow model needs ~400 s for 4096 tokens. */
export const DEFAULT_LIMITS: RunLimits = { maxSeconds: 600, maxTokens: 4096, numCtx: 16384 };

/** One lock per local host, so a 16 GB GPU never loads two models at once. */
const hostLocks = new Map<string, Promise<void>>();
/** Who holds each host's lock right now ("DungeonMind: chronicler", "Training: dm-v3"). */
const holders = new Map<string, { label?: string }>();

/** The label of whoever holds this host's GPU right now. */
export const hostHolder = (key: string): string | undefined => holders.get(key)?.label;

/** The text a cancelled run shows: the reason given to abort() ("Stopped by Unload"), else "Cancelled". */
export const cancelText = (signal: AbortSignal): string => (typeof signal.reason === 'string' && signal.reason ? signal.reason : 'Cancelled');

/**
 * Runs fn once every earlier job on this host is done. With a signal, a cancel while waiting rejects at once
 * with "Cancelled"; the queue stays intact (this slot is let go only after the job in front of it ends).
 */
export async function withHostLock<T>(key: string, fn: () => Promise<T>, opts: { signal?: AbortSignal; label?: string } = {}): Promise<T> {
  const prev = hostLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  hostLocks.set(key, chained);
  const letGo = () => {
    release();
    if (hostLocks.get(key) === chained) hostLocks.delete(key);
  };
  const { signal } = opts;
  if (signal) {
    let onAbort!: () => void;
    const aborted = new Promise<'aborted'>((r) => {
      onAbort = () => r('aborted');
      if (signal.aborted) r('aborted');
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    const got = await Promise.race([prev.then(() => 'ready' as const), aborted]);
    signal.removeEventListener('abort', onAbort);
    if (got === 'aborted') {
      // Never skip the queue: later jobs still wait for the one in front of this slot.
      void prev.then(letGo);
      throw new Error('Cancelled');
    }
  } else {
    await prev;
  }
  const holder = { label: opts.label };
  holders.set(key, holder);
  try {
    return await fn();
  } finally {
    if (holders.get(key) === holder) holders.delete(key);
    letGo();
  }
}

/** Context size within what Ollama accepts; a block without one gets the run limit on local models, else the model's own default. */
const numCtxOf = (node: CanvasNode, limits: RunLimits, isLocal: boolean) => {
  const n = node.config.numCtx;
  if (n && Number.isFinite(n)) return Math.round(Math.min(131072, Math.max(2048, n)));
  return isLocal ? limits.numCtx : undefined;
};

/** Answer length cap (16 to 32768 tokens); a block without one gets the run limit on local models, else no cap. */
const maxTokensOf = (node: CanvasNode, limits: RunLimits, isLocal: boolean) => {
  const n = node.config.maxTokens;
  if (n && Number.isFinite(n)) return Math.round(Math.min(32768, Math.max(16, n)));
  return isLocal ? limits.maxTokens : undefined;
};

/** Picture links in a message: ![name](hm-file:folder/x.png). */
const IMAGE_LINK = /!\[([^\]]*)\]\(hm-file:([^)\s]+\.(?:png|jpe?g|webp|gif))\)/gi;

/**
 * The pictures linked in the last user message (attached in the question box) become images on that message, at
 * most 4 and 20 MB each; the links in the text become "[image: name]". Pictures that can't be read are left as text.
 */
export function withImages(messages: ChatMessage[], readFile?: (path: string) => Buffer): ChatMessage[] {
  if (!readFile) return messages;
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0 || !IMAGE_LINK.test(messages[i].content)) return messages;
  IMAGE_LINK.lastIndex = 0;
  const images: { data: Buffer; ext: string }[] = [];
  const content = messages[i].content.replace(IMAGE_LINK, (all, name: string, path: string) => {
    if (images.length >= 4) return all;
    try {
      const data = readFile(decodeURIComponent(path));
      if (data.length > 20 * 1024 * 1024) return all;
      images.push({ data, ext: path.split('.').pop()!.toLowerCase() });
      return `[image: ${name || path.split('/').pop()}]`;
    } catch {
      return all;
    }
  });
  if (!images.length) return messages;
  return messages.map((m, j) => (j === i ? { ...m, content, images } : m));
}

const stripImages = (messages: ChatMessage[]): ChatMessage[] => messages.map(({ images, ...m }) => m);

/** What the picture reader is asked for every picture. */
export const READ_PICTURE =
  'Describe this picture for someone who cannot see it, so they can answer questions about it. ' +
  'Write down every bit of text in it exactly as written (code, error messages, labels, numbers), then describe what is shown: ' +
  'layout, objects, people, colours, charts and anything unusual. Plain text, no preamble.';

/** The picture links in the last user message. */
export function pictureLinks(messages: ChatMessage[]): { all: string; name: string; path: string }[] {
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return [];
  return [...messages[i].content.matchAll(IMAGE_LINK)].slice(0, 4).map((m) => ({ all: m[0], name: m[1] || m[2].split('/').pop()!, path: m[2] }));
}

/** Replaces the picture links in the last user message with what the reader wrote about each. */
export function withDescriptions(messages: ChatMessage[], described: Map<string, string>, reader: string): ChatMessage[] {
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return messages;
  const content = messages[i].content.replace(IMAGE_LINK, (all, name: string, path: string) => {
    const d = described.get(path);
    return d ? `[Picture "${name || path.split('/').pop()}", described by ${reader}:
${d.trim()}
]` : all;
  });
  return messages.map((m, j) => (j === i ? { ...m, content } : m));
}

/** Seconds one model call may take: the block's own (10 to 86400) wins over the run limit. */
const maxSecondsOf = (node: CanvasNode, limits: RunLimits, provider?: { callSeconds?: number }) => {
  const n = node.config.maxSeconds;
  if (n && Number.isFinite(n)) return Math.round(Math.min(86400, Math.max(10, n)));
  return provider?.callSeconds ? Math.max(limits.maxSeconds, provider.callSeconds) : limits.maxSeconds;
};

/** A model call that ran past its time limit (not a cancel: the run goes on, the block fails). */
class TimeLimitError extends Error {}

/** An abort signal that fires after `seconds`, or with the run's own signal. */
function callTimer(signal: AbortSignal, seconds: number) {
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), seconds * 1000);
  const both = AbortSignal.any([signal, timer.signal]);
  /** Rejects when either fires, so a provider that ignores its signal can't hang the block. */
  const stopped = new Promise<never>((_, reject) => {
    const fire = () => reject(new Error('aborted'));
    if (both.aborted) fire();
    else both.addEventListener('abort', fire, { once: true });
  });
  stopped.catch(() => {});
  return { signal: both, timedOut: () => timer.signal.aborted && !signal.aborted, stopped, clear: () => clearTimeout(t) };
}

export async function runGraph(
  graph: CanvasGraph,
  question: string,
  deps: EngineDeps,
  signal: AbortSignal,
  vars: Record<string, string> = {},
  chat: ChatContext = { system: '', history: [] },
): Promise<RunResult> {
  validateGraph(graph);
  const limits = deps.limits ?? DEFAULT_LIMITS;
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
  if (deps.resume) {
    for (const [id, text] of Object.entries(deps.resume.outputs)) if (byId.has(id)) outputs.set(id, text);
    for (const id of deps.resume.failed) failed.add(id);
    for (const id of deps.resume.skipped) skipped.add(id);
    for (const key of deps.resume.blocked) blocked.add(key);
  }
  const loopProgress = new Map<string, { results: string[]; ok: number }>(Object.entries(deps.resume?.loops ?? {}));
  // Pictures the reader already described in this run (path → text): every block that can't see shares them.
  const described = new Map<string, Promise<string | undefined>>();
  // Models that refused pictures in this run although they looked like they could see.
  const blind = new Set<string>();
  /** The picture reader looks at one picture and writes what it sees (at most 5 minutes). */
  const readPicture = async (path: string, reader: ModelRef): Promise<string | undefined> => {
    const data = deps.services!.readFile!(decodeURIComponent(path));
    if (data.length > 20 * 1024 * 1024) throw new Error('the picture is larger than 20 MB');
    const p = await deps.resolve(reader.providerId);
    const timer = callTimer(signal, 300);
    let out = '';
    try {
      const it = p.adapter.stream(
        { model: reader.model, messages: [{ role: 'user', content: READ_PICTURE, images: [{ data, ext: path.split('.').pop()!.toLowerCase() }] }], think: false, maxTokens: 1500, numCtx: p.local ? limits.numCtx : undefined, keepAlive: '30m' },
        timer.signal,
      )[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([it.next(), timer.stopped]);
        if (next.done) break;
        if (next.value.type === 'token') out += next.value.text;
      }
    } finally {
      timer.clear();
    }
    return out.trim() || undefined;
  };
  const allFiles: OutputFile[] = [];
  let cost = 0;

  // A run going on after a restart already has its start in the stored events.
  if (!deps.resume) deps.emit({ type: 'run_start', graph, question });
  const allowed = (ref: ModelRef) => !deps.access || deps.access.model(ref.providerId, ref.model);
  const mayUse = (ref: ModelRef) => {
    if (!allowed(ref)) throw refused(ref.model);
  };

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
    const blockName = node.label || model?.model || node.type;
    const lockLabel = deps.lockLabel ? `${deps.lockLabel}: ${blockName}` : blockName;

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
      // What the last chat call sent (GET /api/runs/:id?inputs=1).
      let sent: SentCall | undefined;
      const files: OutputFile[] = [];
      deps.emit({ ...base, type: 'node_start', ...(provider?.local && { local: true }) });
      const markReady = () => {
        if (ready) return;
        ready = true;
        deps.emit({ ...base, type: 'model_ready', warm: !loading });
      };

      const call = async (messages: ChatMessage[], ref: ModelRef, think?: boolean, json?: boolean, noImages = false): Promise<string> => {
        const p = await deps.resolve(ref.providerId);
        const asked = messages;
        // A model that can't see gets the picture reader's description of each picture in place of the picture.
        if (!noImages && node.config.pictures !== 'direct' && deps.services?.readFile && deps.pictureReader) {
          const links = pictureLinks(messages);
          if (links.length && (blind.has(`${ref.providerId}/${ref.model}`) || !seesPictures(ref.model, await p.modelInfo(ref.model).catch(() => undefined)))) {
            const reader = await deps.pictureReader().catch(() => undefined);
            if (reader && !(reader.providerId === ref.providerId && reader.model === ref.model) && allowed(reader)) {
              deps.emit({ ...base, type: 'node_progress', note: `${ref.model} can't see pictures — ${reader.model} describes ${links.length === 1 ? 'the picture' : `${links.length} pictures`} first` });
              const texts = new Map<string, string>();
              for (const l of links) {
                if (!described.has(l.path)) described.set(l.path, readPicture(l.path, reader).catch((err) => {
                  deps.emit({ ...base, type: 'node_progress', note: `${reader.model} could not read ${l.name}: ${(err as Error).message.slice(0, 160)}` });
                  return undefined;
                }));
                const d = await described.get(l.path)!;
                if (d) texts.set(l.path, d);
              }
              if (texts.size) {
                messages = withDescriptions(messages, texts, reader.model);
                noImages = true;
              }
            }
          }
        }
        // Pictures in the question (attached in the question box) go with the message to models that can see.
        if (!noImages) messages = withImages(messages, deps.services?.readFile);
        const pictures = messages.some((m) => m.images?.length);
        sent = { providerId: ref.providerId, model: ref.model, messages: messages.map(({ images, ...m }) => ({ ...m, ...(images?.length && { content: `${m.content}\n[${images.length} image${images.length === 1 ? '' : 's'}]` }) })) };
        let out = '';
        let thought = false;
        let callLoad: number | undefined;
        let callTokens = 0;
        let callGen: number | undefined;
        let callIn = 0;
        let callCostUsd: number | undefined;
        const maxTokens = maxTokensOf(node, limits, p.local);
        const limitSecs = maxSecondsOf(node, limits, p);
        // The clock starts here, once the GPU is held: time in the queue doesn't count.
        const timer = callTimer(signal, limitSecs);
        const it = p.adapter.stream({ model: ref.model, messages, temperature: node.config.temperature, think, json, numCtx: numCtxOf(node, limits, p.local), maxTokens, keepAlive: node.config.keepAlive }, timer.signal)[Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await Promise.race([it.next(), timer.stopped]);
            if (next.done) break;
            const chunk = next.value;
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
              if (chunk.stopped === 'length') deps.emit({ ...base, type: 'node_progress', note: maxTokens ? `Stopped at the ${maxTokens}-token limit` : 'Stopped at the token limit' });
            }
          }
        } catch (err) {
          if (timer.timedOut()) throw new TimeLimitError(`${ref.model} was stopped after ${limitSecs} seconds`);
          if (signal.aborted) throw new Error(cancelText(signal));
          // A model that can't see refuses the pictures: ask once more with the text alone.
          if (pictures && !out) {
            timer.clear();
            // With a picture reader: it describes the pictures instead, so the model still knows what is in them.
            const key = `${ref.providerId}/${ref.model}`;
            if (deps.pictureReader && node.config.pictures !== 'direct' && !blind.has(key)) {
              blind.add(key);
              deps.emit({ ...base, type: 'node_progress', note: `${ref.model} can't read images (${(err as Error).message.slice(0, 120)}) — the picture reader describes them` });
              return call(asked, ref, think, json, false);
            }
            deps.emit({ ...base, type: 'node_progress', note: `${ref.model} can't read images (${(err as Error).message.slice(0, 120)}) — asking with the text only` });
            return call(stripImages(messages), ref, think, json, true);
          }
          throw err;
        } finally {
          timer.clear();
          // Stop the provider's request too (a hanging fetch to Ollama), without waiting for it.
          if (timer.signal.aborted) void Promise.resolve(it.return?.()).catch(() => {});
        }
        try {
          deps.record?.usage({ nodeId: node.id, nodeType: node.type, providerId: ref.providerId, model: ref.model, inputTokens: callIn, outputTokens: callTokens, cost: callCostUsd, genMs: callGen });
        } catch {}
        p.stats?.record(ref.model, { loadMs: callLoad, tokensPerSec: callGen ? callTokens / (callGen / 1000) : undefined });
        // Small local thinking models sometimes think until they stop and never answer: ask once more without thinking.
        if (!out.trim() && thought && think === undefined && p.local && !signal.aborted) {
          deps.emit({ ...base, type: 'node_progress', note: 'Only thought, no answer — asking again without thinking' });
          return call(messages, ref, false, json, noImages);
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
          mayUse(m);
          const p = await deps.resolve(m.providerId);
          // Another AI server on the same GPU (ComfyUI) gives its memory back before a local model loads, when it wouldn't fit.
          if (p.local && p.exclusive !== false) await deps.services?.freeGpu?.(p.hostKey, m.providerId, { model: m.model, bytes: (await p.modelInfo(m.model).catch(() => undefined))?.sizeBytes }).catch(() => {});
          // A different local GPU than the one this block holds: wait for that GPU too.
          if (p.local && p.exclusive !== false && p.hostKey !== heldHost)
            return withHostLock(p.hostKey, () => call(messages, m, node.config.think === false ? false : undefined, json), { signal, label: lockLabel });
          return call(messages, m, node.config.think === false ? false : undefined, json);
        },
        decide: async (req, ref) => {
          const m = ref ?? primary;
          if (!m) throw new Error('Pick a decision model for this block');
          mayUse(m);
          const p = await deps.resolve(m.providerId);
          if (!p.adapter.decide) throw new Error(`${m.model} is not a decision model — pick one from a decision provider (Settings → Providers → Decisions)`);
          const ask = async (): Promise<DecisionResult> => {
            // A local decision model (Ollama) shares the GPU like any other local model.
            if (p.local && p.exclusive !== false) await deps.services?.freeGpu?.(p.hostKey, m.providerId, { model: m.model, bytes: (await p.modelInfo(m.model).catch(() => undefined))?.sizeBytes }).catch(() => {});
            const secs = maxSecondsOf(node, limits, p);
            const timer = callTimer(signal, secs);
            let r: DecisionResult;
            try {
              r = await Promise.race([p.adapter.decide!({ model: m.model, ...(node.config.keepAlive && { keepAlive: node.config.keepAlive }), ...req } as DecisionRequest, timer.signal), timer.stopped]);
            } catch (err) {
              if (timer.timedOut()) throw new TimeLimitError(`${m.model} was stopped after ${secs} seconds`);
              if (signal.aborted) throw new Error(cancelText(signal));
              throw err;
            } finally {
              timer.clear();
            }
            markReady();
            const info = await p.modelInfo(m.model).catch(() => undefined);
            const c = callCost(info, r.model, r.usage.inputTokens, r.usage.outputTokens) ?? callCost(info, m.model, r.usage.inputTokens, r.usage.outputTokens);
            if (c !== undefined) nodeCost = (nodeCost ?? 0) + c;
            inputTokens = (inputTokens ?? 0) + r.usage.inputTokens;
            try {
              deps.record?.usage({ nodeId: node.id, nodeType: node.type, providerId: m.providerId, model: m.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cost: c, genMs: r.ms });
            } catch {}
            return r;
          };
          if (p.local && p.exclusive !== false && p.hostKey !== heldHost) return withHostLock(p.hostKey, ask, { signal, label: lockLabel });
          return ask();
        },
        allowedModel: allowed,
        choose: (ids) => {
          for (const c of children.get(node.id)!) if (!ids.includes(c)) blocked.add(`${node.id}->${c}`);
        },
        progress: (note, decision) => deps.emit({ ...base, type: 'node_progress', note, ...(decision && { decision }) }),
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
          mayUse(primary);
          // A LoRA that isn't allowed fails the block (ComfyUI would load any name it has).
          if (node.config.lora && deps.access && !deps.access.lora(primary.providerId, node.config.lora)) throw refused(`the LoRA ${node.config.lora}`);
          const p = await deps.resolve(primary.providerId);
          if (!p.adapter.image) throw new Error(`${primary.model} cannot make images — pick an image model (ComfyUI or an image API)`);
          if (!deps.services?.saveFile) throw new Error('Saving images is not available here');
          // On a shared GPU, Ollama's idle models are cleared first so the image model fits.
          if (p.local && p.exclusive !== false) await deps.services.freeGpu?.(p.hostKey, primary.providerId).catch(() => {});
          const c = node.config;
          const images = await p.adapter.image(
            { model: primary.model, prompt, negative: c.negative, width: c.width ?? 1024, height: c.height ?? 1024, steps: c.steps, cfg: c.cfg, lora: c.lora, loraStrength: c.loraStrength, batch: c.batch },
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
        ...(sent && { sent }),
      });
    };

    try {
      if (heldHost) {
        deps.emit({ ...base, type: 'node_queued' });
        await withHostLock(heldHost, exec, { signal, label: lockLabel });
        return;
      }
      await exec();
    } catch (err) {
      failed.add(node.id);
      deps.emit({ ...base, type: 'error', error: signal.aborted && !(err instanceof TimeLimitError) ? cancelText(signal) : (err as Error).message });
    }
  };

  const finished = (id: string) => outputs.has(id) || failed.has(id) || skipped.has(id);

  /** Runs these blocks, each as soon as all its parents are finished (done, failed or skipped). */
  const schedule = (ids: string[], run: (n: CanvasNode) => Promise<void>) =>
    new Promise<void>((resolve) => {
      const mine = new Set<string>();
      let running = 0;
      const tick = () => {
        for (const id of ids) {
          if (mine.has(id)) continue;
          if (!parents.get(id)!.every(finished)) continue;
          mine.add(id);
          running++;
          run(byId.get(id)!).finally(() => {
            running--;
            tick();
          });
        }
        if (running === 0) resolve();
      };
      tick();
    });

  // For each … Collect: the blocks between them run once per item (runLoop), not in the main pass.
  const loops = loopsOf(graph);
  const inLoop = new Set(loops.flatMap((l) => [...l.body, l.collect]));

  const runLoop = async (loop: Loop): Promise<void> => {
    const node = byId.get(loop.foreach)!;
    const base = { nodeId: node.id, nodeType: node.type };
    const collect = byId.get(loop.collect)!;
    const cbase = { nodeId: collect.id, nodeType: collect.type };
    const ps = parents.get(node.id)!;
    const usable = ps.filter((p) => outputs.has(p) && !blocked.has(`${p}->${node.id}`));
    const bodyIds = graph.nodes.map((n) => n.id).filter((id) => loop.body.has(id));
    const skipAll = (why: 'skipped' | 'failed') => {
      for (const id of [node.id, ...bodyIds, collect.id]) {
        if (why === 'failed') failed.add(id);
        else skipped.add(id);
      }
      if (why === 'failed') {
        deps.emit({ ...base, type: 'error', error: 'All inputs failed' });
        deps.emit({ ...cbase, type: 'error', error: 'All inputs failed' });
      } else {
        deps.emit({ ...base, type: 'node_skipped' });
        deps.emit({ ...cbase, type: 'node_skipped' });
      }
    };
    if (ps.length > 0 && usable.length === 0) return skipAll(ps.some((p) => failed.has(p)) ? 'failed' : 'skipped');
    const text = usable.length ? usable.filter((p) => byId.get(p)!.type !== 'input').map((p) => outputs.get(p)!).join('\n\n') || question : question;
    const t0 = Date.now();
    deps.emit({ ...base, type: 'node_start' });
    const max = Math.max(1, Math.min(500, node.config.maxItems ?? 50));
    const all = listItems(text);
    const items = all.slice(0, max);
    if (!items.length) {
      failed.add(node.id);
      deps.emit({ ...base, type: 'error', error: 'For each: no items in what was wired in (a JSON list, or one item per line)' });
      for (const id of [...bodyIds, collect.id]) failed.add(id);
      deps.emit({ ...cbase, type: 'error', error: 'All inputs failed' });
      return;
    }
    if (all.length > max) deps.emit({ ...base, type: 'node_progress', note: `${all.length} items, only the first ${max} run (maxItems)` });
    // After a restart, the items that were already done are not run again.
    const progress = loopProgress.get(node.id) ?? { results: [], ok: 0 };
    loopProgress.set(node.id, progress);
    const results = progress.results;
    let ok = progress.ok;
    const feeding = parents.get(collect.id)!.filter((p) => loop.body.has(p));
    if (results.length) deps.emit({ ...base, type: 'node_progress', note: `Going on after a restart at item ${results.length + 1} of ${items.length}` });
    for (let i = results.length; i < items.length; i++) {
      if (signal.aborted) break;
      deps.emit({ ...base, type: 'node_progress', note: `Item ${i + 1} of ${items.length}: ${itemLabel(items[i])}` });
      // A fresh pass: the loop's blocks forget the last item.
      for (const id of bodyIds) {
        outputs.delete(id);
        failed.delete(id);
        skipped.delete(id);
      }
      for (const key of [...blocked]) if (loop.body.has(key.split('->')[0]) || key.startsWith(`${node.id}->`)) blocked.delete(key);
      outputs.set(node.id, items[i]);
      await schedule(bodyIds, runNode);
      const got = feeding.filter((p) => outputs.has(p)).map((p) => outputs.get(p)!);
      const broke = feeding.filter((p) => failed.has(p));
      if (got.length) ok++;
      results.push(`### Item ${i + 1}: ${itemLabel(items[i])}\n${got.length ? got.join('\n\n') : broke.length ? '(failed)' : '(skipped)'}`);
      progress.ok = ok;
      save();
    }
    loopProgress.delete(node.id);
    outputs.set(node.id, items.join('\n'));
    deps.emit({ ...base, type: 'node_done', label: node.label || node.id, text: `${items.length} item${items.length === 1 ? '' : 's'}`, elapsedMs: Date.now() - t0 });
    // The Collect block: every item's result, in order.
    deps.emit({ ...cbase, type: 'node_start' });
    if (signal.aborted) {
      failed.add(collect.id);
      deps.emit({ ...cbase, type: 'error', error: cancelText(signal) });
      return;
    }
    if (!ok) {
      failed.add(collect.id);
      deps.emit({ ...cbase, type: 'error', error: 'Every item failed' });
      return;
    }
    const joined = results.join('\n\n');
    outputs.set(collect.id, joined);
    deps.emit({ ...cbase, type: 'node_done', label: collect.label || collect.id, text: joined, elapsedMs: Date.now() - t0 });
  };

  const loopOf = new Map(loops.map((l) => [l.foreach, l]));
  const bodies = new Set(loops.flatMap((l) => [...l.body]));
  /** The run's progress without the blocks inside a loop (they are per item; the loop keeps its own results). */
  function save() {
    if (!deps.save) return;
    const keep = (id: string) => !bodies.has(id);
    try {
      deps.save({
        outputs: Object.fromEntries([...outputs].filter(([id]) => keep(id) && !loopProgress.has(id))),
        failed: [...failed].filter(keep),
        skipped: [...skipped].filter(keep),
        blocked: [...blocked].filter((k) => keep(k.split('->')[0])),
        loops: Object.fromEntries(loopProgress),
      });
    } catch {}
  }
  await schedule(
    // Blocks a restarted run already finished are not run again.
    graph.nodes.map((n) => n.id).filter((id) => !inLoop.has(id) && !finished(id)),
    async (n) => {
      const loop = loopOf.get(n.id);
      if (loop) await runLoop(loop);
      else await runNode(n);
      save();
    },
  );

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
