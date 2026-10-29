import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import { cancelRun, subscribe } from '../events/runs.js';

/**
 * Batch run ("Run repeatedly"): one canvas, run again and again — over a list of questions, a number of times, or
 * until stopped — for example to collect training examples with Add to dataset. Runs go one after another, so
 * every block takes the GPU and gives it back between runs; a run started by hand meanwhile goes in between.
 */

export interface BatchStatus {
  id: string;
  canvasId: string;
  canvasName: string;
  running: boolean;
  /** Planned runs; undefined = until stopped. */
  total?: number;
  done: number;
  failed: number;
  current?: { runId: string; question: string };
  lastError?: string;
  startedAt: number;
}

export interface BatchOptions {
  ownerId: string;
  canvasId: string;
  canvasName: string;
  graph: CanvasGraph;
  /** Asked in turn; the first one again after the last. */
  questions: string[];
  /** Runs in total; 0 = until stopped. */
  times: number;
  vars: Record<string, string>;
  start: (question: string, vars: Record<string, string>) => string;
}

const batches = new Map<string, Batch>();

class Batch {
  status: BatchStatus;
  private stopped = false;
  constructor(private o: BatchOptions) {
    this.status = { id: `${Date.now().toString(36)}`, canvasId: o.canvasId, canvasName: o.canvasName, running: true, total: o.times || undefined, done: 0, failed: 0, startedAt: Date.now() };
    void this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.status.current) cancelRun(this.status.current.runId, this.o.ownerId);
  }

  private async loop() {
    let streak = 0;
    for (let i = 0; !this.stopped && (!this.o.times || i < this.o.times); i++) {
      const question = this.o.questions[i % this.o.questions.length];
      // {{vars.run}} and {{vars.seed}} differ per run, so prompts can vary.
      const runId = this.o.start(question, { ...this.o.vars, run: String(i + 1), seed: String(Number(this.o.vars.seed ?? 1) + i) });
      this.status.current = { runId, question };
      const ok = await finished(runId, this.o.ownerId);
      this.status.current = undefined;
      // A canvas without AI blocks finishes at once: a short break keeps the server answering everything else.
      await new Promise((r) => setTimeout(r, 25));
      if (ok.status === 'done') {
        this.status.done++;
        streak = 0;
      } else if (!this.stopped) {
        this.status.failed++;
        this.status.lastError = ok.error ?? `Run ${runId} ended with ${ok.status}`;
        // A broken canvas should not spin forever: five failed runs in a row stop the batch.
        if (++streak >= 5) {
          this.status.lastError = `Stopped after 5 failed runs in a row: ${this.status.lastError}`;
          break;
        }
      }
    }
    this.status.running = false;
  }
}

/** Waits for a run's end; its status and the first error. */
function finished(runId: string, ownerId: string): Promise<{ status: string; error?: string }> {
  return new Promise((resolve) => {
    let status = 'error';
    let error: string | undefined;
    const sub = subscribe(
      runId,
      ownerId,
      (ev: RunEvent) => {
        if (ev.type === 'error' && !error) error = ev.error;
        if (ev.type === 'run_done' && ev.status) status = ev.status;
      },
      () => resolve({ status, error }),
    );
    if (!sub) resolve({ status: 'error', error: 'Run not found' });
  });
}

export function startBatch(o: BatchOptions): BatchStatus {
  const cur = batches.get(o.ownerId);
  if (cur?.status.running) throw Object.assign(new Error(`"${cur.status.canvasName}" is already running repeatedly: stop it first`), { statusCode: 409 });
  if (!o.questions.length) throw Object.assign(new Error('Give at least one question'), { statusCode: 400 });
  const b = new Batch(o);
  batches.set(o.ownerId, b);
  return b.status;
}

export const batchStatus = (ownerId: string) => batches.get(ownerId)?.status ?? null;

export function stopBatch(ownerId: string): boolean {
  const b = batches.get(ownerId);
  if (!b?.status.running) return false;
  b.stop();
  return true;
}

