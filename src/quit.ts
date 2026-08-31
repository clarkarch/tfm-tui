// --- Quit: the single teardown path (tab-close-last, esc-menu, ctrl+q all
// route here). Order is load-bearing: drops disabled BEFORE the renderer dies
// so no OSC 72 frame is written to a dead terminal, and the XTSHIFTESCAPE
// request made at boot is released before exiting. Every step is
// best-effort — a throwing teardown must never strand the user in the TUI. ---

export type QuitCtx = {
  disableDrops(): void;
  releaseShiftCapture(): void;
  destroy(): void;
  exit(code: number): void;
};

export const makeQuit =
  (ctx: QuitCtx): (() => void) =>
  () => {
    try {
      ctx.disableDrops();
    } catch {}
    try {
      ctx.releaseShiftCapture();
    } catch {}
    try {
      ctx.destroy();
    } catch {}
    ctx.exit(0);
  };
