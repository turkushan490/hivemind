/** Run variables ({{vars.name}}): what POST /api/runs and /v1 (hivemind_vars) accept. */

export const MAX_VARS = 64;
export const MAX_VARS_BYTES = 1024 * 1024;
const KEY = /^[a-zA-Z0-9_]{1,40}$/;

/** The vars as a clean record; throws with a message for a 400 when they break the limits. */
export function checkVars(vars: unknown): Record<string, string> {
  if (vars === undefined || vars === null) return {};
  if (typeof vars !== 'object' || Array.isArray(vars)) throw new Error('vars must be an object of strings');
  const entries = Object.entries(vars as Record<string, unknown>);
  if (entries.length > MAX_VARS) throw new Error(`vars: at most ${MAX_VARS} keys`);
  let bytes = 0;
  for (const [k, v] of entries) {
    if (!KEY.test(k)) throw new Error(`vars: "${k.slice(0, 50)}" is not a valid name (letters, digits and _, at most 40)`);
    if (typeof v !== 'string') throw new Error('vars must be an object of strings');
    bytes += Buffer.byteLength(k) + Buffer.byteLength(v);
  }
  if (bytes > MAX_VARS_BYTES) throw new Error('vars: at most 1 MB in total');
  return Object.fromEntries(entries) as Record<string, string>;
}
