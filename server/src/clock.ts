/**
 * The time the scheduler and the training window go by. Local time (the TZ environment variable) is what people
 * mean by "03:00"; tests swap the clock with setClock.
 */
let current: () => Date = () => new Date();

export const now = () => current();

/** Tests: a fixed or moving fake clock; no argument puts the real one back. */
export function setClock(fn?: () => Date) {
  current = fn ?? (() => new Date());
}

/** "HH:MM" of a local time. */
export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export const validTime = (t: unknown): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

/** Minutes since local midnight of "HH:MM". */
export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
