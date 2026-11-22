import { db, getSetting, setSetting } from '../db/index.js';

/**
 * Unlock mode: a private zone per user with its own memory (a separate folder, never mixed with the normal memory)
 * and hidden workflows. Only shown while the user turned it on, on the screen: API tokens (T3, robots, apps) never
 * see it, also when it is on.
 */
export interface UnlockUser {
  id: string;
  role?: string;
  tokenId?: string;
  scope?: unknown;
}

const key = (userId: string) => `user:${userId}:unlocked`;

/** May this login use unlock mode at all (a screen login, not a viewer, not an API token)? */
export const canUnlock = (u: UnlockUser) => !u.tokenId && !u.scope && u.role !== 'viewer';

export const isUnlocked = (u: UnlockUser) => canUnlock(u) && getSetting(key(u.id)) === '1';

export function setUnlocked(u: UnlockUser, on: boolean) {
  setSetting(key(u.id), on ? '1' : '0');
}

/** Is this saved workflow a hidden one? */
export function canvasHidden(id: string | undefined): boolean {
  if (!id) return false;
  return !!(db.prepare('SELECT hidden FROM canvases WHERE id = ?').get(id) as { hidden?: number } | undefined)?.hidden;
}

/** May this user see a canvas with this owner and hidden flag? Hidden ones: only the owner, while unlocked. */
export const seesCanvas = (u: UnlockUser, row: { owner_id: string; hidden?: number | null }) => !row.hidden || (row.owner_id === u.id && isUnlocked(u));
