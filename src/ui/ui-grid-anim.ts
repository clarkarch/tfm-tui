// --- Content-area file animation: fade/slide the just-rebuilt tiles/rows in.
//
// The per-style curves are pure and tested; the factory wires ONE reused
// Timeline onto the renderer's own timeline engine (0.6.0
// getTimelineEngine — the shared `engine` singleton belongs to React/Solid)
// and writes every node's `opacity` + `translateY` from the current progress. Per-node opacity applies
// to cells AND kitty image placements (native buffer.zig drawImage reads
// getCurrentOpacity into the placement), so icon/thumbnail + label + bg fade
// together; translateY is a render-only offset (no yoga reflow).
//
// Reuse rules (same as ui-hover-drawer): never createTimeline per event — the
// engine's Set never unregisters; retarget the single timeline with restart().
//
// Live knobs ([ui] file-animation-*): the style is DERIVED from
// file-animation (master) + slide/stagger toggles (fileAnimStyleFrom); the
// curves read easing, travel/direction and spread live at play

import { type CliRenderer, createTimeline, engine, getTimelineEngine, type JSAnimation } from "@opentui/core";
import type { HoverLiftOpts, Theme, TransparentBgMode, UiStyle } from "../config/config-schema";
import type { SelTileRef } from "../input/selection";
import { TileVisual } from "../input/grid-input";
import { tileSurface } from "./style";

import { IconStateIdx } from "../lib/icon-state";
import type { MaybeNode, NodeLike } from "../lib/node-like";

export type FileAnimStyle = "off" | "fade" | "slide" | "stagger" | "stagger-slide";
export type EaseKey = "linear" | "ease-out" | "ease-in-out";
export type SlideDir = "up" | "down" | "left" | "right";

// `translateY` is whole-cells only (fractional coords crash image draw), so a
// slide travel should be a good handful of cells; `file-animation-slide-cells`
// is the knob (0 = fade in place).

// ceiling for the PER-NODE styles (fade without container-fade, stagger,
// stagger-slide): one native push per tile per frame. See play().
export const MAX_PER_NODE_ANIM = 1000;

import { clamp01 } from "../lib/uiutil";
import type { IconSpec } from "../lib/icon-state";

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

export type FileAnimFrame = { opacity: number; dx: number; dy: number };

// pure: the master toggle + style enum -> the style the curves run. The enum
// matches the panel intros (sidebar/topbar/directory bar) exactly; only the
// master can turn it off.
export const fileAnimStyleFrom = (o: { enabled: boolean; style: string }): FileAnimStyle =>
  !o.enabled ? "off" : o.style === "slide" || o.style === "stagger" || o.style === "stagger-slide" ? o.style : "fade";

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
  slideCells: number;
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

// The wave — ONE record. It holds everything the animator needs to draw and
// retarget a wave: the timeline, the progress, the style + curve config, the
// node set and the cascade total. The seven parallel variables it replaces
// (tl, usedMs, holder, nodes, cfg, style, total) could disagree: `stop()`
// reset every one of them but the PROGRESS, so the next wave's timeline
// captured a stale p=1 as its animation start value — the wave never moved
// again and the append gate (`p < 1`) stayed false forever (restart-per-notch,
// the "reveal doesn't work" regression). The progress dies WITH the wave now.
type WaveRunning = {
  kind: "running";
  // the timeline that drives the wave (null only between the wave's creation
  // and its timeline's — a synchronous window inside play())
  tl: ReturnType<typeof createTimeline> | null;
  // the animated progress (0..1): the wave's own clock, and the append gate's
  // only question ("is this wave still running?")
  holder: { p: number };
  style: FileAnimStyle;
  cfg: FileAnimCfg;
  nodes: NodeLike[];
  // full file count when `nodes` is a viewport-capped subset (0 = nodes.length)
  total: number;
};
type Wave = { kind: "idle" } | WaveRunning;

export const makeFileAnim = (ctx: FileAnimCtx) => {
  // 0.6.0: per-renderer timeline engine — the shared `engine` singleton is
  // driven by the last React/Solid render(), so imperative modules must own
  // theirs. The engine is captured once here (a fake renderer without a frame
  // loop keeps the legacy default-engine path below — those tests drive
  // `engine.update` directly and never attach).
  let owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null = null;
  try {
    if (typeof ctx.renderer?.setFrameCallback === "function") owner = getTimelineEngine(ctx.renderer);
  } catch {}
  // the wave in flight — ONE record (idle = nothing is animating)
  let wave: Wave = { kind: "idle" };

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

  // draw one frame of a wave. The wave is passed IN: a timeline's callback
  // may only ever touch ITS OWN wave (a stale timeline settling the live
  // wave's nodes would snap a running wave to rest).
  const applyWave = (w: WaveRunning, raw: number): void => {
    const n = w.total > 0 ? w.total : w.nodes.length;
    for (let i = 0; i < w.nodes.length; i++) {
      const node = w.nodes[i];
      if (!node) continue;
      const f = fileAnimAt(w.style, raw, i, n, w.cfg);
      write(node, f);
    }
  };

  // snap a wave's nodes back to rest
  const settleWave = (w: WaveRunning): void => {
    for (const node of w.nodes) if (node) write(node, { opacity: 1, dx: 0, dy: 0 });
    // NO Bun.gc here: a synchronous full GC inside the settle frame stalls the
    // render loop (visible hitch on image-heavy folders). The 10s mem-hygiene
    // poke reclaims native buffers; an animation is far less churn than a theme
    // flip, which is where the eager gc is actually needed.
  };

  // the LIVE wave's rest (the timeline callbacks settle their OWN wave)
  const settle = (): void => {
    if (wave.kind !== "running") return;
    settleWave(wave);
  };

  // cancel any running animation: unregister, snap the current nodes back to
  // rest, and drop the wave — its progress dies WITH it (a stale p=1 would be
  // captured by the next wave's timeline and freeze it)
  const stop = (): void => {
    if (wave.kind !== "running") return;
    const w = wave;
    if (w.tl) {
      try {
        (owner ?? engine).unregister(w.tl);
      } catch {}
    }
    settleWave(w);
    wave = { kind: "idle" };
  };

  const play = (target: FileAnimTarget): FileAnimMode => {
    try {
      const o = ctx.opts();
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
      if (
        wave.kind === "running" &&
        wave.holder.p < 1 &&
        wave.style === rm.style &&
        !(wave.style === "stagger-slide" && wave.cfg.dir !== rm.dir)
      ) {
        for (const node of resolved) if (!wave.nodes.includes(node)) wave.nodes.push(node);
        // indices only ever grow, so earlier nodes' staggerLocal(i/n) moves
        // FORWARD (never rewinds) as the wave absorbs the new set
        wave.total = Math.max(wave.total, wave.nodes.length);
      } else {
        settle();
        // a FRESH wave: the old one leaves the engine, the new one starts at
        // progress 0 — the timeline captures that as its animation start value
        // (a stale p=1 would freeze the wave where it stood)
        if (wave.kind === "running" && wave.tl) {
          try {
            (owner ?? engine).unregister(wave.tl);
          } catch {}
        }
        const w: WaveRunning = {
          kind: "running",
          tl: null,
          holder: { p: 0 },
          style: rm.style,
          cfg: {
            dist: Math.max(0, Math.round(o.slideCells)),
            span: o.staggerPct / 100,
            ease: o.ease,
            dir: rm.dir,
          },
          nodes: resolved,
          // rows keep their own total so the cascade timing matches the real row
          // count; tiles keep the full file count (viewport-capped list case);
          // a reveal cascades across just the entering set
          total: useRows
            ? Math.max(target?.rowsTotal ?? 0, resolved.length)
            : Math.max(target?.total ?? 0, resolved.length),
        };
        wave = w;
        // real renderer: register on the owner engine (per-renderer frame
        // loop); fakes keep the legacy default-engine path (never attached,
        // stepped via engine.update in tests)
        const tl = owner ? createTimeline({ autoplay: false }, ctx.renderer) : createTimeline({ autoplay: false });
        w.tl = tl;
        tl.add(w.holder, {
          p: 1,
          duration: o.ms,
          ease: "linear",
          onUpdate: (a: JSAnimation) => applyWave(w, a.progress),
          onComplete: () => settleWave(w),
        });
        tl.restart();
      }
      // stage frame 0 of the freshly added nodes synchronically — without
      // this they'd present one frame at full opacity before the first tick
      if (wave.kind === "running") applyWave(wave, wave.holder.p);
      return mode;
    } catch {
      stop();
      return null;
    }
  };

  // Renderer-owned engine attach already happened in getTimelineEngine()
  // above; a renderer without a frame loop (unit-test fakes) takes the
  // default-engine path (the wave's timeline is never attached).
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
// surface seam setTileVisual paints through (force included — a mouse-out
// under force must release to transparent, not to the theme fill)
export const restTileBg = (style: UiStyle, colors: Theme, transparentBg?: TransparentBgMode): string =>
  tileSurface(style, colors, "rest", transparentBg).backgroundColor ?? "transparent";

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

// pure: the hover travel = the direction unit vector scaled by `cells` (0 =
// no motion).
export const hoverOffset = (direction: string, cells: number): { dx: number; dy: number } => {
  const d = hoverLiftDelta(direction);
  const c = Number.isFinite(cells) && cells > 0 ? Math.round(cells) : 0;
  // `|| 0` normalizes -0 (Object.is distinguishes it; paints identically)
  return { dx: d.dx * c || 0, dy: d.dy * c || 0 };
};

// One reused hover timeline (same rules as makeFileAnim: owner-engine once,
// restart() to retarget, never createTimeline per event). `run` transitions a
// 0..1 progress from `from` to `to` and hands the EASED value to `apply`; a
// non-positive `ms` applies the end state synchronously — the historical
// instant snap (a tween lags a fast mouse sweep).
export const makeHoverTween = (getRenderer: () => CliRenderer) => {
  let owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null = null;
  let ownerResolved = false;
  const resolveOwner = (): Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null => {
    if (ownerResolved) return owner;
    ownerResolved = true;
    try {
      const r = getRenderer();
      if (typeof r?.setFrameCallback === "function") owner = getTimelineEngine(r);
    } catch {}
    return owner;
  };
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let applyCb: ((p: number) => void) | null = null;
  let doneCb: (() => void) | null = null;

  const stop = (): void => {
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    tl = null;
    usedMs = -1;
    applyCb = null;
    doneCb = null;
  };

  const ensure = (ms: number): void => {
    if (tl && usedMs === ms) return;
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    usedMs = ms;
    const r = getRenderer();
    owner = resolveOwner();
    tl = owner ? createTimeline({ autoplay: false }, r) : createTimeline({ autoplay: false });
    tl.add(holder, {
      p: 1,
      duration: Math.max(1, ms),
      ease: "linear",
      onUpdate: (a: JSAnimation) => applyCb?.(a.progress),
      onComplete: () => doneCb?.(),
    });
  };

  const run = (
    ms: number,
    ease: EaseKey,
    from: number,
    to: number,
    apply: (p: number) => void,
    done?: () => void,
  ): void => {
    applyCb = (prog: number) => apply(easeAt(ease, from + (to - from) * prog));
    doneCb = done ?? null;
    if (!(ms > 0)) {
      applyCb(1);
      const d = doneCb;
      stop();
      d?.();
      return;
    }
    ensure(ms);
    holder.p = 0;
    applyCb(0);
    tl?.restart();
  };

  return { run, stop };
};

type TileHoverCtx = {
  renderer: () => CliRenderer;
  byId(id: string): MaybeNode;
  tileRefs(): Map<string, SelTileRef>;
  colors(): Theme;
  uiStyle(): UiStyle;
  setIconState(spec: IconSpec | undefined, idx: number): void;
  // clipboard cut-dim resolution (mirrors selection.setTileVisual)
  isCutKey?(key: string): boolean;
  hoverLiftOpts(): HoverLiftOpts;
  // transparent-bg force: rest repaints release to transparent. Optional so
  // test fakes keep working.
  transparentForce?(): boolean;
};

type HoverCur = {
  key: string;
  refs: SelTileRef;
  node: MaybeNode;
};

// WHO owns the hover visuals right now — ONE record, ONE release path:
//   none      — we own nothing (the tile is at rest)
//   paint     — we own this tile's hover paint (icon/label/bg + the lift)
//   selection — the selection owns this tile's visuals; the hover never
//               paints them (a selected tile keeps the selection's look)
type HoverOwner = { kind: "none" } | { kind: "paint"; key: string; cur: HoverCur } | { kind: "selection"; key: string };

export const makeTileHoverAnim = (ctx: TileHoverCtx) => {
  // ONE owner record. The old code had THREE sources of truth for "who owns
  // the hover paint" (`current`, `refs.selected`, the feature on/off flag) and
  // three copies of "drop the lift we own" — so a branch could release one
  // owner and strand another (a lift owned for a DIFFERENT key survived a
  // selection change; the feature-off branch cleared the owner without
  // dropping the lift).
  let owner: HoverOwner = { kind: "none" };
  // one reused tween drives the hover-in glide when duration > 0 (ms 0 = snap)
  const tween = makeHoverTween(ctx.renderer);

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

  // settle the nudge on a tile: the icon (and the label, when it rides) go
  // back to rest. The slot/label are resolved by id, so a rebuilt tile's
  // fresh nodes are the ones settled.
  const settle = (cur: HoverCur): void => {
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

  const dropLift = (cur: HoverCur | null): void => {
    if (!cur) return;
    const node = ownedNode(cur);
    if (!node) return;
    tween.stop();
    settle(cur);
  };

  // transparent-bg force as a surface-seam value (absent = today's behavior)
  const tForce = (): TransparentBgMode | undefined => (ctx.transparentForce?.() ? "force" : undefined);

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
        writeBg(node, restTileBg(ctx.uiStyle(), ctx.colors(), tForce()));
      }
    } catch {}
    dropLift(cur);
  };

  // ONE release path: what we owned before this event that we no longer own.
  // Returns true when the owner SURVIVES the event — a late mouse-out for a
  // DIFFERENT tile says nothing about the tile we are still hovering, so the
  // owner record must not be dropped (a lost owner strands the lift).
  const releaseOwner = (prev: HoverOwner, key: string, hovered: boolean): boolean => {
    if (prev.kind !== "paint") return false;
    if (prev.key === key) {
      // the same tile: only the LIFT goes — the paint below replaces the
      // icon/bg (or the selection takes them over)
      dropLift(prev.cur);
      return false;
    }
    if (!hovered) return true; // a late out for another tile — the owner survives
    // the pointer moved onto another tile: the old owner returns to rest
    restPaint(prev.cur);
    return false;
  };

  // release any owned hover. wiring/grid calls this when a modal takes the
  // screen (floats onModalOpen): a tile hovered at that instant would otherwise
  // stay lifted/tinted behind the dim (the modal overlays it without an `out`
  // reaching the tile in every terminal/synthetic-over path).
  const releaseCurrent = (): void => {
    if (owner.kind !== "paint") return;
    const cur = owner.cur;
    owner = { kind: "none" };
    restPaint(cur);
  };

  const playHover = (key: string, hovered: boolean): void => {
    try {
      const refs = ctx.tileRefs().get(key);
      if (!refs) return;
      const node = ctx.byId(refs.tileId);
      if (!node) return;
      const opts = ctx.hoverLiftOpts();
      const selected = refs.selected === true;
      const cur: HoverCur = { key, refs, node };

      // ONE release: the previous owner, before this event's paint
      const kept = releaseOwner(owner, key, hovered);

      if (selected) {
        // the selection owns the icon/bg visuals — the hover never paints
        // them, so a selected tile keeps the selection's look. A repaint that
        // changes the hit grid re-fires a SYNTHETIC over on the stationary
        // cursor (AGENTS OpenTUI rule), so this branch is also where a tile
        // that just got selected settles its OWNED lift.
        if (!kept) owner = { kind: "selection", key };
        return;
      }

      const colors = ctx.colors();
      if (!hovered) {
        // the tile returns to rest: cut-dim icon + label, the rest bg
        if (!kept) owner = { kind: "none" };
        try {
          ctx.setIconState(refs.iconSpec, restIconIdx(refs, key));
          // hover-out restores the rest fg — same contract as setTileVisual
          const lab = ctx.byId(refs.labelId);
          if (lab) lab.fg = restLabelFg(refs, key);
        } catch {}
        writeBg(node, restTileBg(ctx.uiStyle(), colors, tForce()));
        settle(cur); // the nudge ends with the hover
        return;
      }

      // hover-in: the icon/label/bg flip instantly (hover-in never dims — cut
      // only applies at Rest, exactly like setTileVisual)
      owner = { kind: "paint", key, cur };
      try {
        ctx.setIconState(refs.iconSpec, TileVisual.Hover);
        // hover-in lifts the label to white (readable on the hover fill)
        const lab = ctx.byId(refs.labelId);
        if (lab) lab.fg = colors.white;
      } catch {}
      writeBg(node, colors.hoverBg);

      // the lift rides the feature knob: off (or a tile without headroom)
      // keeps today's instant snap with no motion
      const lift = opts.enabled && refs.hoverLift === true;
      const off = lift ? hoverOffset(opts.direction, opts.slideCells) : { dx: 0, dy: 0 };
      const withLabel = lift && opts.includeLabel === true;
      // writes the offset at hover progress p (whole cells; the label rides
      // only when include-label is on). p=1 is the settled hover, p=0 rest.
      const writeAt = (p: number): void => {
        const dx = Math.round(off.dx * p);
        const dy = Math.round(off.dy * p);
        try {
          const s = ownedSlot(cur);
          if (s) {
            s.translateX = dx;
            s.translateY = dy;
          }
          const lab = ownedLabel(cur);
          if (lab) {
            lab.translateX = withLabel ? dx : 0;
            lab.translateY = withLabel ? dy : 0;
          }
        } catch {}
      };
      // duration 0 (the default) keeps the historical instant snap; a positive
      // duration glides in over `travel` cells (under a 1-cell travel the
      // whole-cell rounding makes the tween a snap too — pick travel > 1)
      if (lift && opts.ms > 0) {
        tween.run(opts.ms, opts.ease as EaseKey, 0, 1, writeAt);
      } else {
        tween.stop();
        writeAt(1);
      }
    } catch {
      // never strand a lifted tile when an unexpected lookup/paint fails
      try {
        if (owner.kind === "paint") dropLift(owner.cur);
      } catch {}
      owner = { kind: "none" };
    }
  };

  return { playHover, releaseCurrent };
};
