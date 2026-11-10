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
// Two problems: "never played" was a magic value every reader had to know
// (and a timestamp of 0 could not be told apart from "played at the epoch"),
// and the DECISION was welded to the wiring — the clock was baked in (no
// test could advance it) and a non-numeric `ms` made the comparison NaN
// (always false → the replay fired on EVERY rebuild, including the
// navigate-time ones that must stay silent).
//
// The state is a NAMED record and the decision is PURE: the state records
// the FACT (the intro played, and when), the window is the POLICY, and the
// clock is a PARAMETER (the caller supplies it).
//
// Pure — no config, no fs, no renderer.

export type IntroReplayState = "not-played" | { playedAt: number };

// The grace the window adds past the animation's own duration: the rebuild
// that follows the first paint lands a beat LATE (the mounts load takes
// ~200ms), so the window must outlive the animation itself.
export const INTRO_REPLAY_GRACE_MS = 150;

// The state after the intro has played — the ONE way to move the state.
export const introPlayed = (now: number): IntroReplayState => ({ playedAt: now });

// MAY the intro replay onto freshly built nodes?
//
//   - "not-played" → NO: the first renderAll's own build must not double the
//     wave about to play;
//   - a duration that is not a positive finite number → NO: there is
//     nothing to animate (the animation module STOPS at ms <= 0), and the
//     old inline comparison turned a non-numeric `ms` into NaN → the replay
//     fired on every rebuild;
//   - a clock that moved BACKWARDS → NO: we cannot say how young the intro
//     is, and the old comparison treated the negative age as "inside the
//     window" (the replay would stay open until the clock caught up);
//   - otherwise → YES while the intro is young (age <= duration + grace).
export const introReplayAllowed = (state: IntroReplayState, now: number, durationMs: unknown): boolean => {
  if (state === "not-played") return false;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return false;
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
  const age = now - state.playedAt;
  if (age < 0) return false;
  return age <= durationMs + INTRO_REPLAY_GRACE_MS;
};
