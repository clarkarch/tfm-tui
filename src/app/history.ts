// --- The history pair: ONE owner, ONE invariant.
//
// The pair is `history: string[]` + `histIdx: number` — the flat shape the
// session file persists (`src/fs/session.ts`), so it cannot change without
// a format migration. The invariant is `0 <= histIdx < history.length`.
//
// Every writer used to ASSUME it held: `pushHistory`/`step` clamped
// themselves, but the tab model adopts a pair FROM a tab and copies one
// INTO a tab, and anything holding the state object can write it. The only
// reader that cared read `history[histIdx] ?? cwd` → an out-of-range index
// SILENTLY KEPT THE OLD CWD: the breadcrumb, the grid and the tab chip
// could disagree with no log.
//
// This leaf owns the pair: the writers clamp through it, and the reader
// REPAIRS an out-of-range pair (and says so) instead of falling back
// silently. Pure — no fs, no renderer, no config.

export type HistoryPair = { history: string[]; histIdx: number };

// The clamped index for a history of `length` entries. An EMPTY history
// clamps to 0: there is no entry to point at, but the index must still be
// a number.
export const clampIndex = (length: number, index: number): number =>
  length <= 0 ? 0 : Math.min(Math.max(0, index), length - 1);

// CLAMP a pair in place — the ONE write path for the index. Returns true
// when the index had to be repaired (the caller announces it: a repaired
// pair means something upstream wrote a broken one).
export const clampPair = (pair: HistoryPair): boolean => {
  const idx = clampIndex(pair.history.length, pair.histIdx);
  const repaired = idx !== pair.histIdx;
  pair.histIdx = idx;
  return repaired;
};

// push a dir onto the history: the forward tail is dropped and the index
// lands on the new entry. A broken pair is clamped FIRST — the old code
// sliced at the broken index and kept the gap, so the pair stayed out of
// range. Returns true when a broken pair was repaired.
export const pushPair = (pair: HistoryPair, dir: string): boolean => {
  const repaired = clampPair(pair);
  pair.history = pair.history.slice(0, pair.histIdx + 1);
  pair.history.push(dir);
  pair.histIdx = pair.history.length - 1;
  return repaired;
};

// step the index by delta, clamped at both ends. Returns true when a
// broken pair was repaired.
export const stepPair = (pair: HistoryPair, delta: number): boolean => {
  const repaired = clampPair(pair);
  pair.histIdx = clampIndex(pair.history.length, pair.histIdx + delta);
  return repaired;
};

// REPAIR a pair and report what the reader should show: the current dir
// (undefined for an EMPTY history — there is nothing to show) and whether
// the pair had to be fixed. The reader must NOT fall back silently.
export type HistoryRead = { dir: string | undefined; repaired: boolean };

export const readPair = (pair: HistoryPair): HistoryRead => {
  const repaired = clampPair(pair);
  const dir = pair.history[pair.histIdx];
  return { dir, repaired: repaired || dir === undefined };
};
