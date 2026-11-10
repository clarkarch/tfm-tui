// --- Boot sequence: the ordered async startup once the renderer exists.
// Order is load-bearing: resolution must land before the fixed boot nodes
// (they bake cell pixels), globs2 before the first listing (mime→icon),
// session restore BEFORE renderAll (the restored tabs drive it), system
// places before renderAll too (sidebar content). The launch-time toast is
// gated here (debug always shows it; config.ui.show-launch-time opt-in).
// Everything renderer-coupled arrives as an injected step so the sequence is
// testable with fakes. ---

import { debugLog } from "../lib/log";
import type { BootMode } from "../lib/boot-mode";

export type BootCtx = {
  waitForResolution(): Promise<void>;
  // restart child only (TFM_RESTART, wired in io.ts): delete the waiting
  // parent's kitty placements before anything draws — per-ID deletes can't
  // reach across processes (see kittyDeleteAllImages in ui-term)
  isRestartChild?: boolean;
  clearStaleImages?(): void;
  buildLayout(): void;
  // system (terminal-adaptive) theme: resolves AFTER the renderer answers its
  // first queries but BEFORE buildLayout bakes palette colors into the chrome
  // (optional — absent without follow-terminal). Guarded like every step.
  applyBootSystemTheme?(): Promise<boolean>;
  // mount plugin UI slots into the boot layout (after buildLayout, before the
  // first renderAll so contributions paint on the first frame)
  mountSlots?(): void;
  loadGlobs2(): Promise<void>;
  restoreSession(): void;
  loadSystemPlaces(): Promise<void>;
  // the first paint: sync + async steps (the grid build). May return a promise
  // — the boot awaits it so the app is revealed only once the frame is
  // COMPLETE (the "burst" startup).
  renderAll(): void | Promise<void>;
  // lazy mounts refresh: boot skips the ~200ms lsblk for first paint and this
  // fills the Devices rows in right after (optional — absent in old fakes)
  refreshMounts?(): void;
  // cold-boot-only sidebar intro (see ui-sidebar-anim): plays right after the
  // first renderAll so the staged frame 0 never flashes the finished sidebar
  playSidebarIntro?(): void;
  // cold-boot-only top bar intro (same module): plays right after the sidebar
  // intro, so both staged frame-0s land before the first presented frame
  playTopbarIntro?(): void;
  // reveal the app: the content node is transparent until the first frame is
  // COMPLETE, so the user never watches tfm assemble itself (the title +
  // background first, then the sidebar, then the grid, then the icons). Runs
  // AFTER the intros staged their frame-0 and BEFORE the default-file-manager
  // prompt dims the app. Absent = the app was never hidden.
  revealApp?(): void;
  // cold-boot-only default-file-manager opt-in (Yes/No/Ask-again): fires
  // after the intros so the user sees tfm first, before being asked to make
  // it the default. Absent = never asked (old fakes keep working). The verdict
  // probe is a SYNCHRONOUS xdg-mime spawn (see probeDefaultFileManagerSync) —
  // ~200ms of blocked event loop — so under lazy startup it runs AFTER the
  // launch report (non-essential for the first frame / first input).
  promptDefaultFileManager?(): void;
  // fire-and-forget update check (only starts one; never awaits the network)
  checkUpdates?(): void;
  // [ui] lazy-startup: the boot's MODE — the ONE value that picks the
  // startup shape (classic = the app paints in one burst; lazy = paint
  // first, the rest lands in the background). It is REQUIRED: the old shape
  // spelled it `lazyBoot?: boolean`, where "absent" meant classic, so a ctx
  // that forgot the mode silently ran the legacy boot. The wiring derives it
  // once from the config (see lib/boot-mode) and passes it down.
  mode: BootMode;
  debugTrace(): void;
  launchToast(): void;
  startHygiene(): void;
  // --debug paint trace: one line per frame that REPAINTED (the native's own
  // counters — what it cleared and why it took the full repaint path). The
  // step is debug-only: the subscription reads the renderer's stats on every
  // presented frame, which is not a production cost. Absent = no trace.
  startPaintTrace?(): void;
  wireSearchInput(): void;
  // a step threw (native OOM in buildLayout, globs2, …): log + notify so a
  // partial boot renders and reports instead of a blank-but-alive TUI
  reportBootError?(name: string, err: unknown): void;
  isDebug: boolean;
  showLaunchTime(): boolean;
};

// one boot step, isolated: a throw is logged/reported and the sequence
// continues — the first render must still happen even if a later step broke.
const guard = (ctx: BootCtx, name: string, fn: () => void | Promise<void>): Promise<void> => {
  const t0 = performance.now();
  const settle = () => debugLog(`bootstep: ${name} ${Math.round(performance.now() - t0)}ms`);
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r
        .then(() => settle())
        .catch((err) => {
          settle();
          debugLog(`boot ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
          ctx.reportBootError?.(name, err);
        });
    }
    settle();
    return Promise.resolve();
  } catch (err) {
    settle();
    debugLog(`boot ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    ctx.reportBootError?.(name, err);
    return Promise.resolve();
  }
};

export const runBoot = async (ctx: BootCtx): Promise<void> => {
  // ISO timestamps on every line give the full timeline, and guard logs a
  // `bootstep: <name> <ms>` duration per step — free profiling for slow-boot
  // reports (silent in production: debugLog no-ops without --debug)
  if (ctx.isRestartChild) await guard(ctx, "clearStaleImages", () => ctx.clearStaleImages?.());
  await guard(ctx, "waitResolution", () => ctx.waitForResolution());
  debugLog("boot: systemTheme");
  await guard(ctx, "systemTheme", () => {
    const p = ctx.applyBootSystemTheme?.();
    return p ? p.then(() => undefined) : undefined;
  });
  debugLog("boot: buildLayout");
  await guard(ctx, "buildLayout", () => ctx.buildLayout());
  await guard(ctx, "mountSlots", () => ctx.mountSlots?.());
  // globs2 (mime→icon for the listing) and system places (sidebar content) are
  // independent and both only need to land BEFORE renderAll — overlap them.
  // restoreSession stays ahead of renderAll (the restored tabs drive it).
  debugLog("boot: loadGlobs2 + loadSystemPlaces");
  await Promise.all([
    guard(ctx, "loadGlobs2", () => ctx.loadGlobs2()),
    guard(ctx, "loadSystemPlaces", () => ctx.loadSystemPlaces()),
  ]);
  debugLog("boot: restoreSession");
  await guard(ctx, "restoreSession", () => ctx.restoreSession());
  debugLog("boot: renderAll");
  await guard(ctx, "renderAll", () => ctx.renderAll());
  await guard(ctx, "refreshMounts", () => ctx.refreshMounts?.());
  await guard(ctx, "playSidebarIntro", () => ctx.playSidebarIntro?.());
  await guard(ctx, "playTopbarIntro", () => ctx.playTopbarIntro?.());
  // the reveal: the app content is transparent until now (the burst startup)
  await guard(ctx, "revealApp", () => ctx.revealApp?.());
  // --- the boot's tail. The ONE thing the mode decides is WHERE the
  // default-file-manager prompt lands: classic asks BEFORE the launch report
  // (the legacy order), lazy asks AFTER it — the verdict probe is a
  // SYNCHRONOUS xdg-mime spawn (~200ms of blocked event loop) and under lazy
  // it must not sit on the launch path (the first frame and the first input
  // must not wait for it). The old shape ran the SAME step at two positions,
  // picked by a boolean read twice with opposite polarity.
  const promptStep = (): Promise<void> =>
    guard(ctx, "promptDefaultFileManager", () => ctx.promptDefaultFileManager?.());
  const reportStep = async (): Promise<void> => {
    if (ctx.isDebug) await guard(ctx, "debugTrace", () => ctx.debugTrace());
    if (ctx.isDebug || ctx.showLaunchTime()) await guard(ctx, "launchToast", () => ctx.launchToast());
  };
  for (const step of ctx.mode === "classic" ? [promptStep, reportStep] : [reportStep, promptStep]) {
    await step();
  }
  await guard(ctx, "startHygiene", () => ctx.startHygiene());
  // the paint trace is a --debug diagnostic (it reads the renderer's stats on
  // every presented frame), so it only runs when the debug log is on
  if (ctx.isDebug) await guard(ctx, "startPaintTrace", () => ctx.startPaintTrace?.());
  await guard(ctx, "wireSearchInput", () => ctx.wireSearchInput());
  // updates LAST: a network question must never delay the first frame, the
  // launch report or the default-file-manager prompt (and it never blocks:
  // the step only starts the check)
  await guard(ctx, "checkUpdates", () => ctx.checkUpdates?.());
  // "boot: done" marks the ACTUAL end of the sequence — it used to fire
  // before the launch report, the hygiene poke, the search wiring and the
  // update check, so the debug timeline's last line was a lie in BOTH modes
  debugLog("boot: done");
};
