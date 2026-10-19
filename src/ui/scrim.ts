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
  // classic full-screen RGBA(0,0,0,150) overlay; the box opts into dimming the
  // image placements it covers (fillDimsImages) instead of deleting them
  fill: boolean;
};

// `fill` reproduces the old RGBA(0,0,0,150) overlay's darkening as a fixed
// content fade (the overlay itself is gone: it deleted the rasters it covered).
const FILL_CONTENT_OPACITY = 1 - 150 / 255;

// The `dim` backdrop is the app-content node's opacity: opacity = 1 - dim/100,
// so a higher dim% fades the content further toward the backdrop (darker).
export const scrimPlan = (mode: ScrimMode, dimPct: number): ScrimPlan => {
  if (mode === "none") return { contentOpacity: 1, fill: false };
  if (mode === "fill") return { contentOpacity: 1, fill: true };
  const dim = Math.min(100, Math.max(0, dimPct));
  return { contentOpacity: 1 - dim / 100, fill: false };
};

// the classic overlay color, made once (ui-boot-layout builds the node)
export const SCRIM_FILL_RGBA = [0, 0, 0, 150] as const;

// Full-screen fill overlay for [ui] scrim = "fill", built once at boot
// (ui-boot-layout) and toggled by wiring/core applyModalDim so a live mode
// change applies immediately. z sits just below the lowest modal panel
// (FLOAT_Z.escmenu = 3000) and above the app content (z 0): it dims everything
// while every modal panel still draws above it. The box passes the fork's
// fillDimsImages so the rasters it covers are dimmed, not deleted.
export const SCRIM_FILL_ID = "tfm-scrim-fill";
export const SCRIM_FILL_Z = 2999;

export type RasterDimPlan = {
  // Placement opacity override: 1 keeps an icon raster fully opaque while the
  // content node fades (its pixels are shaded instead), null inherits.
  opacity: number | null;
  // Foreground shade multiplied into the icon rasters at drain time. Shading
  // the baked pixels (instead of alpha-fading the placement) is what makes a
  // dimmed icon read as *darker*, not as the translucent `[ui] icons =
  // "transparent"` look.
  shade: number;
  // Background (the flattened square) shade. Stays 1 under `dim` because the
  // tile fill does not darken (bg over bg); under `fill` the overlay darkens
  // the cells, so the square must darken by the same amount or it pops.
  bgShade: number;
};

// Icon rasters under a scrim: never alpha-fade them (the fork's placement
// override keeps them opaque) and darken their baked pixels by the mode's
// factor so they dim along with the text.
export const rasterDimPlan = (mode: ScrimMode, contentOpacity: number): RasterDimPlan => {
  if (mode === "none") return { opacity: null, shade: 1, bgShade: 1 };
  if (mode === "fill") return { opacity: 1, shade: FILL_CONTENT_OPACITY, bgShade: FILL_CONTENT_OPACITY };
  const shade = Math.min(1, Math.max(0, contentOpacity));
  return { opacity: 1, shade, bgShade: 1 };
};

// The renderer clear color the app establishes: transparent-bg on/force under a
// pixel-capable terminal ⇒ "transparent" (terminal shows through); otherwise
// the theme bg. ONE helper so boot, applyConfig, system-theme and the scrim
// restore can't drift.
export const backgroundClearColor = (transparentBg: TransparentBgMode, bg: string, isTty: boolean): string =>
  transparentBg !== "off" && !isTty ? "transparent" : bg;
