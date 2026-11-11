// --- The boot's reveal: ONE owner, ONE state.
//
// The reveal makes the app visible in ONE frame — the renderer's clear color
// goes back to tfm's bg FIRST (it matched the TERMINAL's bg during the boot,
// so the intermediate frame was invisible), then the content's opacity
// follows. Both writes land in the same tick, so the app appears with its bg
// AND its widgets in one go.
//
// The reveal used to be two writes with NO state at all. The boot's wait is
// BOUNDED (a hung network mount must not leave the app invisible forever),
// so the budget expiry reveals the app with an EMPTY/partial grid — and
// nothing recorded that the app had appeared half-built. "Revealed" and
// "revealed COMPLETE" are different facts, and a slow-boot report needs the
// second one.
//
// The state is a FACT, not a verdict:
//
//   "waiting"           — the app is not revealed yet
//   "revealed-complete" — the app is visible and the paint had settled
//   "revealed-partial"  — the app is visible and the paint was STILL building
//
// (Under lazy startup "revealed-partial" is the EXPECTED state — the
// progressive arrival IS the feature — so the state names what happened and
// never judges it.)

export type RevealState = "waiting" | "revealed-complete" | "revealed-partial";

export type BootRevealCtx = {
  restoreBackgroundColor(): void;
  setBootHidden(hidden: boolean): void;
  // the render's async steps still in flight AT THE REVEAL MOMENT (0 = the
  // paint settled). REQUIRED: a missing seam would silently report every
  // reveal as complete.
  pendingRenderSteps(): number;
  // diagnostics (the debug log): a partial reveal is worth a line
  log?(msg: string): void;
};

export type BootReveal = {
  // the reveal's state — the ONE truth about what the reveal meant
  state(): RevealState;
  reveal(): void;
};

export const makeBootReveal = (ctx: BootRevealCtx): BootReveal => {
  let state: RevealState = "waiting";
  return {
    state: () => state,
    reveal: () => {
      // the count is read HERE, not when the owner was built: the boot does
      // more work between the paint and the reveal (the intros), and the
      // paint can settle in that window
      const pending = ctx.pendingRenderSteps();
      ctx.restoreBackgroundColor();
      ctx.setBootHidden(false);
      // recorded AFTER the writes: a throwing write leaves the state at
      // "waiting" (the app never appeared) instead of claiming a reveal
      state = pending > 0 ? "revealed-partial" : "revealed-complete";
      ctx.log?.(
        state === "revealed-partial"
          ? `boot reveal: partial — ${pending} render step(s) still pending`
          : "boot reveal: complete",
      );
    },
  };
};
