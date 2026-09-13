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

export type FileAnimStyle = "off" | "fade" | "slide" | "stagger" | "stagger-slide";
export type EaseKey = "linear" | "ease-out" | "ease-in-out";
export type SlideDir = "up" | "down" | "left" | "right";

// above this the per-frame churn + kitty image-placement restarts are not
// worth it; the grid just appears (ponytail: raise if it ever matters)
const MAX_ANIM_NODES = 600;
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
// timeline used to spread the cascade (0 = every tile at once)
const staggerLocal = (t: number, i: number, n: number, span: number): number => {
  const s = n > 1 ? span : 0;
  return clamp01(t * (1 + s) - (i / Math.max(1, n - 1)) * s);
};

// pure: renderable offsets are whole cells; a fractional translate breaks
// child image placement coords (see write())
export const quantizeDy = (dy: number): number => (Number.isFinite(dy) ? Math.round(dy) : 0);

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

// what the grid hands us: every tile id (fade/stagger/stagger-slide) plus the
// single grid-container id. Slide animates ONLY the container — one node, never
// the per-tile image placements, which is what made a per-tile translate churn
// on image-heavy folders.
export type FileAnimTarget = { tiles: string[]; inner?: string | null };

type FileAnimOpts = {
  style: FileAnimStyle;
  ms: number;
  staggerPct: number;
  slidePct: number;
  dir: SlideDir;
  ease: EaseKey;
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
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node) continue;
      const f = fileAnimAt(style, raw, i, nodes.length, cfg);
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
      // slide moves the whole grid as one container node; the rest are per-tile
      const isSlide = o.style === "slide";
      const ids = isSlide && target?.inner ? [target.inner] : (target?.tiles ?? []);
      if (o.style === "off" || !(o.ms > 0) || ids.length === 0 || ids.length > MAX_ANIM_NODES) {
        stop();
        return;
      }
      const resolved = ids.map((id) => ctx.byId(id)).filter(Boolean);
      if (resolved.length === 0) {
        stop();
        return;
      }
      nodes = resolved;
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
