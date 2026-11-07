// --- Terminal-close signals: closing the terminal sends SIGHUP (kill sends
// SIGTERM). Neither reached any tfm teardown — OpenTUI's handler only
// destroy()s the renderer (no process.exit, no PTY kill, no watcher close),
// so the orphaned process lived on with PPID 1 and deleted /dev/pts/N fds.
// This wires both signals to the FORCE quit (no isBusy refusal: the toast
// is invisible and refusing re-orphans).
//
// The re-entry guard is the SHARED teardown state (src/lib/teardown-state.ts)
// — the ONE owner of "the app is shutting down". The handler used to keep a
// private `quitOnce` boolean: a second state machine for the same fact, which
// could disagree with the quit path's own guard (the quit path's CAS wins,
// the handler's boolean was a separate copy of the same knowledge).
//
// NOTE: this handler is best-effort, not the whole fix. Probed live: JS
// signal delivery past OpenTUI's native core is unreliable — the first
// SIGTERM/SIGHUP usually tears down the screen yet never reaches this
// handler (a repeat then works). The RELIABLE path is the renderer-closed
// fallback in index.ts, which runs the same force quit whenever destroy()
// completes without a quit having started it. ---
import type { TeardownState } from "../lib/teardown-state";

export const SIGNAL_QUIT_EVENTS = ["SIGHUP", "SIGTERM"] as const;

export const wireSignalQuit = (deps: {
  on: (event: string, cb: () => void) => void;
  quit: () => void;
  // the app-wide teardown state — the ONE owner of "is the app shutting down"
  teardown: TeardownState;
}): void => {
  const fire = (): void => {
    // READ-ONLY check: the force quit's own compare-and-swap is what claims
    // the transition, so the handler must never claim it here (a claimed
    // transition would make the quit's CAS refuse and NOTHING would tear
    // down). This check only avoids ASKING for a teardown that is already
    // running — two signals must not queue two teardowns.
    if (deps.teardown.get() !== "live") return;
    try {
      deps.quit();
    } catch {}
  };
  for (const event of SIGNAL_QUIT_EVENTS) {
    try {
      deps.on(event, fire);
    } catch {}
  }
};
