// diff-fast-exact: a faster drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly makefun-diff 1.0.0's patch of { old, new }:
// the same line tokenisation (cut after every "\n", a "\r" is part of its
// line, a trailing line without "\n" is a line too, equality is code-unit
// equality including the newline), the same edit script (common prefix,
// then common suffix of the rest, then Myers's greedy search with the
// deletion winning every tie, no edge pruning, snakes followed to their
// end, the first path to reach both ends wins), and the same patch format
// (header line, hunks with 3 lines of context, change runs listing their
// deletions before their insertions, "%" after a line that ends its text
// without a newline).
//
// Where the speed comes from:
// - Lines are interned to small integers once per case, through one Map
//   shared by both texts, so every comparison inside the search is an
//   integer comparison; the line strings themselves are kept for output.
// - The search runs on flat Int32Array V rows (one row kept per edit
//   count for the backtrack) instead of a linked list of path objects
//   per candidate: no per-step allocation, and the snake of each
//   candidate is walked once, not re-walked from a stored history.
// - The patch is assembled from the kept line strings directly.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const CONTEXT = 3;

/** Scan a text into lines: interned ids and the line strings. */
function scan(text, ids) {
  const len = text.length;
  const idList = [];
  const lines = [];
  let pos = 0;
  while (pos < len) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl + 1;
    const line = text.slice(pos, end);
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    idList.push(id);
    lines.push(line);
    pos = end;
  }
  return { lineIds: Int32Array.from(idList), lines, count: lines.length };
}

/**
 * The exact Myers search of the reference, on interned token arrays a
 * and b, appending its runs (kind, count) to the run lists. Mirrors the
 * reference step for step: furthest-x wins, deletion wins a tie, a move
 * past either end is no candidate, first path to reach both ends wins.
 */
function myers(a, b, runKind, runCount) {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    if (m > 0) pushRun(runKind, runCount, INSERT, m);
    return;
  }
  if (m === 0) {
    pushRun(runKind, runCount, DELETE, n);
    return;
  }
  // Forward pass over one in-place V array: at round d only diagonals
  // with d's parity are written, so V[k - 1] and V[k + 1] still hold
  // round d - 1's values when read (an untouched diagonal reads -2, the
  // no-path sentinel). A slice of the round's band is kept per round
  // for the backtrack.
  const maxD = n + m;
  const off = maxD + 1;
  const V = new Int32Array(2 * maxD + 3).fill(-2);
  const rows = [];
  let x0 = 0;
  while (x0 < n && x0 < m && a[x0] === b[x0]) x0++;
  V[off] = x0;
  rows.push(V.slice(off, off + 1));
  let foundD = -1;
  if (x0 >= n && x0 >= m) foundD = 0;
  for (let d = 1; foundD < 0 && d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      const idx = off + k;
      const xr = V[idx - 1];
      const xa = V[idx + 1];
      const canR = xr >= 0 && xr < n;
      const canA = xa >= 0 && xa - (k + 1) < m;
      if (!canR && !canA) {
        V[idx] = -2;
        continue;
      }
      let x;
      if (canR && (!canA || xr + 1 >= xa)) x = xr + 1;
      else x = xa;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      V[idx] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    rows.push(V.slice(off - d, off + d + 1));
  }
  if (foundD < 0) throw new Error('diff: the search ended without reaching both ends');
  // Backtrack from (n, m), collecting ops in reverse.
  const opKind = [];
  const opCount = [];
  let cx = n;
  let k = n - m;
  for (let d = foundD; d >= 1; d--) {
    const prow = rows[d - 1];
    const xr = k - 1 >= -(d - 1) ? prow[k + d - 2] : -2;
    const xa = k + 1 <= d - 1 ? prow[k + d] : -2;
    const canR = xr >= 0 && xr < n;
    const canA = xa >= 0 && xa - (k + 1) < m;
    let prevK;
    let xPrev;
    let kind;
    if (canR && (!canA || xr + 1 >= xa)) {
      prevK = k - 1;
      xPrev = xr;
      kind = DELETE;
    } else {
      prevK = k + 1;
      xPrev = xa;
      kind = INSERT;
    }
    const xMid = kind === DELETE ? xPrev + 1 : xPrev;
    const snake = cx - xMid;
    if (snake > 0) pushOp(opKind, opCount, KEEP, snake);
    pushOp(opKind, opCount, kind, 1);
    cx = xPrev;
    k = prevK;
  }
  if (cx > 0) pushOp(opKind, opCount, KEEP, cx);
  for (let i = opKind.length - 1; i >= 0; i--) pushRun(runKind, runCount, opKind[i], opCount[i]);
}

function pushOp(opKind, opCount, kind, count) {
  const last = opKind.length - 1;
  if (last >= 0 && opKind[last] === kind) opCount[last] += count;
  else {
    opKind.push(kind);
    opCount.push(count);
  }
}

function pushRun(runKind, runCount, kind, count) {
  if (count <= 0) return;
  const last = runKind.length - 1;
  if (last >= 0 && runKind[last] === kind) runCount[last] += count;
  else {
    runKind.push(kind);
    runCount.push(count);
  }
}

/**
 * Solve the middle segment (interned arrays A and B) into the run lists.
 * (An earlier draft split the middle at uniquely-occurring anchor lines;
 * differential testing on small random cases showed the reference's
 * greedy path does not always keep such an anchor even when a shortest
 * script through it exists, so the middle is solved by the one exact
 * search, with no decomposition that could change its tie-breaks.)
 */
function solveMiddle(A, B, idSpace, runKind, runCount) {
  myers(A, B, runKind, runCount);
}

/** One line as the patch writes it: op + line, plus "%" when it had no newline. */
function written(parts, op, line) {
  if (line.charCodeAt(line.length - 1) === 10) parts.push(op, line);
  else parts.push(op, line, '\n%\n');
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const ids = new Map();
  const A = scan(input.old, ids);
  const B = scan(input.new, ids);
  const n = A.count;
  const m = B.count;
  const aIds = A.lineIds;
  const bIds = B.lineIds;
  // Common prefix, then common suffix of what is left (as the reference).
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const runKind = [];
  const runCount = [];
  if (prefix > 0) pushRun(runKind, runCount, KEEP, prefix);
  solveMiddle(aIds.subarray(prefix, n - suffix), bIds.subarray(prefix, m - suffix), ids.size, runKind, runCount);
  if (suffix > 0) pushRun(runKind, runCount, KEEP, suffix);

  // Change runs: stretches of deletions/insertions between kept lines.
  const chO = [];
  const chP = [];
  const chD = [];
  const chI = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let r = 0; r < runKind.length; r++) {
    const kind = runKind[r];
    const count = runCount[r];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    const last = chO.length - 1;
    if (last < 0 || chO[last] + chD[last] !== o || chP[last] + chI[last] !== p) {
      chO.push(o);
      chP.push(p);
      chD.push(0);
      chI.push(0);
    }
    const ci = chO.length - 1;
    if (kind === DELETE) {
      chD[ci] += count;
      o += count;
      deleted += count;
    } else {
      chI[ci] += count;
      p += count;
      inserted += count;
    }
  }
  // Hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (let c = 0; c < chO.length; c++) {
    const h = hunks[hunks.length - 1];
    if (h !== undefined && chO[c] - (chO[h[h.length - 1]] + chD[h[h.length - 1]]) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const parts = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const aLines = A.lines;
  const bLines = B.lines;
  for (const h of hunks) {
    const first = h[0];
    const lastC = h[h.length - 1];
    const oldStart = Math.max(0, chO[first] - CONTEXT);
    const newStart = chP[first] - (chO[first] - oldStart);
    const after = Math.min(CONTEXT, n - (chO[lastC] + chD[lastC]));
    const oldEnd = chO[lastC] + chD[lastC] + after;
    const newEnd = chP[lastC] + chI[lastC] + after;
    parts.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < chO[c]; at++) written(parts, '=', aLines[at]);
      for (let i = 0; i < chD[c]; i++) written(parts, '-', aLines[chO[c] + i]);
      for (let i = 0; i < chI[c]; i++) written(parts, '+', bLines[chP[c] + i]);
      at = chO[c] + chD[c];
    }
    for (; at < oldEnd; at++) written(parts, '=', aLines[at]);
  }
  return parts.join('');
}
