// --- The history pair: ONE owner, ONE invariant.
//
// The pair is `history: string[]` + `histIdx: number` — the flat shape the
// session file persists (it cannot change without a format migration). The
// invariant is `0 <= histIdx < history.length`.
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
// silently.

import { describe, expect, test } from "bun:test";
import { clampIndex, clampPair, pushPair, readPair, stepPair } from "./history";

const pair = (history: string[], histIdx: number) => ({ history, histIdx });

describe("the history pair's invariant", () => {
  test("clampIndex clamps into range (an empty history clamps to 0)", () => {
    expect(clampIndex(3, 99)).toBe(2);
    expect(clampIndex(3, -5)).toBe(0);
    expect(clampIndex(3, 1)).toBe(1);
    // no entry to point at — the index is still a number
    expect(clampIndex(0, 7)).toBe(0);
  });

  test("clampPair repairs the index in place and REPORTS the repair", () => {
    const p = pair(["/a", "/b"], 99);
    expect(clampPair(p)).toBe(true);
    expect(p.histIdx).toBe(1);
    // a valid pair is not "repaired" — the flag means "something was wrong"
    expect(clampPair(p)).toBe(false);
    expect(p.histIdx).toBe(1);
  });

  test("pushPair drops the forward tail and lands on the new entry", () => {
    const p = pair(["/a", "/b", "/c"], 1);
    pushPair(p, "/d");
    expect(p.history).toEqual(["/a", "/b", "/d"]);
    expect(p.histIdx).toBe(2);
  });

  test("pushPair on a BROKEN pair clamps FIRST (the old code kept the gap)", () => {
    // the old push sliced at the broken index (99) and pushed — the pair
    // stayed out of range, so every reader silently kept the old cwd
    const p = pair(["/a", "/b", "/c"], 99);
    pushPair(p, "/d");
    expect(p.history).toEqual(["/a", "/b", "/c", "/d"]);
    expect(p.histIdx).toBe(3);
  });

  test("pushPair on a NEGATIVE index keeps the first entry (the old slice dropped the history)", () => {
    // the old slice(0, -4) dropped every entry before the broken index — the
    // whole history was lost, not just the forward tail
    const p = pair(["/a", "/b", "/c"], -5);
    pushPair(p, "/d");
    expect(p.history).toEqual(["/a", "/d"]);
    expect(p.histIdx).toBe(1);
  });

  test("stepPair clamps at both ends", () => {
    const p = pair(["/a", "/b", "/c"], 1);
    stepPair(p, 1);
    expect(p.histIdx).toBe(2);
    stepPair(p, 1); // already at the end — the step is clamped
    expect(p.histIdx).toBe(2);
    stepPair(p, -5);
    expect(p.histIdx).toBe(0);
  });

  test("readPair reports the current dir AND whether it had to repair", () => {
    const ok = pair(["/a", "/b"], 1);
    expect(readPair(ok)).toEqual({ dir: "/b", repaired: false });

    const broken = pair(["/a", "/b"], 99);
    expect(readPair(broken)).toEqual({ dir: "/b", repaired: true });
    // the repair is IN PLACE — the broken pair cannot survive a read
    expect(broken.histIdx).toBe(1);

    // an EMPTY history has no dir to show — that is a broken pair too
    const empty = pair([], 0);
    expect(readPair(empty)).toEqual({ dir: undefined, repaired: true });
  });
});
