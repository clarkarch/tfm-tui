// --- Boot sequence: the ordered async startup once the renderer exists.
// Order is load-bearing: resolution must land before the fixed boot nodes
// (they bake cell pixels), globs2 before the first listing (mime→icon),
// session restore BEFORE renderAll (the restored tabs drive it), system
// places before renderAll too (sidebar content). The launch-time toast is
// gated here (debug always shows it; config.ui.show-launch-time opt-in).
// Everything renderer-coupled arrives as an injected step so the sequence is
// testable with fakes. ---

export type BootCtx = {
  waitForResolution(): Promise<void>;
  buildLayout(): void;
  loadGlobs2(): Promise<void>;
  restoreSession(): void;
  loadSystemPlaces(): Promise<void>;
  renderAll(): void;
  debugTrace(): void;
  launchToast(): void;
  startHygiene(): void;
  wireSearchInput(): void;
  isDebug: boolean;
  showLaunchTime(): boolean;
};

export const runBoot = async (ctx: BootCtx): Promise<void> => {
  await ctx.waitForResolution();
  ctx.buildLayout();
  await ctx.loadGlobs2();
  ctx.restoreSession();
  await ctx.loadSystemPlaces();
  ctx.renderAll();
  if (ctx.isDebug) ctx.debugTrace();
  if (ctx.isDebug || ctx.showLaunchTime()) ctx.launchToast();
  ctx.startHygiene();
  ctx.wireSearchInput();
};
