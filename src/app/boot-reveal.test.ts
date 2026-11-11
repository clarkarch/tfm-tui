// --- The boot's reveal: ONE owner, ONE state.
//
// The reveal makes the app visible in ONE frame (the clear color goes back
// first, then the content's opacity). It used to be two writes with NO state
// at all — so the boot's budget expiry (a hung network mount, a slow disk)
// revealed the app with an EMPTY/partial grid and nothing recorded that the
// app had appeared half-built. "Revealed" and "revealed COMPLETE" are
// different facts, and the second one is what a slow-boot report asks for.
//
// The state is a FACT, not a verdict:
//
//   "waiting"          — the app is not revealed yet
//   "revealed-complete"— the app is visible and the paint had settled
//   "revealed-partial" — the app is visible and the paint was STILL building
//
// (Under lazy startup "revealed-partial" is the EXPECTED state — the
// progressive arrival IS the feature — so the state names what happened, and
// never judges it.)

import { describe, expect, test } from "bun:test";
import { makeBootReveal } from "./boot-reveal";

const harness = (pending: () => number = () => 0, failHidden = false) => {
  const calls: string[] = [];
  const logs: string[] = [];
  const reveal = makeBootReveal({
    restoreBackgroundColor: () => calls.push("bg"),
    setBootHidden: (hidden) => {
      if (failHidden) throw new Error("node gone");
      calls.push(`hidden:${hidden}`);
    },
    pendingRenderSteps: pending,
    log: (m) => logs.push(m),
  });
  return { reveal, calls, logs };
};

describe("the boot's reveal state", () => {
  test("before the reveal the app is WAITING", () => {
    const { reveal } = harness();
    expect(reveal.state()).toBe("waiting");
  });

  test("a settled paint reveals COMPLETE", () => {
    const { reveal, calls } = harness(() => 0);
    reveal.reveal();
    expect(reveal.state()).toBe("revealed-complete");
    // the clear color is restored BEFORE the content is shown (one frame)
    expect(calls).toEqual(["bg", "hidden:false"]);
  });

  test("a paint still in flight reveals PARTIAL (the budget expired)", () => {
    // the boot gives up on a hung listing and reveals anyway — the app
    // appears with an empty grid, and that is now RECORDED (and logged)
    const { reveal, logs } = harness(() => 2);
    reveal.reveal();
    expect(reveal.state()).toBe("revealed-partial");
    expect(logs.some((l) => l.includes("partial"))).toBe(true);
  });

  test("the pending count is read AT THE REVEAL (the paint may settle first)", () => {
    // the count is a FACT about the reveal MOMENT, not a value captured when
    // the owner was built: the boot does more work between the paint and the
    // reveal (the intros), and the paint can settle in that window
    let pending = 1;
    const { reveal } = harness(() => pending);
    pending = 0;
    reveal.reveal();
    expect(reveal.state()).toBe("revealed-complete");
  });

  test("a failed reveal stays WAITING (the app never appeared)", () => {
    const { reveal } = harness(() => 0, true);
    expect(() => reveal.reveal()).toThrow();
    // the state must not claim a reveal that never happened
    expect(reveal.state()).toBe("waiting");
  });
});
