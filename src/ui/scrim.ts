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

// The app content's presentation: ONE state, ONE owner.
//
// Two facts used to paint the same screen: the boot's hide (the "burst"
// startup — the content starts transparent and the boot reveals it once the
// first frame is COMPLETE, so the user never watches tfm assemble itself)
// and the modal's dim (a modal fades the app behind it). They were TWO
// owners with TWO writers: the boot wrote the content's opacity, the modal
// wrote the opacity AND the scrim fill AND the icon rasters' shade — so in
// the overlap they disagreed, and a modal opened while the boot still hid
// the app left the scrim FILL painting over an INVISIBLE app (the boot's
// intermediate frame is meant to show the TERMINAL's background, not a
// tfm-colored screen that fills in a beat later).
//
// ONE phase now owns the presentation, and the WHOLE presentation is
// computed from it:
//   "hidden-for-boot" — the app is not on screen yet: nothing paints (not
//                      the content, not the scrim fill, and the rasters are
//                      not re-rastered for a shade nobody can see).
//   "dimmed"          — a modal is open: the content fades (or the fill
//                      overlay paints) and the rasters darken with it.
//   "visible"         — no modal: the content is fully opaque.
export type ContentVisibility = "hidden-for-boot" | "dimmed" | "visible";

// The boot's reveal: the boot hide is over, so a modal that is still open
// dims the app that comes back.
export const revealVisibility = (modalOpen: boolean): ContentVisibility => (modalOpen ? "dimmed" : "visible");

// A modal open/close: the boot hide wins as a WHOLE — while the app is not
// on screen the modal's dim has nothing to dim (and the scrim fill would
// paint a screen the boot is still hiding).
export const modalVisibility = (current: ContentVisibility, open: boolean): ContentVisibility =>
  current === "hidden-for-boot" ? "hidden-for-boot" : open ? "dimmed" : "visible";

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

// The WHOLE presentation one phase paints: the content node's opacity, the
// scrim fill's visibility and the icon rasters' shade. ONE function, so a
// state can never paint half of itself (the old split wrote the opacity
// from one owner and the fill + the shade from another).
export type ContentPresentation = {
  opacity: number;
  fill: boolean;
  raster: RasterDimPlan;
};

export const contentPresentation = (
  visibility: ContentVisibility,
  mode: ScrimMode,
  dimPct: number,
): ContentPresentation => {
  const plan = scrimPlan(mode, dimPct);
  if (visibility === "hidden-for-boot") {
    // the app is not on screen: NOTHING paints — the content stays
    // transparent, the scrim fill stays hidden, and the rasters are not
    // re-rastered for a shade nobody can see
    return { opacity: 0, fill: false, raster: { opacity: null, shade: 1, bgShade: 1 } };
  }
  if (visibility === "dimmed") {
    return { opacity: plan.contentOpacity, fill: plan.fill, raster: rasterDimPlan(mode, plan.contentOpacity) };
  }
  return { opacity: 1, fill: false, raster: { opacity: null, shade: 1, bgShade: 1 } };
};

// The renderer clear color the app establishes: transparent-bg on/force under a
// pixel-capable terminal ⇒ "transparent" (terminal shows through); otherwise
// the theme bg. ONE helper so boot, applyConfig, system-theme and the scrim
// restore can't drift.
export const backgroundClearColor = (transparentBg: TransparentBgMode, bg: string, isTty: boolean): string =>
  transparentBg !== "off" && !isTty ? "transparent" : bg;

// The renderer's clear color DURING the boot hide (the burst startup): the
// TERMINAL's own background ("transparent" = the terminal's default bg shows
// through), so the intermediate frame — the one the renderer presents while
// the app is still hidden — is INVISIBLE. The user sees their terminal bg,
// not a tfm-colored screen that fills in a beat later. The reveal restores
// the app's own clear color (backgroundClearColor) in the same tick.
export const bootClearColor = (
  hidden: boolean,
  transparentBg: TransparentBgMode,
  bg: string,
  isTty: boolean,
): string => (hidden ? "transparent" : backgroundClearColor(transparentBg, bg, isTty));
