// --- UI keys whose change needs NO full renderAll.
//
// A settings adjust that changes one of these must not clear and rebuild the
// sidebar/grid/preview: the consumers read config live on the next use, and
// the settings panel repaints the row's value text by id — a full rebuild is
// pure native-alloc churn (the esc-menu settings session was a documented OOM
// contributor). Everything else DEFAULTS to rebuild, so a newly added visual
// key is safe unless it is listed here.
//
// The list lives in the config layer (not inside the retheme factory) so it
// can be pinned against the schema: every name here MUST be a real [ui] key,
// or the exemption silently covers nothing and the knob rebuilds the world on
// every stepper click (the failure mode is invisible — nothing breaks, it is
// just slow).
export const RENDER_EXEMPT: ReadonlySet<string> = new Set<string>([
  "toastDurationMs",
  "doubleClickMs",
  "dragThresholdCells",
  "hoverZoneCells",
  "hoverOpenDelayMs",
  "hoverCloseDelayMs",
  "hoverAnimMs",
  "terminalHeight",
  "fileAnimation",
  "fileAnimationStyle",
  "fileAnimationMs",
  "fileAnimationStaggerPct",
  "fileAnimationSlideCells",
  "fileAnimationSlideDir",
  "fileAnimationEase",
  "fileAnimationScrollRevealDelayMs",
  "fileAnimationContainerFade",
  "fileAnimationVisibleOnly",
  "fileAnimationRowGranularity",
  "fileAnimationMaxFiles",
  "listingsCache",
  "listingsCacheStats",
  "listingsCacheTtl",
  // lazy-startup is boot-only (mounts/plugin paths run once at boot, warms
  // before first paint) — flipping it mid-session must not rebuild the world
  "lazyStartup",
  // device poll interval reads live per tick (devwatch arm closure) — the
  // stepper repaints its own value text, no rebuild, no watcher restart
  "devicePollMs",
  "fileHoverIncludeLabel",
  // fileHoverAnimation/direction are NOT exempt: the toggle + direction bake
  // tile layout at build (marginTop headroom + refs.hoverLift in
  // ui-grid-rows.ts, both in the grid content sig) — the live per-hover read
  // only covers the highlight/lift paint. Exempting them left the old tiles
  // in place until the next natural rebuild. ms/travel/ease/include-label stay
  // exempt: they ride live in the hover animator with no baked layout behind
  // them.
  "fileHoverMs",
  "fileHoverSlideCells",
  "fileHoverEase",
  "sidebarAnimation",
  "sidebarAnimationStyle",
  "sidebarAnimationMs",
  "sidebarAnimationSlideCells",
  "sidebarAnimationSlideDir",
  "sidebarAnimationStaggerPct",
  "sidebarAnimationEase",
  "sidebarAnimationIncludeTitle",
  "sidebarHoverAnimation",
  "sidebarHoverIncludeLabel",
  "sidebarHoverSlideDir",
  "sidebarHoverMs",
  "sidebarHoverSlideCells",
  "sidebarHoverEase",
  "topbarAnimation",
  "topbarAnimationStyle",
  "topbarAnimationMs",
  "topbarAnimationSlideCells",
  "topbarAnimationSlideDir",
  "topbarAnimationStaggerPct",
  "topbarAnimationEase",
  "directoryBarAnimation",
  "directoryBarAnimationStyle",
  "directoryBarAnimationMs",
  "directoryBarAnimationSlideCells",
  "directoryBarAnimationSlideDir",
  "directoryBarAnimationStaggerPct",
  "directoryBarAnimationEase",
  "smoothScrolling",
  "smoothScrollMs",
  // scrim reads live when a modal opens (wiring/core applyModalDim) — a flip
  // must not rebuild the world; onConfigApplied re-applies it if one is open
  "scrimMode",
  "scrimDim",
  "persistUndo",
  "restoreSession",
  "showLaunchTime",
  "typeToSearch",
]);
