// --- Content-area file animation: fade/slide the just-rebuilt tiles/rows in.
//
// The per-style curves are pure and tested; the factory wires ONE reused
// Timeline onto OpenTUI's frame loop (engine.attach) and writes every node's
// `opacity` + `translateY` from the current progress. Per-node opacity applies
// to cells AND kitty image placements (native buffer.zig drawImage reads
// getCurrentOpacity into the placement), so icon/thumbnail + label + bg fade
// together; translateY is a render-only offset (no yoga reflow).
//
// Reuse rules (same as ui-hover-drawer): never createTimeline per event — the
// engine's Set never unregisters; retarget the single timeline with restart().
//
// Live knobs ([ui] file-animation-*): the style is DERIVED from
// file-animation (master) + slide/stagger toggles (fileAnimStyleFrom); the
// curves read easing, slide distance/direction and stagger spread live at play

import { createTimeline, engine, type JSAnimation } from "@opentui/core";
import type { HoverLiftOpts, Theme, UiStyle } from "../config/config-schema";
import type { SelTileRef } from "../input/selection";
import { TileVisual } from "../input/grid-input";
import { tileSurface } from "./style";
import { IconStateIdx } from "./ui-slots";

export type FileAnimStyle = "off" | "fade" | "slide" | "stagger" | "stagger-slide";
export type EaseKey = "linear" | "ease-out" | "ease-in-out";
export type SlideDir = "up" | "down" | "left" | "right";

// `translateY` is whole-cells only (fractional coords crash image draw), so the
// slide travel MUST be large: a 3-cell travel is just 4 integer positions over
// ~40 frames and reads as 3 jumps. A viewport-ish travel gives ~1 step/frame.
const SLIDE_FRACTION = 0.7;
const SLIDE_MIN = 8;
const SLIDE_MAX = 28;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const outQuad = (p: number): number => p * (2 - p);
const smoothstep = (p: number): number => p * p * (3 - 2 * p);

export const easeAt = (k: EaseKey, p: number): number =>
  k === "linear" ? p : k === "ease-in-out" ? smoothstep(p) : outQuad(p);

// per-index local progress for the cascading styles; `span` = fraction of the
// timeline used to spread the cascade (0 = every tile at once). Shared with
// the sidebar intro (staggered place rows), so it lives here, not inline.
export const staggerLocal = (t: number, i: number, n: number, span: number): number => {
  const s = n > 1 ? span : 0;
  return clamp01(t * (1 + s) - (i / Math.max(1, n - 1)) * s);
};

// pure: renderable offsets are whole cells; a fractional translate breaks
// child image placement coords (see write())
export const quantizeDy = (dy: number): number => {
  if (!Number.isFinite(dy)) return 0;
  const q = Math.round(dy);
  // normalize -0: Math.round of a tiny negative is -0, and Object.is
  // distinguishes it from +0 (trips exact asserts, paints identically)
  return q === 0 ? 0 : q;
};

// pure: how far `slide` travels. Must be many cells: rounded to whole cells, a
// short travel has only a handful of positions and reads as a few jumps.
// `pct` is file-animation-slide-pct (0 = fade in place).
export const slideTravel = (viewportH: number, pct = 70): number => {
  if (!(pct > 0)) return 0;
  const vh = Number.isFinite(viewportH) ? viewportH : 24;
  const travel = Math.round(vh * SLIDE_FRACTION * (pct / 100));
  return Math.max(SLIDE_MIN, Math.min(Math.round(SLIDE_MAX * (pct / 100)), travel));
};

export type FileAnimFrame = { opacity: number; dx: number; dy: number };

// pure: the config toggles -> the style the curves run
export const fileAnimStyleFrom = (o: { enabled: boolean; slide: boolean; stagger: boolean }): FileAnimStyle =>
  !o.enabled ? "off" : o.slide && o.stagger ? "stagger-slide" : o.slide ? "slide" : o.stagger ? "stagger" : "fade";

export type FileAnimCfg = {
  dist?: number; // slide travel in cells (0 = no motion)
  span?: number; // stagger cascade spread, 0..1
  ease?: EaseKey;
  dir?: SlideDir;
};

// pure: opacity + offset (cells, + = below/right of final spot) of node `i`
// (of `n`) at raw progress `p` for the given style. The offset lands on the
// axis the direction names: up/down translate Y, left/right translate X.
export const fileAnimAt = (style: string, p: number, i: number, n: number, cfg: FileAnimCfg = {}): FileAnimFrame => {
  const { dist = 0, span = 0.4, ease = "ease-out", dir = "up" } = cfg;
  const e = (q: number): number => easeAt(ease, q);
  const horizontal = dir === "left" || dir === "right";
  // which way the slide STARTS: up = from below (+Y), down = from above (-Y),
  // left = from the left (-X), right = from the right (+X)
  const dirSign = dir === "down" || dir === "left" ? -1 : 1;
  const offset = (v: number): FileAnimFrame => {
    const travel = (1 - v) * dist * dirSign;
    return horizontal ? { opacity: v, dx: travel, dy: 0 } : { opacity: v, dx: 0, dy: travel };
  };
  if (style === "off") return { opacity: 1, dx: 0, dy: 0 };
  const t = clamp01(p);
  // exact endpoints: floating-point cascade math otherwise lands on
  // 0.9999999… at p=1 and leaves tiles a hair transparent until settle
  if (t >= 1) return { opacity: 1, dx: 0, dy: 0 };
  if (t <= 0) return style === "slide" || style === "stagger-slide" ? offset(0) : { opacity: 0, dx: 0, dy: 0 };
  if (style === "slide") {
    // uniform offset (NO per-index stagger): the whole grid shifts by the same
    // distance, so tiles never overlap mid-flight — a staggered slide would
    // paint each tile over its neighbour since rows don't clip
    return offset(e(t));
  }

  if (style === "stagger") return { opacity: e(staggerLocal(t, i, n, span)), dx: 0, dy: 0 };

  if (style === "stagger-slide") {
    // per-tile stagger: each file slides out of its own slot while fading, one
    // after another. Overlap with the neighbouring tile is hidden by the fade —
    // the tile it passes over is still invisible while this one moves.
    return offset(e(staggerLocal(t, i, n, span)));
  }

  return { opacity: e(t), dx: 0, dy: 0 };
};

// what the grid hands us: the tile ids to animate (fade/stagger/stagger-slide)
// plus the single grid-container id. Slide animates ONLY the container — one
// node, never the per-tile image placements, which is what made a per-tile
// translate churn on image-heavy folders; `containerFade` does the same for
// fade (one opacity push instead of one per file). `total` is the full file
// count when `tiles` is capped to the viewport, so the cascade keeps its
// original timing.
export type FileAnimTarget = { tiles: string[]; inner?: string | null; total?: number };

type FileAnimOpts = {
  style: FileAnimStyle;
  ms: number;
  staggerPct: number;
  slidePct: number;
  dir: SlideDir;
  ease: EaseKey;
  // [ui] file-animation-container-fade: fade the container node instead of
  // every tile (identical look, one per-frame opacity write/push)
  containerFade: boolean;
};

type FileAnimCtx = {
  renderer: any;
  byId(id: string): any;
  opts(): FileAnimOpts;
};

export const makeFileAnim = (ctx: FileAnimCtx) => {
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let nodes: any[] = [];
  let cfg: FileAnimCfg = {};
  let style: FileAnimStyle = "fade";
  // full file count when `nodes` is a viewport-capped subset (0 = use nodes.length)
  let total = 0;

  const write = (node: any, f: { opacity: number; dx: number; dy: number }): void => {
    try {
      node.opacity = Number.isFinite(f.opacity) ? f.opacity : 1;
      // renderable screen coords must be whole cells: a fractional translate
      // propagates to child image placements and OpenTUI's buffer.drawImage
      // rejects them ("x/y must be an integer") — the render loop then throws
      node.translateX = quantizeDy(f.dx);
      node.translateY = quantizeDy(f.dy);
    } catch {}
  };

  const apply = (raw: number): void => {
    const n = total > 0 ? total : nodes.length;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node) continue;
      const f = fileAnimAt(style, raw, i, n, cfg);
      write(node, f);
    }
  };

  const settle = (): void => {
    if (!nodes.length) return;
    for (const node of nodes) if (node) write(node, { opacity: 1, dx: 0, dy: 0 });
    // NO Bun.gc here: a synchronous full GC inside the settle frame stalls the
    // render loop (visible hitch on image-heavy folders). The 10s mem-hygiene
    // poke reclaims native buffers; an animation is far less churn than a theme
    // flip, which is where the eager gc is actually needed.
  };

  // cancel any running animation: unregister, snap the current nodes back to
  // rest, and forget the timeline so the next play re-registers it
  const stop = (): void => {
    if (tl) {
      try {
        engine.unregister(tl);
      } catch {}
    }
    tl = null;
    usedMs = -1;
    settle();
    nodes = [];
    total = 0;
  };

  // one item, recreated only when the duration changes (duration is baked at
  // add time); restart() retargets the node list without accumulating items
  const ensure = (ms: number): void => {
    if (tl && usedMs === ms) return;
    if (tl) {
      try {
        engine.unregister(tl);
      } catch {}
    }
    usedMs = ms;
    tl = createTimeline({ autoplay: false });
    tl.add(holder, {
      p: 1,
      duration: ms,
      ease: "linear",
      onUpdate: (a: JSAnimation) => apply(a.progress),
      onComplete: settle,
    });
  };

  const play = (target: FileAnimTarget): void => {
    try {
      const o = ctx.opts();
      const vh = typeof ctx.renderer?.terminalHeight === "number" ? ctx.renderer.terminalHeight : 24;
      // slide (always) and fade (container-fade knob) move ONE container node;
      // stagger styles animate the per-tile list the grid capped to the viewport
      const container = o.style === "slide" || (o.style === "fade" && o.containerFade);
      const ids = container && target?.inner ? [target.inner] : (target?.tiles ?? []);
      if (o.style === "off" || !(o.ms > 0) || ids.length === 0) {
        stop();
        return;
      }
      const resolved = ids.map((id) => ctx.byId(id)).filter(Boolean);
      if (resolved.length === 0) {
        stop();
        return;
      }
      nodes = resolved;
      total = Math.max(target?.total ?? 0, nodes.length);
      style = o.style;
      cfg = {
        dist: slideTravel(vh, o.slidePct),
        span: o.staggerPct / 100,
        ease: o.ease,
        dir: o.dir,
      };
      ensure(o.ms);
      tl?.restart();
    } catch {
      stop();
    }
  };

  try {
    engine.attach(ctx.renderer);
  } catch {}

  return { play, stop };
};

// --- Tile hover animation: move the icon on hover. The background highlight
// still snaps instantly (that's today's setTileVisual behavior) — the feature
// shifts the icon slot on hover and returns it on unhover, plus the exact same
// endpoints: hoverBg fill, hover icon raster, cut-dim on out for clipboard
// tiles.
//
// The resting layout is identical with the feature on or off — headroom is
// never reserved, so the feature only ever moves the hovered tile by one cell.
// Down/left/right stay inside their own tile (the build-time spare check
// guarantees the landing room). Up paints above the tile into the row above's
// empty bottom spare, which is why the grid marks first-row tiles unliftable
// (above them is toolbar chrome) — they keep the highlight only. A whole-cell
// translate cannot tween, so the lift is instant and there is no timeline.
//
// All operations are synchronous. Only ONE tile is "current" at a time; a new
// over settles the abandoned tile. An out always releases a lift we own
// (selection paints icon/bg, never translate, so a click that selected the
// tile must still drop the icon). Every node write is try/catch — tiles die on
// rebuilds.

// pure: the rest-state tile background per ui-style, sourced from the SAME
// surface seam setTileVisual paints through
export const restTileBg = (style: UiStyle, colors: Theme): string =>
  tileSurface(style, colors, "rest").backgroundColor ?? "transparent";

// pure: whole-cell hover offset for a direction — always exactly one cell,
// the terminal minimum (fractional offsets crash image draw: "y must be an
// integer"). Unknown directions never move.
export const hoverLiftDelta = (direction: string): { dx: number; dy: number } => {
  switch (direction) {
    case "up":
      return { dx: 0, dy: -1 };
    case "down":
      return { dx: 0, dy: 1 };
    case "left":
      return { dx: -1, dy: 0 };
    case "right":
      return { dx: 1, dy: 0 };
    default:
      return { dx: 0, dy: 0 };
  }
};

type TileHoverCtx = {
  byId(id: string): any;
  tileRefs(): Map<string, SelTileRef>;
  colors(): Theme;
  uiStyle(): UiStyle;
  setIconState(spec: any, idx: number): void;
  // clipboard cut-dim resolution (mirrors selection.setTileVisual)
  isCutKey?(key: string): boolean;
  hoverLiftOpts(): HoverLiftOpts;
};

type HoverCur = {
  key: string;
  refs: SelTileRef;
  node: any;
  slot: any;
  label: any;
};

export const makeTileHoverAnim = (ctx: TileHoverCtx) => {
  let current: HoverCur | null = null;

  // cut state is resolved like selection.setTileVisual: only unselected
  // clipboard tiles render dimmed
  const restIconIdx = (refs: SelTileRef, key: string): number => {
    const cut = !refs.selected && ctx.isCutKey?.(key) === true;
    return cut ? IconStateIdx.Cut : TileVisual.Rest;
  };
  const restLabelFg = (refs: SelTileRef, key: string): string =>
    !refs.selected && ctx.isCutKey?.(key) === true ? ctx.colors().sidebarFgMuted : refs.baseFg;

  const writeBg = (node: any, hex: string): void => {
    try {
      node.backgroundColor = hex === "transparent" ? "transparent" : hex;
    } catch {}
  };

  // A tile copied from a previous build may have been destroyed by a grid
  // rebuild, so only repaint the node refs when byId still resolves to them.
  const ownedNode = (cur: HoverCur | null): any => {
    if (!cur) return null;
    try {
      const node = ctx.byId(cur.refs.tileId);
      return node === cur.node ? node : null;
    } catch {
      return null;
    }
  };
  const ownedSlot = (cur: HoverCur | null): any => {
    if (!cur) return null;
    try {
      return cur.refs.iconSlotId ? ctx.byId(cur.refs.iconSlotId) : null;
    } catch {
      return null;
    }
  };
  const ownedLabel = (cur: HoverCur | null): any => {
    if (!cur) return null;
    try {
      return cur.refs.labelId ? ctx.byId(cur.refs.labelId) : null;
    } catch {
      return null;
    }
  };

  const dropLift = (cur: HoverCur | null): void => {
    if (!cur) return;
    const node = ownedNode(cur);
    if (!node) return;
    const slot = ownedSlot(cur);
    const label = ownedLabel(cur);
    try {
      if (slot) {
        slot.translateX = 0;
        slot.translateY = 0;
      }
      if (label) {
        label.translateX = 0;
        label.translateY = 0;
      }
    } catch {}
  };

  // repaint `cur` to its resting look: cut-dim icon + label when the tile is
  // on the clipboard (unselected), plain rest otherwise, plus the rest bg and a
  // released lift. Skips a selected tile entirely — selection owns its visuals.
  const restPaint = (cur: HoverCur | null): void => {
    if (!cur) return;
    try {
      const node = ownedNode(cur);
      if (!node) return;
      if (!cur.refs.selected) {
        ctx.setIconState(cur.refs.iconSpec, restIconIdx(cur.refs, cur.key));
        const lab: any = ctx.byId(cur.refs.labelId);
        if (lab) lab.fg = restLabelFg(cur.refs, cur.key);
        writeBg(node, restTileBg(ctx.uiStyle(), ctx.colors()));
      }
    } catch {}
    dropLift(cur);
  };

  const playHover = (key: string, hovered: boolean): void => {
    try {
      const refs = ctx.tileRefs().get(key);
      if (!refs) return;
      const node = ctx.byId(refs.tileId);
      if (!node) return;
      const slot = refs.iconSlotId ? ctx.byId(refs.iconSlotId) : null;
      const labNode = refs.labelId ? ctx.byId(refs.labelId) : null;
      const opts = ctx.hoverLiftOpts();

      if (!opts.enabled) {
        // feature off = today's instant snap, no lift
        if (current) {
          restPaint(current);
          current = null;
        }
        if (refs.selected) return; // selection owns the icon/bg visuals
        const offColors = ctx.colors();
        const offHex = hovered ? offColors.hoverBg : restTileBg(ctx.uiStyle(), offColors);
        try {
          ctx.setIconState(refs.iconSpec, hovered ? TileVisual.Hover : restIconIdx(refs, key));
          if (!hovered) {
            const lab: any = ctx.byId(refs.labelId);
            if (lab) lab.fg = restLabelFg(refs, key);
          }
          if (slot) {
            slot.translateX = 0;
            slot.translateY = 0;
          }
          if (labNode) {
            labNode.translateX = 0;
            labNode.translateY = 0;
          }
        } catch {}
        writeBg(node, offHex);
        return;
      }

      // an out ALWAYS releases a lift we own — selection paints icon/bg but
      // never translate, so a click that selected the tile still drops it
      if (!hovered) {
        if (current?.key === key) {
          dropLift(current);
          current = null;
        }
        if (refs.selected) return; // selection owns the icon/bg visuals
      } else if (refs.selected) {
        return; // selection owns the icon/bg visuals
      }

      const colors = ctx.colors();
      const toHex = hovered ? colors.hoverBg : restTileBg(ctx.uiStyle(), colors);
      // icon raster + label flip instantly (hover-in never dims — cut only
      // applies at Rest, exactly like setTileVisual)
      try {
        ctx.setIconState(refs.iconSpec, hovered ? TileVisual.Hover : restIconIdx(refs, key));
        if (!hovered) {
          const lab: any = ctx.byId(refs.labelId);
          if (lab) lab.fg = restLabelFg(refs, key);
        }
      } catch {}
      writeBg(node, toHex);

      // sweep: the pointer moved to another tile without an out landing first
      if (hovered && current && current.key !== key) restPaint(current);
      const delta = hoverLiftDelta(opts.direction);
      const lift = hovered && refs.hoverLift === true;
      try {
        if (slot) {
          slot.translateX = lift ? delta.dx : 0;
          slot.translateY = lift ? delta.dy : 0;
        }
        if (labNode) {
          const withLabel = lift && opts.includeLabel;
          labNode.translateX = withLabel ? delta.dx : 0;
          labNode.translateY = withLabel ? delta.dy : 0;
        }
      } catch {}
      current = hovered ? { key, refs, node, slot, label: labNode } : null;
    } catch {
      // never strand a lifted tile when an unexpected lookup/paint fails
      try {
        dropLift(current);
      } catch {}
      current = null;
    }
  };

  return { playHover };
};
