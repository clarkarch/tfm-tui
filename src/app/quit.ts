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
  // clear pending chrome timers (sidebar device-reload) so they can't fire
  // loadSystemPlaces+renderAll into a destroyed renderer post-teardown
  stopChromeTimers?(): void;
  // aborts an in-flight update check (a pending fetch pins the event loop)
  stopUpdates?(): void;
  // stop the USB device poller (same reason: a poll landing post-teardown
  // re-lists + re-renders into the destroyed renderer)
  stopDevices?(): void;
  // close the cwd watchers (both panes hold an inotify watch that pins the
  // event loop — without this a SIGHUP-destroyed renderer still never exits)
  stopWatchers?(): void;
  // close the live config watcher (same pin as above)
  stopConfigWatch?(): void;
  // synchronous final session write — process.exit kills pending async IO,
  // so the debounced 400ms save loses the last navigation
  flushSession?(): void;
  destroy(): void;
  exit(code: number): void;
  // 0.6.0: destroy() returns at once but the terminal restoration + remaining
  // output finish later — exit must wait for renderer.closed or the restore
  // truncates (alt screen never unwinds). Absent = exit synchronously (fakes).
  // A rejected closed (stream failed mid-teardown) exits 1, never throws.
  closed?: () => Promise<void>;
  onQuit?: () => void;
  // file-op activity probe (wiring: shared queue depth) — refusing while
  // busy beats exiting mid-transfer (same reason restart refuses: completed
  // files would strand with no undo batch, .tfm-part-* swept only next run)
  isBusy?: () => boolean;
  // busy-refusal feedback (wiring: error toast). Best-effort, never throws.
  onBusy?: () => void;
};

export const makeQuit =
  (ctx: QuitCtx): (() => void) =>
  () => {
    if (ctx.isBusy?.()) {
      try {
        ctx.onBusy?.();
      } catch {}
      return;
    }
    let failed = runTeardownSteps(ctx);
    let destroyThrew = false;
    try {
      ctx.destroy();
    } catch {
      failed = true;
      destroyThrew = true;
    }
    // a throwing destroy never arms closed upstream (the close settles only
    // past destroy's internal arming) — waiting would hang forever instead
    // of exiting 1, so bypass the wait on that path
    exitAfterClosed(ctx, failed ? 1 : 0, destroyThrew);
  };

// --- Force quit for terminal-close signals (SIGHUP/SIGTERM): same teardown,
// same honest exit code, but NO isBusy refusal. The terminal is gone so the
// busy toast is invisible, and refusing would orphan the process exactly like
// the bug. Staged transfers (.tfm-part-*) sweep on next boot; source intact.
// The closed wait is capped: with the pts deleted the native close can stall
// on EIO instead of settling, and waiting forever re-orphans. A live terminal
// restores in ms, so the cap only bites the dead-terminal hang. ---
export const FORCE_QUIT_CLOSE_TIMEOUT_MS = 2000;
export const makeForceQuit =
  (ctx: QuitCtx): (() => void) =>
  () => {
    let failed = runTeardownSteps(ctx);
    let destroyThrew = false;
    try {
      ctx.destroy();
    } catch {
      failed = true;
      destroyThrew = true;
    }
    if (!ctx.closed || destroyThrew) {
      exitAfterClosed(ctx, failed ? 1 : 0, destroyThrew);
      return;
    }
    let closed: Promise<void>;
    try {
      closed = ctx.closed();
    } catch {
      try {
        ctx.exit(1);
      } catch {}
      return;
    }
    void Promise.race([
      closed,
      new Promise<void>((_, reject) => {
        const t = setTimeout(() => reject(new Error("force-quit close timeout")), FORCE_QUIT_CLOSE_TIMEOUT_MS);
        // a lingering timer pins the loop the teardown just drained — unref it
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]).then(
      () => {
        try {
          ctx.exit(failed ? 1 : 0);
        } catch {}
      },
      () => {
        try {
          ctx.exit(1);
        } catch {}
      },
    );
  };

// --- 0.6.0 destroy() returns at once while the terminal restore + remaining
// output finish later — exit must wait for renderer.closed or the restore
// truncates. Shared with restart's post-child path. A rejected closed (stream
// failed mid-teardown) exits 1, never throws. No `closed` seam (fakes) = exit
// synchronously. Quit/restart fire from sync contexts, so the wait chains.
// skipWait (destroy threw before arming closed) exits 1 at once — waiting
// would hang forever. The exit calls are guarded: a throwing exit inside the
// chain would otherwise become an unhandled rejection on the derived promise.
export const exitAfterClosed = (ctx: Pick<QuitCtx, "closed" | "exit">, code: number, skipWait = false): void => {
  if (!ctx.closed || skipWait) {
    try {
      ctx.exit(skipWait ? 1 : code);
    } catch {}
    return;
  }
  let closed: Promise<void>;
  try {
    closed = ctx.closed();
  } catch {
    try {
      ctx.exit(1);
    } catch {}
    return;
  }
  void closed.then(
    () => {
      try {
        ctx.exit(code);
      } catch {}
    },
    () => {
      try {
        ctx.exit(1);
      } catch {}
    },
  );
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
    ctx.stopChromeTimers?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopDevices?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopUpdates?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopWatchers?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopConfigWatch?.();
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
