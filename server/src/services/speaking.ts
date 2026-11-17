// H16: who is being spoken to right now. The blocks after a workflow's Output (the memory "tail") wait until the
// voice for the answer is done, so a model they load never makes the robot's voice wait for the GPU.

const state = new Map<string, { active: number; lastEnd: number }>();

/** Wraps one text-to-speech call for this user. */
export async function speaking<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const s = state.get(userId) ?? { active: 0, lastEnd: 0 };
  state.set(userId, s);
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    s.lastEnd = Date.now();
  }
}

/**
 * Waits until this user's voice is quiet: no speech call going on and none in the last `quietMs`. When no speech
 * starts within `firstMs` after the answer (a client that doesn't speak), it goes on; never longer than `maxMs`.
 */
export async function voiceQuiet(userId: string, opts: { since: number; firstMs?: number; quietMs?: number; maxMs?: number; signal?: AbortSignal } ): Promise<void> {
  const firstMs = opts.firstMs ?? 6000;
  const quietMs = opts.quietMs ?? 2500;
  const maxMs = opts.maxMs ?? 90_000;
  const t0 = Date.now();
  for (;;) {
    if (opts.signal?.aborted) return;
    const s = state.get(userId);
    const now = Date.now();
    if (now - t0 > maxMs) return;
    const spoke = !!s && s.lastEnd >= opts.since - 1000;
    const busy = !!s && s.active > 0;
    if (!busy && !spoke && now - opts.since > firstMs) return; // nothing was spoken for this answer
    if (!busy && spoke && now - s!.lastEnd > quietMs) return; // spoken, and quiet since
    await new Promise((r) => setTimeout(r, 250));
  }
}
