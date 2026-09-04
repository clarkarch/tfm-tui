// --- Boot sequence: the ordered async startup once the renderer exists.
// Order is load-bearing: resolution must land before the fixed boot nodes
// (they bake cell pixels), globs2 before the first listing (mime→icon),
// session restore BEFORE renderAll (the restored tabs drive it), system
// places before renderAll too (sidebar content). The launch-time toast is
// gated here (debug always shows it; config.ui.show-launch-time opt-in).
// Everything renderer-coupled arrives as an injected step so the sequence is
// testable with fakes. ---

import { debugLog } from "./log";

// First non-flag argv element is the launch dir (`tfm ~/some/path`); flags
// (--debug, --version, …) are skipped. Handles both layouts: `bun
// src/index.ts DIR` (argv[1] is the script) and the compiled binary `tfm DIR`
// (argv[1] is already the first user arg). Returns null when absent so
// callers keep process.cwd(). Pure (no fs probe here) — index.ts validates
// + chdirs.
export const launchDirFromArgv = (argv: string[]): string | null => {
  const args = argv.slice(1);
  if (args.length && /index\.[tj]s$/.test(args[0] as string)) args.shift();
  for (const a of args) {
    if (a.length > 0 && !a.startsWith("-")) return a;
  }
  return null;
};

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
  // ISO timestamps on every line already give a full timeline in the debug
  // log — free profiling for slow-boot reports, silent in production
  debugLog("boot: waitResolution");
  await ctx.waitForResolution();
  debugLog("boot: buildLayout");
  ctx.buildLayout();
  debugLog("boot: loadGlobs2");
  await ctx.loadGlobs2();
  debugLog("boot: restoreSession");
  ctx.restoreSession();
  debugLog("boot: loadSystemPlaces");
  await ctx.loadSystemPlaces();
  debugLog("boot: renderAll");
  ctx.renderAll();
  debugLog("boot: done");
  if (ctx.isDebug) ctx.debugTrace();
  if (ctx.isDebug || ctx.showLaunchTime()) ctx.launchToast();
  ctx.startHygiene();
  ctx.wireSearchInput();
};
