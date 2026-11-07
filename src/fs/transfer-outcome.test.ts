import { describe, expect, test } from "bun:test";
import {
  mayRemoveTarget,
  needsRemovalOnly,
  noOutcome,
  outcomeId,
  outcomeLanded,
  outcomeSourceRemovalFailed,
  type TransferOutcome,
} from "./transfer-outcome";

// The per-item state of a copy/move: did the copy land, and may the
// half-copy cleanup remove the target?
//
// The OLD model encoded this as THREE parallel variables (`copiedHere`,
// `copyId`, `sourceRemovalFailed`), so "the copy landed AND the source
// removal failed AND the target may still be deleted" was representable —
// and that combination is TOTAL DATA LOSS: after a partial `rm(src)` the
// target is the only complete copy, and deleting it destroys everything.
//
// One value, one meaning. The illegal combination is unrepresentable.
describe("TransferOutcome", () => {
  test("nothing landed yet: no cleanup, no removal-only retry", () => {
    const o = noOutcome();
    expect(mayRemoveTarget(o)).toBe(false);
    expect(needsRemovalOnly(o)).toBe(false);
    expect(outcomeId(o)).toBe(null);
  });

  test("a landed copy may be removed by the half-copy cleanup", () => {
    const o = outcomeLanded({ dev: 1, ino: 2 });
    expect(mayRemoveTarget(o)).toBe(true);
    expect(needsRemovalOnly(o)).toBe(false);
    expect(outcomeId(o)).toEqual({ dev: 1, ino: 2 });
  });

  test("a landed copy with no reported identity is still a landed copy", () => {
    // the copy engine could not report an inode — the copy still landed and
    // the cleanup gate must still ask "is the target still ours?" before it
    // touches anything.
    const o = outcomeLanded(null);
    expect(mayRemoveTarget(o)).toBe(true);
    expect(outcomeId(o)).toBe(null);
  });

  test("a failed source removal forbids removing the target (it is the only complete data)", () => {
    const o = outcomeSourceRemovalFailed({ dev: 1, ino: 2 });
    expect(mayRemoveTarget(o)).toBe(false);
    expect(needsRemovalOnly(o)).toBe(true);
    expect(outcomeId(o)).toEqual({ dev: 1, ino: 2 });
  });

  test("landed and sourceRemovalFailed are mutually exclusive", () => {
    // the invariant the three booleans could not express: a target is
    // either removable by the cleanup or it is the only complete data.
    const landed: TransferOutcome = outcomeLanded({ dev: 1, ino: 2 });
    const failed: TransferOutcome = outcomeSourceRemovalFailed({ dev: 1, ino: 2 });
    expect(mayRemoveTarget(landed)).toBe(true);
    expect(mayRemoveTarget(failed)).toBe(false);
    expect(needsRemovalOnly(landed)).toBe(false);
    expect(needsRemovalOnly(failed)).toBe(true);
  });
});
