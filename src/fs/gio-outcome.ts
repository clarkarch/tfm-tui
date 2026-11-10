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
// the app had already given up on. A timeout whose child wrote to stderr
// was reported as the child's error line, hiding the deadline too.
//
// The run now carries ONE interruption state and the outcome is derived
// from it ONCE. The DEADLINE wins over a cancel: it is the app's own
// decision to give up, and a cancel around it is a consequence (the user
// dismisses the credential prompt the killed child left open).
//
// Pure — no fs, no renderer, no config.

export type GioOutcome = "ok" | "cancelled" | "timed-out" | "failed";

// Why the run was interrupted. The two are NOT symmetric: the deadline is
// the app's own decision, a cancel is the user's.
export type GioInterruption = "cancelled" | "timed-out";

export type GioRunState = { kind: "running" } | { kind: "interrupted"; why: GioInterruption };

// The run's state holder — a record, so the interruption is ONE value with
// named phases (not a pair of booleans whose combination has to be guessed).
export type GioRun = { state: GioRunState };

export const makeGioRun = (): GioRun => ({ state: { kind: "running" } });

// Mark the run as interrupted. The DEADLINE wins over a cancel in BOTH
// orders: the app had given up on the operation either way, so reporting
// "timed out" names the deeper fact — a cancel around it is a consequence
// (the credential prompt the killed child left open).
export const markGioInterrupted = (run: GioRun, why: GioInterruption): void => {
  const cur = run.state;
  if (cur.kind === "running") {
    run.state = { kind: "interrupted", why };
    return;
  }
  if (why === "timed-out") run.state = { kind: "interrupted", why: "timed-out" };
};

// The run's outcome — decided ONCE, from the interruption (if any) and the
// child's exit code. An interrupted run NEVER reports ok: the child was
// killed, so its exit code says nothing about the operation.
export const gioOutcomeFor = (run: GioRun, code: number): GioOutcome => {
  const st = run.state;
  if (st.kind === "interrupted") return st.why === "timed-out" ? "timed-out" : "cancelled";
  return code === 0 ? "ok" : "failed";
};

// The exit code the RESULT carries. 130 is the shell's "interrupted" code
// (the cancel convention the old shape used) and 124 is `timeout(1)`'s
// "timed out" code — so a reader of the code alone still sees WHY.
export const gioExitCode = (outcome: GioOutcome, childCode: number): number => {
  if (outcome === "ok") return 0;
  if (outcome === "cancelled") return 130;
  if (outcome === "timed-out") return 124;
  return childCode;
};

// The user-facing reason for an interrupted run — the vocabulary lives HERE
// so the connect and disconnect toasts cannot drift apart. A plain failure
// has no interruption reason (the caller reports the child's own error
// line instead).
export const gioOutcomeMessage = (outcome: GioOutcome): string | null => {
  if (outcome === "timed-out") return "timed out";
  if (outcome === "cancelled") return "cancelled";
  return null;
};
