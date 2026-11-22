// H30 + H32: every place that talks to HiveBot (the robot, a browser tab, a phone) is its own session: who answered
// last, when, the last 12 turns, locked or not. With character "auto" HiveMind decides who answers, from the rules
// (names.md, listening.md) and the session, exactly the same for the robot and the browser.
import type { HiveBotRules } from './hivebotRules.js';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Session {
  id: string;
  ownerId: string;
  /** "robot" or "browser". */
  kind: 'robot' | 'browser';
  who: string;
  character?: string;
  lastAnswerAt: number;
  /** Follow-ups without a name in a row. */
  followUps: number;
  history: Turn[];
  locked: boolean;
  lastUsed: number;
  lastQuestion?: string;
}

const sessions = new Map<string, Session>();
const KEEP_MS = 24 * 3600_000;
const key = (ownerId: string, id: string) => `${ownerId}\u0000${id}`;

/** The session (made when new); quiet ones (24 h) are dropped on the way. */
export function sessionFor(ownerId: string, id: string, o: { kind: 'robot' | 'browser'; who: string; locked?: boolean }): Session {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastUsed > KEEP_MS) sessions.delete(k);
  let s = sessions.get(key(ownerId, id));
  if (!s) {
    s = { id, ownerId, kind: o.kind, who: o.who, lastAnswerAt: 0, followUps: 0, history: [], locked: !!o.locked, lastUsed: now };
    sessions.set(key(ownerId, id), s);
  }
  if (o.locked !== undefined) s.locked = o.locked;
  s.lastUsed = now;
  return s;
}

/** Remembers a question and its answer (the last 12 turns). */
export function recordTurn(s: Session, character: string | undefined, question: string, answer: string) {
  s.history = [...s.history, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: answer }].slice(-24);
  s.character = character ?? s.character;
  s.lastAnswerAt = Date.now();
  s.lastQuestion = question;
}

export function listSessions(ownerId: string): Omit<Session, 'history' | 'ownerId'>[] {
  return [...sessions.values()]
    .filter((s) => s.ownerId === ownerId && Date.now() - s.lastUsed < KEEP_MS)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map(({ history: _h, ownerId: _o, ...rest }) => rest);
}

export function stopSession(ownerId: string, id: string): boolean {
  return sessions.delete(key(ownerId, id));
}

/** Words of a sentence, lower case, without punctuation. */
const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

export interface Pick {
  skip?: 'noise' | 'tv';
  character?: string;
  /** The question without the name (and "hey", "okay" in front of it). */
  question: string;
  /** A name was said (else a follow-up or the default character). */
  named?: boolean;
  /** "weather" / "web" from the kind-of-question words. */
  need?: string;
  /** An answer without running the workflow ("Friday only works on the robot"). */
  answer?: string;
}

/** The character a word names, from the names list and the word starts. */
function nameOf(word: string, rules: HiveBotRules): string | undefined {
  const w = word.replace(/['’]s$/, '');
  if (rules.names[w]) return rules.names[w];
  for (const p of rules.prefixes) if (w.length >= p.min && w.length <= p.max && p.starts.some((s) => w.startsWith(s))) return p.character;
  return undefined;
}

/**
 * Who answers (H32): noise and TV are skipped, a name in the first 5 words picks that character (the name and the
 * words before it are cut off), no name goes to whoever answered within the follow-up window, else the default.
 */
export function pickCharacter(s: Session, text: string, rules: HiveBotRules, o: { robot: boolean; now?: number }): Pick {
  const now = o.now ?? Date.now();
  const set = rules.settings;
  const num = (k: string, d: number) => (typeof set[k] === 'number' ? (set[k] as number) : d);
  // Sound descriptions ([music], (laughs), *beep*) are not words.
  const clean = text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  const ws = words(clean);
  const plain = ws.join(' ');
  if (!ws.length || rules.noise.includes(plain) || (ws.length === 1 && !rules.oneWord.includes(ws[0]) && !/^\d+$/.test(ws[0]) && !nameOf(ws[0], rules))) {
    return { skip: 'noise', question: clean };
  }
  let character: string | undefined;
  let question = clean;
  let named = false;
  for (let i = 0; i < Math.min(5, ws.length); i++) {
    const c = nameOf(ws[i], rules);
    if (!c) continue;
    character = c;
    named = true;
    // Cut the name and what came before it ("hey", "okay") from the question, keeping the original wording.
    const rx = new RegExp(`^(?:\\S+\\s+){${i}}\\S*?${ws[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 3)}\\S*[\\s,.!?:;]*`, 'iu');
    question = clean.replace(rx, '').trim() || clean;
    break;
  }
  if (!named) {
    const within = s.character && now - s.lastAnswerAt < num('followUpSeconds', 60) * 1000;
    // A long sentence without a name is the TV or a video.
    if (ws.length >= num('tvWords', 60)) return { skip: 'tv', question: clean };
    if (set.nameMode === 'on' || set.nameMode === 'true') {
      if (!within || ws.length > num('followUpWords', 25) || s.followUps >= num('followUpRuns', 2)) return { skip: 'tv', question: clean };
    }
    character = within ? s.character : String(set.defaultCharacter ?? 'vision');
    s.followUps = within ? s.followUps + 1 : 0;
  } else {
    // Another character than last time starts a clean conversation.
    if (character !== s.character) s.history = [];
    s.followUps = 0;
  }
  if (character === 'friday' && !o.robot) return { character, question, named, answer: 'Friday only works on the robot.' };
  // The kind of question: weather (Jev has a weather branch; the others look it up on the web) or web.
  const lower = ` ${question.toLowerCase()} `;
  let need: string | undefined;
  if ((rules.kinds.weather ?? []).some((k) => lower.includes(` ${k} `) || lower.includes(` ${k}?`))) need = character === 'jev' ? 'weather' : 'web';
  else if ((rules.kinds.web ?? []).some((k) => lower.includes(` ${k}`))) need = 'web';
  return { character, question, named, ...(need && { need }) };
}
