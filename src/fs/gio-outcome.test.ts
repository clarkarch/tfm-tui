// --- The `gio` run's OUTCOME: one value, one decision.
//
// A gio run has three possible endings and the old shape carried them as
// TWO BOOLEANS (`timedOut` × `cancelled`) that were mapped at the very end
// of the run — the MAP's order decided the report:
//
//   if (cancelled) return { code: 130, stdout: "", stderr: "cancelled" };
//   return { code, stdout: "", stderr: timedOut ? stderr || "timed out" : stderr };
//
// The live order (the deadline fires while the credential prompt is open;
// the user dismisses the still-open prompt afterwards) let the CANCEL win —
// so the timeout vanished and the user was told they had cancelled a mount
// the app had already given up on.
//
// The run now carries ONE interruption state and the outcome is derived
// from it ONCE. The DEADLINE wins over a cancel: it is the app's own
// decision to give up, and a cancel around it is a consequence (the user
// dismisses the credential prompt the killed child left open).

import { describe, expect, test } from "bun:test";
import { gioExitCode, gioOutcomeFor, makeGioRun, markGioInterrupted } from "./gio-outcome";

describe("the gio run's outcome", () => {
  test("a timeout after a cancel reports the timeout", () => {
    const run = makeGioRun();
    markGioInterrupted(run, "cancelled");
    markGioInterrupted(run, "timed-out");
    // the old `if (cancelled)` branch won, so the timeout was hidden
    expect(gioOutcomeFor(run, 143)).toBe("timed-out");
  });

  test("a cancel after a timeout still reports the timeout", () => {
    // the live order: the deadline fires while the prompt is open, and the
    // user dismisses the prompt afterwards
    const run = makeGioRun();
    markGioInterrupted(run, "timed-out");
    markGioInterrupted(run, "cancelled");
    expect(gioOutcomeFor(run, 143)).toBe("timed-out");
  });

  test("a cancel without a timeout reports the cancel", () => {
    const run = makeGioRun();
    markGioInterrupted(run, "cancelled");
    expect(gioOutcomeFor(run, 130)).toBe("cancelled");
  });

  test("the exit code decides ok vs failed when nothing interrupted the run", () => {
    expect(gioOutcomeFor(makeGioRun(), 0)).toBe("ok");
    expect(gioOutcomeFor(makeGioRun(), 1)).toBe("failed");
  });

  test("an interrupted run never reports ok", () => {
    // the child was killed — its exit code says nothing about the run
    const run = makeGioRun();
    markGioInterrupted(run, "timed-out");
    expect(gioOutcomeFor(run, 0)).toBe("timed-out");
  });

  test("the exit code the result carries names the outcome", () => {
    // 124 is `timeout(1)`'s "timed out" code and 130 the shell's
    // "interrupted" code — so a reader of the code alone still sees WHY
    expect(gioExitCode("timed-out", 143)).toBe(124);
    expect(gioExitCode("cancelled", 143)).toBe(130);
    // a plain failure keeps the child's own code
    expect(gioExitCode("failed", 3)).toBe(3);
    expect(gioExitCode("ok", 0)).toBe(0);
  });
});
