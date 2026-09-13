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

import { createTimeline, engine, type JSAnimation } from "@opentui/core";

export type FileAnimStyle = "off" | "fade" | "slide" | "stagger";

// above this the per-frame churn + kitty image-placement restarts are not
// worth it; the grid just appears (ponytail: raise if it ever matters)
const MAX_ANIM_NODES = 600;
// fraction of the timeline spent spreading the cascade in `stagger`
const STAGGER_SPAN = 0.4;
// `translateY` is whole-cells only (fractional coords crash image draw), so the
// slide travel MUST be large: a 3-cell travel is just 4 integer positions over
// ~40 frames and reads as 3 jumps. A viewport-ish travel gives ~1 step/frame.
const SLIDE_FRACTION = 0.7;
const SLIDE_MIN = 8;
const SLIDE_MAX = 28;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const outQuad = (p: number): number => p * (2 - p);

// per-index local progress for the cascading styles
const staggerLocal = (t: number, i: number, n: number): number => {
  const span = n > 1 ? STAGGER_SPAN : 0;
  return clamp01(t * (1 + span) - (i / Math.max(1, n - 1)) * span);
};

// pure: renderable offsets are whole cells; a fractional translateY breaks
// child image placement coords (see write())
export const quantizeDy = (dy: number): number => (Number.isFinite(dy) ? Math.round(dy) : 0);

// pure: how far `slide` travels. Must be many cells: rounded to whole cells, a
// short travel has only a handful of positions and reads as a few jumps.
export const slideTravel = (viewportH: number): number =>
  Math.max(SLIDE_MIN, Math.min(SLIDE_MAX, Math.round((Number.isFinite(viewportH) ? viewportH : 24) * SLIDE_FRACTION)));

export type FileAnimFrame = { opacity: number; dy: number };

// pure: opacity + vertical offset (cells, + = below final spot) of node `i`
// (of `n`) at raw progress `p` for the given style. `dist` is the travel for
// the distance-based styles.
export const fileAnimAt = (style: string, p: number, i: number, n: number, dist = 0): FileAnimFrame => {
  if (style === "off") return { opacity: 1, dy: 0 };
  const t = clamp01(p);
  // exact endpoints: floating-point cascade math otherwise lands on
  // 0.9999999… at p=1 and leaves tiles a hair transparent until settle
  if (t >= 1) return { opacity: 1, dy: 0 };
  if (t <= 0) return { opacity: 0, dy: style === "slide" ? dist : 0 };
  if (style === "slide") {
    // uniform offset (NO per-index stagger): the whole grid shifts by the same
    // dy, so tiles never overlap mid-flight — a staggered slide would paint each
    // tile over the row beneath it since rows don't clip
    const e = outQuad(t);
    return { opacity: e, dy: (1 - e) * dist };
  }

  if (style === "stagger") return { opacity: outQuad(staggerLocal(t, i, n)), dy: 0 };
  return { opacity: outQuad(t), dy: 0 };
};

// what the grid hands us: every tile id (fade/stagger) plus the single
// grid-container id. Slide animates ONLY the container — one node, never the
// per-tile image placements, which is what made a per-tile translate churn on
// image-heavy folders.
export type FileAnimTarget = { tiles: string[]; inner?: string | null };

type FileAnimCtx = {
  renderer: any;
  byId(id: string): any;
  style(): string;
  ms(): number;
};

export const makeFileAnim = (ctx: FileAnimCtx) => {
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let nodes: any[] = [];
  let style: FileAnimStyle = "fade";

  const write = (node: any, opacity: number, dy: number): void => {
    try {
      node.opacity = Number.isFinite(opacity) ? opacity : 1;
      // renderable screen coords must be whole cells: a fractional translateY
      // propagates to child image placements and OpenTUI's buffer.drawImage
      // rejects them ("y must be an integer") — the render loop then throws
      node.translateY = quantizeDy(dy);
    } catch {}
  };

  const apply = (raw: number): void => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node) continue;
      const vh = typeof ctx.renderer?.terminalHeight === "number" ? ctx.renderer.terminalHeight : 24;
      // only slide travels; fade/stagger touch opacity only
      const dist = style === "slide" ? slideTravel(vh) : 0;
      const f = fileAnimAt(style, raw, i, nodes.length, dist);
      write(node, f.opacity, f.dy);
    }
  };

  const settle = (): void => {
    if (!nodes.length) return;
    for (const node of nodes) if (node) write(node, 1, 0);
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
      const s = ctx.style();
      const ms = ctx.ms();
      // slide moves the whole grid as one container node; fade/stagger are per-tile
      const ids = s === "slide" && target?.inner ? [target.inner] : (target?.tiles ?? []);
      if (s === "off" || !(ms > 0) || ids.length === 0 || ids.length > MAX_ANIM_NODES) {
        stop();
        return;
      }
      const resolved = ids.map((id) => ctx.byId(id)).filter(Boolean);
      if (resolved.length === 0) {
        stop();
        return;
      }
      nodes = resolved;
      style = s as FileAnimStyle;
      ensure(ms);
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
