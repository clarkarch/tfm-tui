// --- The dual-pane normalization: the off→on edge is a fact about the
// TRANSITION, so it is computed from the PAIR (prev → next).
//
// The edge used to be detected in the wiring by a shadow field (`lastDual`)
// that the very hook consuming it also updated — a state machine with no
// owner: the field only stayed in sync because the hook never failed, and
// the call site swallows a throwing hook. The decision now lives HERE (pure)
// and the previous value reaches it from the retheme module's `seen` record.

import { describe, expect, test } from "bun:test";
import { paneNormalizeAction } from "./panes";

describe("the dual-pane normalization", () => {
  test("turning dual pane on points the hidden pane at the active cwd", () => {
    // The hidden pane's cwd is stale from boot (both panes start at the
    // launch dir), so opening it at the active pane's current directory is
    // the expectation.
    expect(paneNormalizeAction({ prev: false, next: true, active: 0, activeCwd: "/a" })).toEqual({
      kind: "point-hidden-at",
      dir: "/a",
    });
  });

  test("the edge fires ONCE — a held-on pane keeps wherever the user took it", () => {
    // prev === next === true is NOT an edge: re-pointing pane 1 here would
    // wipe the user's navigation in it on every unrelated config apply.
    expect(paneNormalizeAction({ prev: true, next: true, active: 0, activeCwd: "/a" })).toEqual({ kind: "none" });
  });

  test("turning dual pane off re-clamps the active pane to the first", () => {
    // A hidden pane must never own input/status.
    expect(paneNormalizeAction({ prev: true, next: false, active: 1, activeCwd: "/b" })).toEqual({
      kind: "activate-first",
    });
    // already off, already on the first pane: nothing to do
    expect(paneNormalizeAction({ prev: false, next: false, active: 0, activeCwd: "/a" })).toEqual({ kind: "none" });
  });
});
