import { useEffect, useState } from 'react';
import { api } from './api';

/** Unlock mode (hidden memory and hidden workflows): one state for the whole page, shared through a window event. */
export interface UnlockState {
  allowed: boolean;
  unlocked: boolean;
}

let current: UnlockState = { allowed: false, unlocked: false };
const EVENT = 'hm-unlock';

export async function loadUnlock(): Promise<UnlockState> {
  current = await api<UnlockState>('/api/unlock', { quiet: true }).catch(() => current);
  window.dispatchEvent(new Event(EVENT));
  return current;
}

export async function setUnlock(on: boolean): Promise<UnlockState> {
  current = await api<UnlockState>('/api/unlock', { body: { on } });
  window.dispatchEvent(new Event(EVENT));
  return current;
}

/** The state right now (for event handlers). */
export const currentUnlock = () => current;

/** The current state; re-renders when it changes anywhere on the page. */
export function useUnlock(): UnlockState {
  const [s, setS] = useState(current);
  useEffect(() => {
    const on = () => setS(current);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return s;
}

/** Runs fn whenever unlock mode changes (e.g. to fetch the workflow list again). */
export function useOnUnlockChange(fn: () => void) {
  useEffect(() => {
    window.addEventListener(EVENT, fn);
    return () => window.removeEventListener(EVENT, fn);
  });
}
