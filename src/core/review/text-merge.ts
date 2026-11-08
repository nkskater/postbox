/**
 * Line-based three-way text merge: apply the edits two people made to the same starting text, as long as
 * they did not touch the same lines. Edits that overlap, or insert different text at the same place, are
 * reported as conflicts rather than guessed at.
 */
export interface TextConflict {
  /** First line of the disputed region in the starting text (1-based). */
  line: number;
  base: string[];
  ours: string[];
  theirs: string[];
}
export interface TextMergeResult {
  /** True when every edit could be combined; `text` is then the merged result. */
  clean: boolean;
  /** The merged text. With conflicts it holds git-style markers, for display only. */
  text: string;
  conflicts: TextConflict[];
}

/** Largest table the line diff may fill; bigger, more tangled edits are reported as conflicts. */
const MAX_CELLS = 4_000_000;

/** One side's edit: lines `start`..`end` of the starting text are replaced by `repl`. */
interface Hunk {
  start: number;
  end: number;
  repl: string[];
}

/** The edits that turn `base` into `other`, or null if they are too large to compute. */
function hunksFor(base: string[], other: string[]): Hunk[] | null {
  let p = 0;
  while (p < base.length && p < other.length && base[p] === other[p]) p++;
  let s = 0;
  while (
    s < base.length - p &&
    s < other.length - p &&
    base[base.length - 1 - s] === other[other.length - 1 - s]
  )
    s++;
  const a = base.slice(p, base.length - s);
  const b = other.slice(p, other.length - s);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > MAX_CELLS) return null;

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // dp[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);

  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i === n || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) {
      open ??= { start: p + i, end: p + i, repl: [] };
      open.repl.push(b[j]);
      j++;
    } else {
      open ??= { start: p + i, end: p + i, repl: [] };
      open.end = p + i + 1;
      i++;
    }
  }
  close();
  return hunks;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, k) => line === y[k]);
const overlaps = (x: Hunk, y: Hunk) => x.start === y.start || (x.start < y.end && y.start < x.end);

/** `base[lo..hi)` with the hunks (all inside that range) applied. */
function applyWithin(base: string[], lo: number, hi: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = lo;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.start), ...h.repl);
    pos = h.end;
  }
  out.push(...base.slice(pos, hi));
  return out;
}

export function mergeText(base: string, ours: string, theirs: string): TextMergeResult {
  if (ours === theirs) return { clean: true, text: ours, conflicts: [] };
  if (ours === base) return { clean: true, text: theirs, conflicts: [] };
  if (theirs === base) return { clean: true, text: ours, conflicts: [] };

  const baseLines = base.split("\n");
  const A = hunksFor(baseLines, ours.split("\n"));
  const B = hunksFor(baseLines, theirs.split("\n"));
  if (!A || !B)
    return {
      clean: false,
      text: ours,
      conflicts: [{ line: 1, base: baseLines, ours: ours.split("\n"), theirs: theirs.split("\n") }],
    };

  const out: string[] = [];
  const conflicts: TextConflict[] = [];
  let pos = 0;
  let ia = 0;
  let ib = 0;
  while (ia < A.length || ib < B.length) {
    const a = A[ia];
    const b = B[ib];
    if (a && b && overlaps(a, b)) {
      // Grow the disputed region until no further hunk from either side touches it.
      const lo = Math.min(a.start, b.start);
      let hi = Math.max(a.end, b.end);
      let ja = ia + 1;
      let jb = ib + 1;
      for (let grew = true; grew;) {
        grew = false;
        while (ja < A.length && A[ja].start < hi) {
          hi = Math.max(hi, A[ja].end);
          ja++;
          grew = true;
        }
        while (jb < B.length && B[jb].start < hi) {
          hi = Math.max(hi, B[jb].end);
          jb++;
          grew = true;
        }
      }
      const mine = applyWithin(baseLines, lo, hi, A.slice(ia, ja));
      const their = applyWithin(baseLines, lo, hi, B.slice(ib, jb));
      out.push(...baseLines.slice(pos, lo));
      if (same(mine, their)) out.push(...mine);
      else {
        conflicts.push({ line: lo + 1, base: baseLines.slice(lo, hi), ours: mine, theirs: their });
        out.push("<<<<<<< ours", ...mine, "=======", ...their, ">>>>>>> theirs");
      }
      pos = hi;
      ia = ja;
      ib = jb;
    } else {
      const take = a && (!b || a.start <= b.start) ? A[ia++] : B[ib++];
      out.push(...baseLines.slice(pos, take.start), ...take.repl);
      pos = take.end;
    }
  }
  out.push(...baseLines.slice(pos));
  return { clean: !conflicts.length, text: out.join("\n"), conflicts };
}
