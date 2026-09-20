// --- Quit: the single teardown path (tab-close-last, esc-menu, ctrl+q all
// route here). Order is load-bearing: drops disabled BEFORE the renderer dies
// so no OSC 72 frame is written to a dead terminal, and the XTSHIFTESCAPE
// request made at boot is released before exiting. Every step is
// best-effort — a throwing teardown must never strand the user in the TUI —
// but the exit code stays honest: 0 clean, 1 when any step threw (a masked
// teardown failure used to exit 0, hiding broken shutdowns from scripts). ---

export type QuitCtx = {
  disableDrops(): void;
  releaseShiftCapture(): void;
  // kill the embedded PTY pane — it would otherwise rely on EIO from the
  // dead master and a shell with a foreground child can linger
  closeTerminal?(): void;
  // close the gpm client socket (Linux text console only) so the daemon
  // doesn't re-point it at a default console after we're gone
  stopGpm?(): void;
  // synchronous final session write — process.exit kills pending async IO,
  // so the debounced 400ms save loses the last navigation
  flushSession?(): void;
  destroy(): void;
  exit(code: number): void;
  onQuit?: () => void;
};

export const makeQuit =
  (ctx: QuitCtx): (() => void) =>
  () => {
    let failed = runTeardownSteps(ctx);
    try {
      ctx.destroy();
    } catch {
      failed = true;
    }
    ctx.exit(failed ? 1 : 0);
  };

// --- The pre-destroy teardown steps, shared with restart (which runs them,
// then waits out the child, and only destroys/exits once it's gone). Order is
// load-bearing (see makeQuit) — keep the sequence here, not at call sites. ---
export const runTeardownSteps = (ctx: QuitCtx): boolean => {
  let failed = false;
  try {
    ctx.disableDrops();
  } catch {
    failed = true;
  }
  try {
    ctx.releaseShiftCapture();
  } catch {
    failed = true;
  }
  try {
    ctx.flushSession?.();
  } catch {
    failed = true;
  }
  try {
    ctx.closeTerminal?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopGpm?.();
  } catch {
    failed = true;
  }
  try {
    ctx.onQuit?.();
  } catch {
    failed = true;
  }
  return failed;
};
