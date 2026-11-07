// The teardown lifecycle: live -> tearing-down -> exited.
//
// WHY this exists: "the app is shutting down" had NO state variable at all.
// Three unrelated booleans stood in for it:
//
//   - `quitOnce` in app/signals.ts   (one signal = one teardown)
//   - `rendererTornDown` in index.ts  (the renderer is gone)
//   - the exit chain in app/quit.ts   (the process is leaving)
//
// and a HELD ctrl+q ran the whole 11-step teardown N times, because the quit
// action had no autorepeat guard while the restart action right next to it
// did. Two overlapping teardowns call renderer.destroy() twice and start two
// exit chains.
//
// ONE owner, ONE compare-and-swap. The caller that WINS the transition runs
// the teardown; every other caller is a no-op.
//
// `abort()` exists for the restart's failed-spawn recovery: the restart runs
// the teardown steps BEFORE spawning the child, so a spawn failure has to
// put the app back into "live" or the session could never be quit again.

export type TeardownPhase = "live" | "tearing-down" | "exited";

export type TeardownState = {
  /** the current phase */
  get(): TeardownPhase;
  /** live -> tearing-down. TRUE only for the caller that won the race. */
  begin(): boolean;
  /** tearing-down -> exited */
  finish(): void;
  /** tearing-down -> live (a restart whose spawn failed) */
  abort(): void;
};

export const makeTeardownState = (): TeardownState => {
  let phase: TeardownPhase = "live";
  return {
    get: () => phase,
    begin: () => {
      if (phase !== "live") return false;
      phase = "tearing-down";
      return true;
    },
    finish: () => {
      phase = "exited";
    },
    abort: () => {
      // only a teardown IN FLIGHT can be reverted — an exited app stays exited
      if (phase === "tearing-down") phase = "live";
    },
  };
};
