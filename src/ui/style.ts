// --- UI style seam: solid vs outline vs outline-partial ---
// Single vocabulary for how every chrome surface is painted. Call sites must
// not hand-roll bg/border ternaries; add new surface roles HERE so the three
// styles stay consistent.
//
// solid: every panel filled.
// outline: chrome panels get a rounded border ring with NO rest-state fills
//   (hover/selected/cut keep fills — tiles/rows/buttons are 1..5 rows tall
//   and a border ring needs 2, yoga reserves the ring via setBorder, which
//   would clip content). Floating layers are border-only too.
// outline-partial: outline everywhere EXCEPT floating layers (menus, cursor
//   popup, dialogs), which paint solid — an opaque island stays readable over
//   a live grid or a transparent terminal bg.
//   - input fields keep their fill in all modes (InputRenderable extends
//     TextareaRenderable and has no border support)
import type { Theme, UiStyle } from "../config/config-schema";

export type { UiStyle };

// outline-partial shares every BACKGROUND-chrome decision with outline —
// only floating layers differ (floatSurface below). Branch background-chrome
// choices on this, never on === "outline" directly, so a fourth style can't
// silently fall through to solid fills.
const isOutlineVariant = (style: UiStyle): boolean => style !== "solid";

// inner width available to children of the sidebar panel: outline variants'
// border ring reserves one cell per side (yoga setBorder)
export const sideInnerWidth = (style: UiStyle, sw: number): number => (isOutlineVariant(style) ? sw - 2 : sw);

type SurfaceState = "rest" | "hover" | "selected" | "cut";

type SurfaceOpts = {
  backgroundColor?: string;
  border?: boolean;
  borderStyle?: "rounded";
  borderColor?: string;
};

// chrome panels: sidebar / main region / preview. Floating layers have their
// own role below (floatSurface) — they are NOT chrome.
export const chromeSurface = (style: UiStyle, c: Theme, bg: string): SurfaceOpts =>
  isOutlineVariant(style) ? { border: true, borderStyle: "rounded", borderColor: c.border } : { backgroundColor: bg };

// floating layers (menus, cursor popup, dialogs): an opaque island over the
// desktop in every style EXCEPT pure outline, where they stay border-only
// (frozen outline behavior — see outline-partial for the readable variant)
export const floatSurface = (style: UiStyle, c: Theme, bg: string): SurfaceOpts =>
  style === "outline" ? { border: true, borderStyle: "rounded", borderColor: c.border } : { backgroundColor: bg };

// dual-pane focus cue: NONE. A tinted inactive pane (sidebarBg) painted over
// the main bg while that pane's tiles/empty states paint the main bg produced a
// patchwork in solid mode; focus is shown by the selection and the divider.

// grid tiles: rest goes bare in outline variants, interaction states keep fills
export const tileSurface = (style: UiStyle, c: Theme, state: SurfaceState): SurfaceOpts => {
  if (isOutlineVariant(style) && state === "rest") return {};
  return {
    rest: { backgroundColor: c.bg },
    hover: { backgroundColor: c.hoverBg },
    selected: { backgroundColor: c.accentBg },
    cut: { backgroundColor: c.bg },
  }[state];
};

// one-row list rows (places sidebar): can never carry a border, so only the
// rest fill disappears
export const rowSurface = (style: UiStyle, c: Theme, state: SurfaceState): SurfaceOpts => {
  if (isOutlineVariant(style) && state === "rest") return {};
  return {
    rest: { backgroundColor: c.sidebarBg },
    hover: { backgroundColor: c.hoverBg },
    selected: { backgroundColor: c.accentBg },
    cut: { backgroundColor: c.sidebarBg },
  }[state];
};

// 1-row buttons / crumbs. restBg = the fill that matches the surrounding
// panel (canvas bg for toolbar, sidebarBg inside dialogs); outline clears it
export const btnSurface = (style: UiStyle, c: Theme, hovered: boolean, restBg?: string): SurfaceOpts => {
  if (isOutlineVariant(style) && !hovered) return {};
  return { backgroundColor: hovered ? c.hoverBg : (restBg ?? c.bg) };
};

// raster slots flatten icons onto a bg hex; outline-variant rest states sit on
// the canvas, so the flatten target must be canvas bg instead of panel bg.
// Ignored when [ui] transparent-icons is on (the raster keeps its alpha and
// the key drops bg) — kept in IconState for call-site compat.
export const slotBg = (style: UiStyle, c: Theme, panelBg: string): string => (isOutlineVariant(style) ? c.bg : panelBg);

// post-mutation of real renderables (findDescendantById results). "transparent"
// clears a fill — parseColor maps it to alpha-0, which emits terminal-default
// bg for that cell.
export const applySurface = (node: any, opts: SurfaceOpts): void => {
  if (!node) return;
  try {
    node.backgroundColor = opts.backgroundColor ?? "transparent";
  } catch {}
  try {
    node.border = !!opts.border;
  } catch {}
  if (opts.borderStyle) {
    try {
      node.borderStyle = opts.borderStyle;
    } catch {}
  }
  if (opts.borderColor) {
    try {
      node.borderColor = opts.borderColor;
    } catch {}
  }
};
