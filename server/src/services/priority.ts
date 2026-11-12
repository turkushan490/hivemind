import { clampPriority, DEFAULT_PRIORITY } from '../engine/run.js';
import type { User } from '../api/auth.js';

export { clampPriority, DEFAULT_PRIORITY };

/** The name HiveMind gives T3 Code's own API token (api/t3.ts). */
export const T3_TOKEN_NAME = 'T3 Code';
/** HiveBot's default when it sends no priority: ahead of normal runs (100) and T3 (100), behind an urgent one it asks for. */
export const ROBOT_DEFAULT_PRIORITY = 50;

/**
 * The GPU priority for a request (1 = first … 200):
 * - T3 Code is pinned in the middle (100), whatever it sends, so a coding agent never starves normal runs or jumps them.
 * - HiveBot (a robot-scoped token) uses the number it sends, defaulting ahead of everything so quick replies win; it
 *   sets a big number itself (e.g. 200) for a long background job like building a site.
 * - Everyone else uses what they send, or the middle.
 */
export function priorityFor(user: Pick<User, 'tokenName' | 'scope'>, sent: unknown): number {
  if (user.tokenName === T3_TOKEN_NAME) return DEFAULT_PRIORITY;
  if (user.scope?.robot) return clampPriority(sent, ROBOT_DEFAULT_PRIORITY);
  return clampPriority(sent, DEFAULT_PRIORITY);
}
