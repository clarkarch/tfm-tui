import { describe, expect, test } from "bun:test";
import {
  OP_NOTIFY_MIN_MS,
  finishProgressPhase,
  progressActive,
  progressCancelled,
  progressCounting,
  progressPaused,
  resetProgressState,
  shouldNotifyTerminal,
  stopProgressPhase,
  type ProgressState,
} from "./file-op-protocol";

// The terminal-notification gate: a finished op reaches the desktop only
// when it took long enough that the user plausibly looked away, and NEVER
// when it was cancelled or partially failed (a notification that claims
// "done" for a half-finished op is a lie).

describe("shouldNotifyTerminal", () => {
  test("a long successful op notifies", () => {
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS, false, 0)).toBe(true);
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS + 1, false, 0)).toBe(true);
  });

  test("a quick op does not (the toast is still on screen)", () => {
    expect(shouldNotifyTerminal(0, false, 0)).toBe(false);
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS - 1, false, 0)).toBe(false);
  });

  test("a cancelled op never notifies", () => {
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS * 10, true, 0)).toBe(false);
  });

  test("a partially failed op never notifies", () => {
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS * 10, false, 1)).toBe(false);
  });
});

// The progress state is ONE phase, not four independent booleans. The old
// model let "paused AND cancelled" exist and needed TWO reset routines that
// cleared DIFFERENT field sets — the miss is exactly how a stale ✕ from an
// earlier op poisoned the next one ("Moved 0 items").
describe("ProgressState phase", () => {
  const makeState = (): ProgressState => ({
    phase: "idle",
    verb: "copying",
    doneFiles: 0,
    totalFiles: 0,
    bytes: 0,
    totalBytes: 0,
    currentRs: null,
    toastUp: false,
  });
  // read the phase through a widened getter: a direct `p.phase` read keeps
  // the literal narrowing from the last assignment, which makes `toBe` compare
  // against the wrong literal type.
  const phaseOf = (p: ProgressState): string => p.phase;

  test("reset clears EVERY op-level field", () => {
    const p = makeState();
    p.phase = "cancelling";
    p.verb = "deleting";
    p.doneFiles = 7;
    p.totalFiles = 9;
    p.bytes = 11;
    p.totalBytes = 13;

    resetProgressState(p);

    expect(phaseOf(p)).toBe("idle");
    expect(p.doneFiles).toBe(0);
    expect(p.totalFiles).toBe(0);
    expect(p.bytes).toBe(0);
    expect(p.totalBytes).toBe(0);
    // the phase predicates all read false after a reset
    expect(progressActive(p)).toBe(false);
    expect(progressPaused(p)).toBe(false);
    expect(progressCancelled(p)).toBe(false);
    expect(progressCounting(p)).toBe(false);
  });

  test("a reset never touches the toast's own lifetime", () => {
    // the toast has a DIFFERENT owner (the UI) and a DIFFERENT lifetime: a
    // re-show during the done-linger must REUSE the toast, not stack a
    // second one.
    const p = makeState();
    p.toastUp = true;
    resetProgressState(p);
    expect(p.toastUp).toBe(true);
  });

  test("one phase means one meaning: cancelled is not paused", () => {
    const p = makeState();
    p.phase = "cancelling";
    expect(progressCancelled(p)).toBe(true);
    expect(progressPaused(p)).toBe(false);
    p.phase = "paused";
    expect(progressPaused(p)).toBe(true);
    expect(progressCancelled(p)).toBe(false);
  });

  test("finish keeps the cancel fact; stop keeps it too", () => {
    const p = makeState();
    p.phase = "cancelling";
    finishProgressPhase(p);
    // a cancelled op stays cancelled after it unwinds — the summary reads it
    expect(progressCancelled(p)).toBe(true);

    const q = makeState();
    q.phase = "running";
    finishProgressPhase(q);
    expect(phaseOf(q)).toBe("done");
    expect(progressActive(q)).toBe(false);

    const r = makeState();
    r.phase = "cancelling";
    stopProgressPhase(r);
    expect(progressCancelled(r)).toBe(true);
  });

  test("the counting phase is active but is neither paused nor cancelled", () => {
    const p = makeState();
    p.phase = "counting";
    expect(progressActive(p)).toBe(true);
    expect(progressCounting(p)).toBe(true);
    expect(progressPaused(p)).toBe(false);
    expect(progressCancelled(p)).toBe(false);
  });
});
