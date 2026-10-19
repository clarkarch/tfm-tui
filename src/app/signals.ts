// --- Terminal-close signals: closing the terminal sends SIGHUP (kill sends
// SIGTERM). Neither reached any tfm teardown — OpenTUI's handler only
// destroy()s the renderer (no process.exit, no PTY kill, no watcher close),
// so the orphaned process lived on with PPID 1 and deleted /dev/pts/N fds.
// This wires both signals to the FORCE quit (no isBusy refusal: the toast
// is invisible and refusing re-orphans). Re-entry guarded: two signals = one
// teardown.
//
// NOTE: this handler is best-effort, not the whole fix. Probed live: JS
// signal delivery past OpenTUI's native core is unreliable — the first
// SIGTERM/SIGHUP usually tears down the screen yet never reaches this
// handler (a repeat then works). The RELIABLE path is the renderer-closed
// fallback in index.ts, which runs the same force quit whenever destroy()
// completes without a quit having started it. ---
export const SIGNAL_QUIT_EVENTS = ["SIGHUP", "SIGTERM"] as const;

export const wireSignalQuit = (deps: { on: (event: string, cb: () => void) => void; quit: () => void }): void => {
  let quitOnce = false;
  const fire = (): void => {
    if (quitOnce) return;
    quitOnce = true;
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
