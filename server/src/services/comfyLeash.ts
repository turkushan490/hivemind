// Rollout R3b: ComfyUI on a leash. ComfyUI keeps its image models in GPU memory after a picture (it held 12.9 GB of the
// T4's 16 GB on 2026-11-22, and a chat model then crashed with "cudaMalloc failed"). HiveMind's own image blocks already
// free it when a chat model doesn't fit, but ComfyUI used directly (its own screen, the prompt maker) never let go.
// Every minute: a ComfyUI with nothing in its queue for N minutes (Settings → Access, default 3, 0 = off) is told to
// unload its models (POST /free). It loads them again by itself for the next picture.
import { db, getSetting, setSetting } from '../db/index.js';
import { appendLog } from '../logfile.js';

const KEY = 'comfy-idle-free-min';
const DEFAULT_MIN = 3;

export function comfyIdleFreeMin(): number {
  const v = getSetting(KEY);
  const n = v === undefined ? DEFAULT_MIN : Number(v);
  return Number.isFinite(n) ? n : DEFAULT_MIN;
}

export function setComfyIdleFreeMin(n: number): void {
  setSetting(KEY, String(Math.max(0, Math.min(120, Math.round(n)))));
}

const state = new Map<string, { idleSince: number; freed: boolean }>();

/** One check of every ComfyUI (exported for tests). */
export async function comfyLeashTick(now = Date.now()): Promise<string[]> {
  const freed: string[] = [];
  const min = comfyIdleFreeMin();
  if (min <= 0) return freed;
  const rows = db.prepare("SELECT id, base_url FROM providers WHERE kind = 'comfyui' AND enabled = 1").all() as { id: string; base_url: string }[];
  for (const r of rows) {
    const base = r.base_url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/queue`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const q = (await res.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
      const s = state.get(r.id) ?? { idleSince: now, freed: false };
      state.set(r.id, s);
      if ((q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0) > 0) {
        s.idleSince = now;
        s.freed = false;
        continue;
      }
      if (s.freed || now - s.idleSince < min * 60_000) continue;
      await fetch(`${base}/free`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(20_000),
      });
      s.freed = true;
      freed.push(r.id);
      appendLog('server', `ComfyUI "${r.id}" had nothing to do for ${min} min: its models were unloaded to free the GPU`);
    } catch {
      // ComfyUI not running: nothing to free
    }
  }
  return freed;
}

export function startComfyLeash(): void {
  setInterval(() => void comfyLeashTick(), 60_000).unref();
}
