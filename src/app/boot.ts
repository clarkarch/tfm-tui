// --- Boot sequence: the ordered async startup once the renderer exists.
// Order is load-bearing: resolution must land before the fixed boot nodes
// (they bake cell pixels), globs2 before the first listing (mime→icon),
// session restore BEFORE renderAll (the restored tabs drive it), system
// places before renderAll too (sidebar content). The launch-time toast is
// gated here (debug always shows it; config.ui.show-launch-time opt-in).
// Everything renderer-coupled arrives as an injected step so the sequence is
// testable with fakes. ---

import { debugLog } from "./log";

export type BootCtx = {
  waitForResolution(): Promise<void>;
  // restart child only (TFM_RESTART, wired in io.ts): delete the waiting
  // parent's kitty placements before anything draws — per-ID deletes can't
  // reach across processes (see kittyDeleteAllImages in ui-term)
  isRestartChild?: boolean;
  clearStaleImages?(): void;
  buildLayout(): void;
  // mount plugin UI slots into the boot layout (after buildLayout, before the
  // first renderAll so contributions paint on the first frame)
  mountSlots?(): void;
  loadGlobs2(): Promise<void>;
  restoreSession(): void;
  loadSystemPlaces(): Promise<void>;
  renderAll(): void;
  debugTrace(): void;
  launchToast(): void;
  startHygiene(): void;
  wireSearchInput(): void;
  // a step threw (native OOM in buildLayout, globs2, …): log + notify so a
  // partial boot renders and reports instead of a blank-but-alive TUI
  reportBootError?(name: string, err: unknown): void;
  isDebug: boolean;
  showLaunchTime(): boolean;
};

const bootLog = (msg: string): void => debugLog(msg);

// one boot step, isolated: a throw is logged/reported and the sequence
// continues — the first render must still happen even if a later step broke.
const guard = (ctx: BootCtx, name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.catch((err) => {
        bootLog(`boot ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        ctx.reportBootError?.(name, err);
      });
    }
    return Promise.resolve();
  } catch (err) {
    bootLog(`boot ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    ctx.reportBootError?.(name, err);
    return Promise.resolve();
  }
};

export const runBoot = async (ctx: BootCtx): Promise<void> => {
  // ISO timestamps on every line already give a full timeline in the debug
  // log — free profiling for slow-boot reports, silent in production
  if (ctx.isRestartChild) await guard(ctx, "clearStaleImages", () => ctx.clearStaleImages?.());
  await guard(ctx, "waitResolution", () => ctx.waitForResolution());
  bootLog("boot: buildLayout");
  await guard(ctx, "buildLayout", () => ctx.buildLayout());
  await guard(ctx, "mountSlots", () => ctx.mountSlots?.());
  bootLog("boot: loadGlobs2");
  await guard(ctx, "loadGlobs2", () => ctx.loadGlobs2());
  bootLog("boot: restoreSession");
  await guard(ctx, "restoreSession", () => ctx.restoreSession());
  bootLog("boot: loadSystemPlaces");
  await guard(ctx, "loadSystemPlaces", () => ctx.loadSystemPlaces());
  bootLog("boot: renderAll");
  await guard(ctx, "renderAll", () => ctx.renderAll());
  bootLog("boot: done");
  if (ctx.isDebug) await guard(ctx, "debugTrace", () => ctx.debugTrace());
  if (ctx.isDebug || ctx.showLaunchTime()) await guard(ctx, "launchToast", () => ctx.launchToast());
  await guard(ctx, "startHygiene", () => ctx.startHygiene());
  await guard(ctx, "wireSearchInput", () => ctx.wireSearchInput());
};
