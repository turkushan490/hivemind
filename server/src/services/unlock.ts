import { hashPassword, verifyPassword } from '../crypto.js';
import { db, getSetting, setSetting } from '../db/index.js';

/**
 * Unlock mode: a private zone per user with its own memory (a separate folder, never mixed with the normal memory)
 * and hidden workflows. Only shown while the user turned it on with their PIN, on the screen: API tokens (T3, robots,
 * apps) never see it, also when it is on. It locks again by itself after 12 hours, and on log out.
 */
export interface UnlockUser {
  id: string;
  role?: string;
  tokenId?: string;
  scope?: unknown;
}

const key = (userId: string) => `user:${userId}:unlocked`;
const pinKey = (userId: string) => `user:${userId}:unlockPin`;
/** How long unlock mode stays on without locking it by hand. */
export const UNLOCK_MS = 12 * 3_600_000;

/** May this login use unlock mode at all (a screen login, not a viewer, not an API token)? */
export const canUnlock = (u: UnlockUser) => !u.tokenId && !u.scope && u.role !== 'viewer';

/** On, and switched on less than 12 hours ago (the setting holds when it was switched on). */
export const isUnlocked = (u: UnlockUser) => {
  if (!canUnlock(u)) return false;
  const at = Number(getSetting(key(u.id)) ?? 0);
  return at > 1e12 && Date.now() - at < UNLOCK_MS;
};

export function setUnlocked(u: Pick<UnlockUser, 'id'>, on: boolean) {
  setSetting(key(u.id), on ? String(Date.now()) : '0');
}

/** When it locks by itself (ms), while on. */
export const unlockedUntil = (u: UnlockUser) => (isUnlocked(u) ? Number(getSetting(key(u.id))) + UNLOCK_MS : undefined);

export const hasPin = (u: Pick<UnlockUser, 'id'>) => !!getSetting(pinKey(u.id));

/** A PIN: 4 to 32 characters (digits or a word). */
export const goodPin = (pin: unknown): pin is string => typeof pin === 'string' && pin.length >= 4 && pin.length <= 32;

export async function setPin(u: Pick<UnlockUser, 'id'>, pin: string) {
  setSetting(pinKey(u.id), await hashPassword(pin));
}

/** Wrong PINs: after 5 in a row, no more tries for 5 minutes. */
const wrong = new Map<string, { n: number; until: number }>();

/** Checks the PIN. Throws (with statusCode) when blocked or wrong. */
export async function checkPin(u: Pick<UnlockUser, 'id'>, pin: unknown): Promise<void> {
  const w = wrong.get(u.id);
  if (w && w.until > Date.now()) throw Object.assign(new Error(`Too many wrong PINs. Try again in ${Math.ceil((w.until - Date.now()) / 60_000)} min.`), { statusCode: 429 });
  const stored = getSetting(pinKey(u.id));
  if (stored && typeof pin === 'string' && (await verifyPassword(pin, stored).catch(() => false))) {
    wrong.delete(u.id);
    return;
  }
  // Count wrong tries; a finished 5-minute block starts the count again.
  const n = (w && w.until === 0 ? w.n : 0) + 1;
  wrong.set(u.id, n >= 5 ? { n: 0, until: Date.now() + 5 * 60_000 } : { n, until: 0 });
  throw Object.assign(new Error(n >= 5 ? 'Wrong PIN. Too many tries: wait 5 minutes.' : 'Wrong PIN'), { statusCode: 403 });
}

/** Is this saved workflow a hidden one? */
export function canvasHidden(id: string | undefined): boolean {
  if (!id) return false;
  return !!(db.prepare('SELECT hidden FROM canvases WHERE id = ?').get(id) as { hidden?: number } | undefined)?.hidden;
}

/** May this user see a canvas with this owner and hidden flag? Hidden ones: only the owner, while unlocked. */
export const seesCanvas = (u: UnlockUser, row: { owner_id: string; hidden?: number | null }) => !row.hidden || (row.owner_id === u.id && isUnlocked(u));
