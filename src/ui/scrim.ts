// --- Modal scrim plan: pure decisions for how the app dims behind a floating
// modal (esc menu, props, conflict, pick…). The wiring (wiring/core) applies
// the plan as `contentOpacity` on the `tfm-content` node.
//
// OpenTUI applies node opacity as ALPHA, so rasters under a dimmed ancestor
// composite translucently; the wiring instead keeps icon rasters opaque with a
// per-image placement opacity override (ImageRenderable.placementOpacity),
// while thumbnails inherit the fade. There is no "dim by colour" for a raster,
// and a full-screen overlay FILL deletes every covered raster (OpenTUI treats
// any drawn fill as occluding), so both modes are content fades.
import type { ScrimMode, TransparentBgMode } from "../config/config-schema";

export type ScrimPlan = {
  contentOpacity: number;
};

// `fill` reproduces the old RGBA(0,0,0,150) overlay's darkening as a fixed
// content fade (the overlay itself is gone: it deleted the rasters it covered).
const FILL_CONTENT_OPACITY = 1 - 150 / 255;

// The `dim` backdrop is the app-content node's opacity: opacity = 1 - dim/100,
// so a higher dim% fades the content further toward the backdrop (darker).
export const scrimPlan = (mode: ScrimMode, dimPct: number): ScrimPlan => {
  if (mode === "none") return { contentOpacity: 1 };
  if (mode === "fill") return { contentOpacity: FILL_CONTENT_OPACITY };
  const dim = Math.min(100, Math.max(0, dimPct));
  return { contentOpacity: 1 - dim / 100 };
};

// The renderer clear color the app establishes: transparent-bg on/force under a
// pixel-capable terminal ⇒ "transparent" (terminal shows through); otherwise
// the theme bg. ONE helper so boot, applyConfig, system-theme and the scrim
// restore can't drift.
export const backgroundClearColor = (transparentBg: TransparentBgMode, bg: string, isTty: boolean): string =>
  transparentBg !== "off" && !isTty ? "transparent" : bg;
