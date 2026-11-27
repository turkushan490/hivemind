import type { StreamChunk } from './types.js';

/** The most a "thinking only, no answer" retry asks for. */
export const MAX_RETRY_TOKENS = 8192;

/**
 * The bigger budget for one more try after a model spent all of it thinking: 4× (at most 8192),
 * or undefined when there is no bigger budget to ask for. No budget (unlimited) → 8192.
 */
export function biggerBudget(current: number | undefined): number | undefined {
  if (current === undefined || current <= 0) return MAX_RETRY_TOKENS;
  const more = Math.min(MAX_RETRY_TOKENS, current * 4);
  return more > current ? more : undefined;
}

/** The answer without "<think>…</think>" that leaked into it (also an unclosed one at the start). */
export function stripThink(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  return /^\s*<think>/.test(t) ? '' : t;
}

const OPEN = '<think>';
const CLOSE = '</think>';
/** How many characters at the end of s could be the start of tag. */
const partial = (s: string, tag: string) => {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
};

/**
 * Streamed answer text → chunks, with "<think>…</think>" at the start of the answer (a model that ignores
 * think: false and writes its thinking into the answer) sent as thinking. Tags may arrive in pieces.
 */
export function thinkSplitter() {
  let state: 'start' | 'think' | 'answer' = 'start';
  let buf = '';
  return {
    push(text: string): StreamChunk[] {
      if (state === 'answer') return [{ type: 'token', text }];
      buf += text;
      if (state === 'start') {
        const t = buf.trimStart();
        if (t.startsWith(OPEN)) {
          state = 'think';
          buf = t.slice(OPEN.length);
        } else if (OPEN.startsWith(t)) {
          return []; // maybe the tag is still coming
        } else {
          state = 'answer';
          const b = buf;
          buf = '';
          return [{ type: 'token', text: b }];
        }
      }
      const out: StreamChunk[] = [];
      const end = buf.indexOf(CLOSE);
      if (end >= 0) {
        const thinking = buf.slice(0, end);
        const rest = buf.slice(end + CLOSE.length).replace(/^\s+/, '');
        state = 'answer';
        buf = '';
        if (thinking) out.push({ type: 'thinking', text: thinking });
        if (rest) out.push({ type: 'token', text: rest });
        return out;
      }
      const keep = partial(buf, CLOSE);
      const thinking = buf.slice(0, buf.length - keep);
      buf = buf.slice(buf.length - keep);
      if (thinking) out.push({ type: 'thinking', text: thinking });
      return out;
    },
    /** What is still held back at the end of the answer. */
    flush(): StreamChunk[] {
      const b = buf;
      buf = '';
      if (!b) return [];
      if (state === 'think') return [{ type: 'thinking', text: b }];
      return b.trim() ? [{ type: 'token', text: b }] : [];
    },
  };
}
