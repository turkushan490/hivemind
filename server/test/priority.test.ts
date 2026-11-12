import { describe, expect, it } from 'vitest';
import { clampPriority, DEFAULT_PRIORITY, hostHolder, hostQueue, withHostLock } from '../src/engine/run.js';

/** Resolves after a tick so queued jobs line up before the holder releases. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('GPU priority queue (withHostLock)', () => {
  it('clamps priority into 1..200 and falls back to the default', () => {
    expect(DEFAULT_PRIORITY).toBe(100);
    expect(clampPriority(undefined)).toBe(100);
    expect(clampPriority('5')).toBe(100); // not a number → default
    expect(clampPriority(0)).toBe(1);
    expect(clampPriority(999)).toBe(200);
    expect(clampPriority(42.6)).toBe(43);
    expect(clampPriority(undefined, 50)).toBe(50);
  });

  it('runs the lowest number first, ties first-come-first-served, never interrupting the holder', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    // The first job grabs the GPU and holds it until we let go, so the rest queue up.
    const holder = withHostLock(
      'gpu',
      async () => {
        order.push('holder');
        await held;
      },
      { label: 'holder', priority: 100 },
    );
    await tick();
    expect(hostHolder('gpu')).toBe('holder');

    // These arrive while the GPU is busy, out of priority order.
    const normal = withHostLock('gpu', async () => void order.push('normal'), { label: 'normal', priority: 100 });
    const background = withHostLock('gpu', async () => void order.push('background'), { label: 'background', priority: 200 });
    const urgent = withHostLock('gpu', async () => void order.push('urgent'), { label: 'urgent', priority: 1 });
    const alsoNormal = withHostLock('gpu', async () => void order.push('alsoNormal'), { label: 'alsoNormal', priority: 100 });
    await tick();

    // The holder is still running; four jobs wait, most urgent first.
    expect(order).toEqual(['holder']);
    expect(hostQueue('gpu').waiting.map((w) => w.priority)).toEqual([1, 100, 100, 200]);

    release();
    await Promise.all([holder, normal, background, urgent, alsoNormal]);

    // urgent (1) first, then the two priority-100 in arrival order, then background (200) last.
    expect(order).toEqual(['holder', 'urgent', 'normal', 'alsoNormal', 'background']);
    expect(hostHolder('gpu')).toBeUndefined();
  });

  it('a cancel while waiting drops the job from the queue without blocking the others', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = withHostLock('gpu2', async () => void (await held), { label: 'holder', priority: 100 });
    await tick();

    const ctrl = new AbortController();
    const cancelled = withHostLock('gpu2', async () => void order.push('cancelled'), { signal: ctrl.signal, priority: 1 });
    const after = withHostLock('gpu2', async () => void order.push('after'), { priority: 100 });
    await tick();
    expect(hostQueue('gpu2').waiting.length).toBe(2);

    ctrl.abort();
    await expect(cancelled).rejects.toThrow('Cancelled');
    release();
    await Promise.all([holder, after]);

    // The cancelled urgent job never ran; the next one still did.
    expect(order).toEqual(['after']);
  });
});
