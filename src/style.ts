// --- UI style seam: solid vs outline surfaces ---
// Single vocabulary for how every chrome surface is painted. index.ts must not
// hand-roll bg/border ternaries; add new surface roles HERE so solid and
// outline stay consistent.
//
// outline mode rules:
//   - chrome panels (sidebar, main, preview, menus, dialogs): rounded border,
//     no background — the canvas shows through
//   - REST states everywhere lose their fill; hover/selected/cut KEEP fills
//     because tiles/rows/buttons are 1..5 rows tall and a border ring needs 2
//     (yoga reserves the ring via setBorder), which would clip content
//   - input fields keep their fill in both modes (InputRenderable extends
//     TextareaRenderable and has no border support)
import type { Theme } from "./config";

export type UiStyle = "solid" | "outline";

export type SurfaceState = "rest" | "hover" | "selected" | "cut";

export type SurfaceOpts = {
  backgroundColor?: string;
  border?: boolean;
  borderStyle?: "rounded";
  borderColor?: string;
};

// chrome panels: sidebar / main region / preview / menus / dialogs
export const chromeSurface = (style: UiStyle, c: Theme, bg: string): SurfaceOpts =>
  style === "outline"
    ? { border: true, borderStyle: "rounded", borderColor: c.border }
    : { backgroundColor: bg };

// grid tiles: rest goes bare in outline, interaction states keep fills
export const tileSurface = (style: UiStyle, c: Theme, state: SurfaceState): SurfaceOpts => {
  if (style === "outline" && state === "rest") return {};
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
  if (style === "outline" && state === "rest") return {};
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
  if (style === "outline" && !hovered) return {};
  return { backgroundColor: hovered ? c.hoverBg : restBg ?? c.bg };
};

// raster slots flatten icons onto a bg hex; outline rest states sit on the
// canvas, so the flatten target must be canvas bg instead of panel bg
export const slotBg = (style: UiStyle, c: Theme, panelBg: string): string =>
  style === "outline" ? c.bg : panelBg;

// post-mutation of real renderables (findDescendantById results). "transparent"
// clears a fill — parseColor maps it to alpha-0, which emits terminal-default
// bg for that cell.
export const applySurface = (node: any, opts: SurfaceOpts): void => {
  if (!node) return;
  try { node.backgroundColor = opts.backgroundColor ?? "transparent"; } catch {}
  try { node.border = !!opts.border; } catch {}
  if (opts.borderStyle) { try { node.borderStyle = opts.borderStyle; } catch {} }
  if (opts.borderColor) { try { node.borderColor = opts.borderColor; } catch {} }
};
