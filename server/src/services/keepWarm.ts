import type { CanvasGraph } from '@hivemind/shared';
import { db } from '../db/index.js';
import { describe } from '../errors.js';
import { sameModel } from '../events/runs.js';
import { adapterFor, originOf, type ProviderRow } from '../api/providers.js';
import { runLimits } from './runLimits.js';

/**
 * H36.2a: models kept in RAM for good come back when Ollama throws them out.
 * Ollama can't be told "never evict this one": when a GPU model doesn't fit, it unloads the other loaded models too,
 * also a CPU-only one that frees no VRAM. Every minute, each model a canvas uses on a CPU-only Ollama provider with a
 * keepAlive of 24 hours or more is loaded again in the background when it is missing from /api/ps, with the canvas's
 * own context size (another one would be a second load).
 */

export interface WarmState {
  /** Reloads since midnight, and the last one (ms). */
  reloads: number;
  lastAt?: number;
  day: string;
  error?: string;
}

const state = new Map<string, WarmState>();
const key = (baseUrl: string, model: string) => `${originOf(baseUrl)}|${model.toLowerCase()}`;
const today = () => new Date().toDateString();

/** Hours a keepAlive stands for ("24h", "8760h", "-1" = forever); undefined when it isn't one. */
export function keepHours(v: unknown): number | undefined {
  const t = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (t === '-1') return Infinity;
  const m = /^(\d{1,6})(s|m|h)$/.exec(t);
  if (!m) return undefined;
  return Number(m[1]) / (m[2] === 'h' ? 1 : m[2] === 'm' ? 60 : 3600);
}

interface Target {
  row: ProviderRow;
  model: string;
  keepAlive: string;
  numCtx?: number;
}

/** Every (CPU-only provider, model, context) a canvas keeps for 24 hours or more. */
export function warmTargets(): Target[] {
  const rows = new Map(
    (db.prepare("SELECT * FROM providers WHERE kind = 'ollama' AND enabled = 1 AND local = 1 AND cpu_only = 1").all() as unknown as ProviderRow[]).map((r) => [r.id, r]),
  );
  if (!rows.size) return [];
  const limits = runLimits();
  const out = new Map<string, Target>();
  for (const c of db.prepare('SELECT cast(graph as text) AS graph FROM canvases').all() as { graph: string }[]) {
    let g: CanvasGraph;
    try {
      g = JSON.parse(c.graph);
    } catch {
      continue;
    }
    for (const n of g.nodes ?? []) {
      const cfg = (n.config ?? {}) as { model?: { providerId?: string; model?: string }; keepAlive?: string; numCtx?: number };
      const row = cfg.model?.providerId ? rows.get(cfg.model.providerId) : undefined;
      if (!row || !cfg.model?.model || (keepHours(cfg.keepAlive) ?? 0) < 24) continue;
      const numCtx = cfg.numCtx && Number.isFinite(cfg.numCtx) ? Math.round(Math.min(131072, Math.max(2048, cfg.numCtx))) : limits.numCtx;
      out.set(`${row.id}|${cfg.model.model}|${numCtx}`, { row, model: cfg.model.model, keepAlive: cfg.keepAlive!, numCtx });
    }
  }
  return [...out.values()];
}

let busy = false;

/** One check: reload what is missing. Returns the models it reloaded. */
export async function keepWarmTick(): Promise<string[]> {
  if (busy) return [];
  busy = true;
  const reloaded: string[] = [];
  try {
    const byServer = new Map<string, Target[]>();
    for (const t of warmTargets()) byServer.set(originOf(t.row.base_url), [...(byServer.get(originOf(t.row.base_url)) ?? []), t]);
    for (const targets of byServer.values()) {
      const adapter = adapterFor(targets[0].row);
      let loaded: { model: string }[];
      try {
        loaded = (await adapter.loaded?.()) ?? [];
      } catch {
        continue; // Ollama down: nothing to do now
      }
      for (const t of targets) {
        if (loaded.some((m) => sameModel(m.model, t.model))) continue;
        const k = key(t.row.base_url, t.model);
        const s = state.get(k);
        const st: WarmState = s && s.day === today() ? s : { reloads: 0, day: today() };
        try {
          await adapterFor(t.row).warm?.(t.model, t.keepAlive, t.numCtx);
          st.reloads++;
          st.lastAt = Date.now();
          delete st.error;
          reloaded.push(t.model);
        } catch (err) {
          st.error = describe(err).message.slice(0, 200);
        }
        state.set(k, st);
      }
    }
  } finally {
    busy = false;
  }
  return reloaded;
}

/** What the loaded-models list shows for a model: kept warm, and how often it had to come back today. */
export function warmInfo(baseUrl: string, model: string): { reloads: number; lastAt?: number; error?: string } | undefined {
  const t = warmTargets().some((x) => originOf(x.row.base_url) === originOf(baseUrl) && sameModel(x.model, model));
  if (!t) return undefined;
  const s = state.get(key(baseUrl, model)) ?? [...state.entries()].find(([k]) => k.startsWith(`${originOf(baseUrl)}|`) && sameModel(k.split('|')[1], model))?.[1];
  if (!s || s.day !== today()) return { reloads: 0 };
  return { reloads: s.reloads, lastAt: s.lastAt, ...(s.error && { error: s.error }) };
}

export function startKeepWarm() {
  setInterval(() => void keepWarmTick().catch(() => {}), 60_000).unref();
}
