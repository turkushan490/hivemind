/** Line diffs for the project history and the Pause block: counts and a small unified diff. */

const MAX_DIFF_CHARS = 20_000;
/** Above this many line pairs the diff is only counted (an LCS table would take too long). */
const MAX_CELLS = 4_000_000;

export interface LineDiff {
  added: number;
  removed: number;
  /** Unified-style text ("+ line", "- line", "  line"), capped; undefined for binary or huge files. */
  diff?: string;
}

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'));

/** The difference between two versions of a text file (old undefined: a new file; new undefined: deleted). */
export function lineDiff(before: string | undefined, after: string | undefined): LineDiff {
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  if (before === undefined) return { added: b.length, removed: 0, diff: cap(b.map((l) => `+ ${l}`)) };
  if (after === undefined) return { added: 0, removed: a.length, diff: cap(a.map((l) => `- ${l}`)) };
  // Equal head and tail are cut off first, so a small edit in a big file stays cheap.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) return { added: midB.length, removed: midA.length };
  // Longest common subsequence over the changed middle part.
  const n = midA.length;
  const m = midB.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  // Three lines of context before the first change.
  for (let k = Math.max(0, start - 3); k < start; k++) out.push(`  ${a[k]}`);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push(`  ${midA[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+ ${midB[j++]}`);
      added++;
    } else {
      out.push(`- ${midA[i++]}`);
      removed++;
    }
  }
  for (let k = endA; k < Math.min(a.length, endA + 3); k++) out.push(`  ${a[k]}`);
  return { added, removed, diff: cap(out) };
}

function cap(lines: string[]): string {
  let text = lines.join('\n');
  if (text.length > MAX_DIFF_CHARS) text = `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff cut off)`;
  return text;
}
