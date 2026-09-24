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

import { type CliRenderer, createTimeline, engine, type JSAnimation } from "@opentui/core";
import type { HoverLiftOpts, Theme, UiStyle } from "../config/config-schema";
import type { SelTileRef } from "../input/selection";
import { TileVisual } from "../input/grid-input";
import { tileSurface } from "./style";
import { IconStateIdx, type IconSpec } from "./ui-slots";
import type { MaybeNode, NodeLike } from "../lib/node-like";

export type FileAnimStyle = "off" | "fade" | "slide" | "stagger" | "stagger-slide";
export type EaseKey = "linear" | "ease-out" | "ease-in-out";
export type SlideDir = "up" | "down" | "left" | "right";

// `translateY` is whole-cells only (fractional coords crash image draw), so the
// slide travel MUST be large: a 3-cell travel is just 4 integer positions over
// ~40 frames and reads as 3 jumps. A viewport-ish travel gives ~1 step/frame.
const SLIDE_FRACTION = 0.7;
const SLIDE_MIN = 8;
const SLIDE_MAX = 28;

// ceiling for the PER-NODE styles (fade without container-fade, stagger,
// stagger-slide): one native push per tile per frame. See play().
export const MAX_PER_NODE_ANIM = 1000;

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
// original timing. `rows`/`rowsTotal` are the grid-view ROW boxes: a
// row-major cascade on rows is visually identical to the per-tile one (tiles
// in one row are adjacent cascade indices) but animates cols-times fewer
// nodes — the huge-folder lag fix, gated by [ui] file-animation-row-granularity.
export type FileAnimTarget = {
  tiles: string[];
  rows?: string[];
  rowsTotal?: number;
  inner?: string | null;
  total?: number;
  // scroll-reveal: set by syncWindow for rows that just
  // ENTERED the window. Never animates the container (a grid-wide slide/fade
  // per notch would move the whole viewport — the entering set is a row or
  // two, per-node is trivial), maps plain "slide" onto stagger-slide, and
  // follows the edge the files crossed: bottom → rise up, top → drop in.
  enterFrom?: "top" | "bottom";
};

// What play() actually drove (null = it declined: off/maxFiles/empty/stop).
// Returned so syncWindow can reconcile its mount-time row staging with the
// set the wave owns — a parent row at opacity 0 hides per-file children.
export type FileAnimMode = "rows" | "tiles" | "container" | null;

// pure: the style/direction a reveal play resolves to. A horizontal user
// direction is kept (edge mapping only replaces the up/down defaults).
export const revealStyleMap = (
  style: FileAnimStyle,
  dir: SlideDir,
  enterFrom: "top" | "bottom",
): { style: FileAnimStyle; dir: SlideDir } => ({
  style: style === "slide" ? "stagger-slide" : style,
  dir: dir === "up" || dir === "down" ? (enterFrom === "top" ? "down" : "up") : dir,
});

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
  // [ui] file-animation-row-granularity: stagger styles animate grid ROWS
  // instead of tiles when the grid provides them (tradeoff: tiles inside one
  // row animate together — no per-tile micro-cascade within a row)
  rowsGranularity: boolean;
  // [ui] file-animation-max-files: skip the animation when the folder holds
  // more than this many files (any animation write bumps the render-list
  // revision, and the next frame re-walks EVERY node in the folder — the
  // whole-grid rewalk, not the animated-node count, is what lags on huge
  // folders). 0 = never skip.
  maxFiles: number;
};

type FileAnimCtx = {
  renderer: CliRenderer;
  byId(id: string): MaybeNode;
  opts(): FileAnimOpts;
};

export const makeFileAnim = (ctx: FileAnimCtx) => {
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let nodes: NodeLike[] = [];
  let cfg: FileAnimCfg = {};
  let style: FileAnimStyle = "fade";
  // full file count when `nodes` is a viewport-capped subset (0 = use nodes.length)
  let total = 0;

  const write = (node: NodeLike, f: { opacity: number; dx: number; dy: number }): void => {
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

  const play = (target: FileAnimTarget): FileAnimMode => {
    try {
      const o = ctx.opts();
      const vh = typeof ctx.renderer?.terminalHeight === "number" ? ctx.renderer.terminalHeight : 24;
      // max-files: the whole-grid render-list rewalk on every animation frame
      // scales with TOTAL files — over the knob, appear instantly instead of
      // janking through the animation (0 = the knob is off)
      const fileCount = Math.max(target?.total ?? 0, target?.tiles?.length ?? 0);
      if (o.maxFiles > 0 && fileCount > o.maxFiles) {
        stop();
        return null;
      }
      // slide (always) and fade (container-fade knob) move ONE container node;
      // stagger styles animate the per-tile list the grid capped to the
      // viewport — unless the grid handed us ROW boxes and the
      // row-granularity knob is on: same cascade look, cols-times fewer nodes
      // A reveal play is the exception: container moves are wrong per notch,
      // and plain "slide" maps to the edge-following stagger-slide curve.
      const enterFrom = target?.enterFrom ?? null;
      const reveal = enterFrom !== null;
      const rm = reveal ? revealStyleMap(o.style, o.dir, enterFrom) : { style: o.style, dir: o.dir };
      const useRows =
        (target?.rows?.length ?? 0) > 0 &&
        o.rowsGranularity &&
        (reveal || rm.style === "stagger" || rm.style === "stagger-slide");
      // NOTE: a reveal rides the row-granularity knob like everything else.
      // syncWindow pre-stages ROW nodes at mount, then reconciles with the
      // mode this returns: "rows" keeps the staged set, "tiles" releases it
      // (a row at opacity 0 would hide per-file children regardless — the
      // tiles self-stage via play's frame-0 pass, same as the delay-0 path).
      let container = !reveal && (rm.style === "slide" || (rm.style === "fade" && o.containerFade));
      // useRows already implies rows is non-empty (see useRows above), so the
      // empty fallback is unreachable-but-total rather than an assertion
      let ids = container && target?.inner ? [target.inner] : useRows ? (target?.rows ?? []) : (target?.tiles ?? []);
      if (rm.style === "off" || !(o.ms > 0) || ids.length === 0) {
        stop();
        return null;
      }
      // ponytail: the per-node styles cost one native opacity/translate push per
      // tile per frame (~13µs measured), so thousands of them is a multi-100ms
      // frame. The grid caps its list to the viewport, but that cap is a user
      // knob ([ui] file-animation-visible-only) — flip it off on a 10k folder
      // and the churn is back, which is the exact hang this ceiling exists for.
      // Over the ceiling with a container available, DEGRADE to the container
      // fade (one push/frame, still animates — "either lag or skip" was the
      // bug); the bare stop() survives only as the no-container defensive
      // guard. The one-container path is exempt because one push is one push.
      // Raise the per-node ceiling only with per-frame batching, not by taste.
      if (!container && ids.length > MAX_PER_NODE_ANIM) {
        if (target?.inner) {
          ids = [target.inner];
          container = true;
        } else {
          stop();
          return null;
        }
      }
      // only resolvable ids: an unresolved one has nothing to animate
      const resolved = ids.map((id) => ctx.byId(id)).filter((n): n is NodeLike => !!n);
      if (resolved.length === 0) {
        stop();
        return null;
      }
      const mode: FileAnimMode = container ? "container" : useRows ? "rows" : "tiles";
      // scroll-reveal continuity: a STILL-RUNNING wave
      // (same resolved style, and same dir where the dir is even used — the
      // slide-offset styles) is RETARGETED BY APPENDING — in-flight rows keep
      // fading while the new ones join the back of the cascade. Stopping and
      // restarting per notch snapped every entering row to rest a fraction
      // into its fade, which made the reveal unreadable during continuous
      // scroll (and froze any node missing from the new list). A finished
      // wave, a style flip or a slide-direction reversal settles the old set
      // first, then starts fresh — no half-faded node is left behind.
      const running = !!tl && holder.p < 1 && style === rm.style && !(style === "stagger-slide" && cfg.dir !== rm.dir);
      if (running) {
        for (const node of resolved) if (!nodes.includes(node)) nodes.push(node);
        // indices only ever grow, so earlier nodes' staggerLocal(i/n) moves
        // FORWARD (never rewinds) as the wave absorbs the new set
        total = Math.max(total, nodes.length);
      } else {
        settle();
        nodes = resolved;
        // rows keep their own total so the cascade timing matches the real row
        // count; tiles keep the full file count (viewport-capped list case);
        // a reveal cascades across just the entering set
        total = useRows ? Math.max(target?.rowsTotal ?? 0, nodes.length) : Math.max(target?.total ?? 0, nodes.length);
        style = rm.style;
        cfg = {
          dist: slideTravel(vh, o.slidePct),
          span: o.staggerPct / 100,
          ease: o.ease,
          dir: rm.dir,
        };
        ensure(o.ms);
        tl?.restart();
      }
      // stage frame 0 of the freshly added nodes synchronically — without
      // this they'd present one frame at full opacity before the first tick
      apply(holder.p);
      return mode;
    } catch {
      stop();
      return null;
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
  byId(id: string): MaybeNode;
  tileRefs(): Map<string, SelTileRef>;
  colors(): Theme;
  uiStyle(): UiStyle;
  setIconState(spec: IconSpec | undefined, idx: number): void;
  // clipboard cut-dim resolution (mirrors selection.setTileVisual)
  isCutKey?(key: string): boolean;
  hoverLiftOpts(): HoverLiftOpts;
};

type HoverCur = {
  key: string;
  refs: SelTileRef;
  node: MaybeNode;
  slot: MaybeNode;
  label: MaybeNode;
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

  const writeBg = (node: NodeLike, hex: string): void => {
    try {
      node.backgroundColor = hex === "transparent" ? "transparent" : hex;
    } catch {}
  };

  // A tile copied from a previous build may have been destroyed by a grid
  // rebuild, so only repaint the node refs when byId still resolves to them.
  const ownedNode = (cur: HoverCur | null): MaybeNode => {
    if (!cur) return null;
    try {
      const node = ctx.byId(cur.refs.tileId);
      return node === cur.node ? node : null;
    } catch {
      return null;
    }
  };
  const ownedSlot = (cur: HoverCur | null): MaybeNode => {
    if (!cur) return null;
    try {
      return cur.refs.iconSlotId ? ctx.byId(cur.refs.iconSlotId) : null;
    } catch {
      return null;
    }
  };
  const ownedLabel = (cur: HoverCur | null): MaybeNode => {
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
        const lab = ctx.byId(cur.refs.labelId);
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
          // hover-in lifts the label to white (readable on the hover fill);
          // hover-out restores the rest fg — same contract as setTileVisual
          const lab = ctx.byId(refs.labelId);
          if (lab) lab.fg = hovered ? offColors.white : restLabelFg(refs, key);
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
        // a repaint changing the hit grid re-fires a SYNTHETIC over on the
        // STATIONARY cursor (AGENTS OpenTUI rule), so playHover(key, true) can
        // arrive on a tile whose selection just flipped with NO out ever
        // firing: the owned lift must be released here, or the selected tile
        // stays nudged (the "hover stuck on select" bug) until the pointer
        // leaves it — a mouse-out that may never come when the click is the
        // last gesture before the user's eyes go to the preview/grid.
        if (current?.key === key) {
          dropLift(current);
          current = null;
        }
        return; // selection owns the icon/bg visuals
      }

      const colors = ctx.colors();
      const toHex = hovered ? colors.hoverBg : restTileBg(ctx.uiStyle(), colors);
      // icon raster + label flip instantly (hover-in never dims — cut only
      // applies at Rest, exactly like setTileVisual)
      try {
        ctx.setIconState(refs.iconSpec, hovered ? TileVisual.Hover : restIconIdx(refs, key));
        const lab = ctx.byId(refs.labelId);
        if (lab) lab.fg = hovered ? colors.white : restLabelFg(refs, key);
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
