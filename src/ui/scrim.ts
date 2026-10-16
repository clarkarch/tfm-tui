// --- Modal scrim plan: pure decisions for how the app dims behind a floating
// modal (esc menu, props, conflict, pick…). The wiring (wiring/core) applies
// it — `contentOpacity` on the `tfm-content` node and, for `dark`, a
// near-black renderer clear. Kept renderer-free so it's unit-testable.
//
// OpenTUI's node opacity is applied as ALPHA (kitty placements re-transmit at
// the reduced alpha), so any container dim makes rasters read through — there
// is no "dim by colour" for a raster. `dark` therefore pairs the fade with a
// near-black clear so thumbnails read as *dimmed* rather than see-through to
// the themed background behind them. ---
import type { ScrimMode, TransparentBgMode } from "../config/config-schema";

export type ScrimPlan = {
  contentOpacity: number;
  // classic full-screen RGBA(0,0,0,150) overlay; OpenTUI deletes rasters under
  // it, so `fill` implies the glyph fallback (setScrim) replaces them
  fill: boolean;
};

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
// while every modal panel still draws above it.
export const SCRIM_FILL_ID = "tfm-scrim-fill";
export const SCRIM_FILL_Z = 2999;

// The renderer clear color the app establishes: transparent-bg on/force under a
// pixel-capable terminal ⇒ "transparent" (terminal shows through); otherwise
// the theme bg. ONE helper so boot, applyConfig, system-theme and the scrim
// restore can't drift.
export const backgroundClearColor = (transparentBg: TransparentBgMode, bg: string, isTty: boolean): string =>
  transparentBg !== "off" && !isTty ? "transparent" : bg;
