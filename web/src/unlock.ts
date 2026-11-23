import { useEffect, useState } from 'react';
import { api } from './api';

/** Unlock mode (hidden memory and hidden workflows): one state for the whole page, shared through a window event. */
export interface UnlockState {
  allowed: boolean;
  unlocked: boolean;
  /** A PIN is set (unlocking asks for it). */
  hasPin?: boolean;
  /** When it locks by itself (ms). */
  until?: number;
  /** "1h" | "12h" | "1d" | "never" (only by hand). */
  lockAfter?: string;
}

let current: UnlockState = { allowed: false, unlocked: false };
const EVENT = 'hm-unlock';

export async function loadUnlock(): Promise<UnlockState> {
  current = await api<UnlockState>('/api/unlock', { quiet: true }).catch(() => current);
  window.dispatchEvent(new Event(EVENT));
  return current;
}

export async function setUnlock(on: boolean, pin?: string): Promise<UnlockState> {
  current = await api<UnlockState>('/api/unlock', { body: { on, pin } });
  window.dispatchEvent(new Event(EVENT));
  return current;
}

/** Sets the PIN (the old one is needed to change it). */
export async function setUnlockPin(pin: string, old?: string): Promise<void> {
  await api('/api/unlock/pin', { body: { pin, old } });
  current = { ...current, hasPin: true };
  window.dispatchEvent(new Event(EVENT));
}

/** When it locks by itself: "1h", "12h", "1d" or "never". */
export async function setLockAfter(after: string): Promise<void> {
  const r = await api<Partial<UnlockState>>('/api/unlock/after', { body: { after } });
  current = { ...current, ...r };
  window.dispatchEvent(new Event(EVENT));
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
