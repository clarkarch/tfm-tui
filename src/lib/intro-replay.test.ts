// --- The sidebar intro's REPLAY: a named state and a pure decision.
//
// The lazy mounts refresh rebuilds the sidebar right after the first paint
// (the row ids are index-keyed, so mounts shift every row below Devices):
// the fresh nodes never saw the intro's frame-0 staging, so the intro
// replays onto them — but ONLY while the boot intro is still young.
//
// The old shape kept the fact as a MAGIC TIMESTAMP (`introPlayedAt = 0`
// meant "never played") and decided the window inline in the wiring:
//
//   if (!introPlayedAt) return;
//   if (Date.now() - introPlayedAt > ms + 150) return;
//
// Two problems: "never played" was a magic value every reader had to know,
// and the DECISION was welded to the wiring — the clock was baked in (no
// test could advance it) and a non-numeric `ms` made the comparison NaN
// (always false → the replay fired on EVERY rebuild, including the
// navigate-time ones that must stay silent).
//
// The state is a NAMED record and the decision is PURE: the state records
// the FACT (the intro played, and when), the window is the POLICY.

import { describe, expect, test } from "bun:test";
import { INTRO_REPLAY_GRACE_MS, introReplayAllowed, type IntroReplayState } from "./intro-replay";

describe("the sidebar intro's replay", () => {
  test("an intro that never played never replays", () => {
    // the first renderAll's own build must not double the wave about to play.
    // The SMALL clock is the distinguishing case: under the old magic
    // timestamp (0) the age would be 100 — INSIDE the window — so a
    // "never played" intro would replay. The named state says it plainly.
    expect(introReplayAllowed("not-played", 100, 300)).toBe(false);
    expect(introReplayAllowed("not-played", 1000, 300)).toBe(false);
  });

  test("the replay is allowed inside the intro's window", () => {
    const state: IntroReplayState = { playedAt: 1000 };
    expect(introReplayAllowed(state, 1000, 300)).toBe(true);
    // the rebuild that follows the first paint lands a beat LATE (the mounts
    // load takes ~200ms), so the window outlives the animation itself
    expect(introReplayAllowed(state, 1000 + 300 + INTRO_REPLAY_GRACE_MS, 300)).toBe(true);
  });

  test("the replay stops once the window closes", () => {
    const state: IntroReplayState = { playedAt: 1000 };
    expect(introReplayAllowed(state, 1000 + 300 + INTRO_REPLAY_GRACE_MS + 1, 300)).toBe(false);
  });

  test("a zero-duration intro never replays (there is nothing to animate)", () => {
    // the animation module STOPS at ms <= 0 (it never runs), so a replay
    // would be a no-op — the decision says so instead of pretending
    const state: IntroReplayState = { playedAt: 1000 };
    expect(introReplayAllowed(state, 1000, 0)).toBe(false);
  });

  test("a non-numeric duration never replays", () => {
    // the old inline comparison made NaN > window FALSE → the replay fired
    // on every rebuild, and the navigate-time ones must stay silent
    const state: IntroReplayState = { playedAt: 1000 };
    expect(introReplayAllowed(state, 1000, Number.NaN)).toBe(false);
    expect(introReplayAllowed(state, 1000, undefined)).toBe(false);
  });

  test("a clock that moved backwards never replays", () => {
    // the old inline comparison treated the negative age as "inside the
    // window" — the replay stayed open until the clock caught up
    const state: IntroReplayState = { playedAt: 1000 };
    expect(introReplayAllowed(state, 900, 300)).toBe(false);
  });
});
