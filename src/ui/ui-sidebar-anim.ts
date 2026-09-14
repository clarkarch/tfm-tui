// --- Sidebar startup intro: cold-boot-only fade/slide/stagger of the places
// sidebar. The ONLY caller is the `playSidebarIntro` boot step after the first
// renderAll (see app/boot.ts) — never on navigate/theme-flip/resize.
//
// Rules (same family as ui-grid-anim / ui-hover-drawer):
// - ONE reused timeline (`restart()`, `engine.attach` once — the engine's Set
//   never unregisters, so never createTimeline per event).
// - `fade`/`slide` target ONLY the sidebar root node; `stagger` cascades the
//   place-row opacities and never translates; `stagger-slide` (files-style)
//   cascades each row's own slide+fade — horizontal only, so rows stay in
//   their own band and the sidebar's overflow clips the travel cleanly.
// - Render-only props (`opacity` + whole-cell translates via `quantizeDy`), so
//   the hover drawer (owns width) and `rethemeChrome` (writes widths) can never
//   collide with a running intro.
// - Nodes resolve live via `byId` (a rebuild between boot steps yields fresh
//   nodes); `play`/`stop` are try/catch with rest-snapping settle, no `Bun.gc`.
// - `play()` stages frame 0 synchronously but starts the timeline on the 2nd
//   presented frame (renderer-backed frame callback + 100ms timeout fallback,
//   both cancelled by replay/stop) — a wall-clock start can run a short intro
//   before the terminal presents its first frame on cold boot, finishing
//   unseen.
// - Unknown styles fall back to fade.
//
// The curves reuse the shared file-animation helpers (`easeAt`,
// `staggerLocal`, `quantizeDy`); only the frame assembly + the gate are new. ---

import { createTimeline, engine, type JSAnimation } from "@opentui/core";
import { easeAt, quantizeDy, staggerLocal, type EaseKey, type SlideDir } from "./ui-grid-anim";
import type { Scheduler } from "../lib/uiutil";

export type SidebarAnimStyle = "fade" | "slide" | "stagger" | "stagger-slide";

// unknown styles fall back to fade (a mis-saved config never blanks the sidebar)
export const sidebarStyleFrom = (raw: unknown): SidebarAnimStyle =>
  raw === "slide" ? "slide" : raw === "stagger" ? "stagger" : raw === "stagger-slide" ? "stagger-slide" : "fade";

export type SidebarAnimCfg = {
  dist?: number; // slide travel in cells (0 = no motion)
  span?: number; // stagger cascade spread, 0..1
  ease?: EaseKey;
  dir?: SlideDir;
};

export type SidebarAnimFrame = { opacity: number; dx: number; dy: number };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
// -0 paints like +0 but trips Object.is asserts — normalize at the source
const noNegZero = (v: number): number => (v === 0 ? 0 : v);

// pure: opacity + offset (cells) of node `i` (of `n`) at raw progress `p`.
// Plain stagger rows never translate; fade/slide target the single root;
// stagger-slide gives each row its own slide+fade cascade (files-style).
export const sidebarFrameAt = (
  style: string,
  p: number,
  i: number,
  n: number,
  cfg: SidebarAnimCfg = {},
): SidebarAnimFrame => {
  const { dist = 0, span = 0.4, ease = "ease-out", dir = "left" } = cfg;
  const e = (q: number): number => easeAt(ease, q);
  const horizontal = dir === "left" || dir === "right";
  // which way the slide STARTS: left = from the left (-X, off the screen edge
  // for a left-docked sidebar), right = from the right (+X); up/down mirror
  // the file-animation vertical convention
  const dirSign = dir === "down" || dir === "left" ? -1 : 1;
  const offset = (v: number): SidebarAnimFrame => {
    const travel = noNegZero((1 - v) * dist * dirSign);
    return horizontal ? { opacity: v, dx: travel, dy: 0 } : { opacity: v, dx: 0, dy: travel };
  };
  const t = clamp01(p);
  // exact endpoints: floating-point cascade math otherwise lands on
  // 0.9999999… at p=1 and leaves rows a hair transparent until settle
  if (t >= 1) return { opacity: 1, dx: 0, dy: 0 };
  if (style === "stagger") {
    if (t <= 0) return { opacity: 0, dx: 0, dy: 0 };
    return { opacity: e(staggerLocal(t, i, n, span)), dx: 0, dy: 0 };
  }
  if (style === "stagger-slide") {
    // per-row cascade: each row slides out of its own band while fading, one
    // after another. Horizontal motion keeps every row in its own Y band, so
    // — unlike a vertical slide — neighbours never overlap mid-flight.
    if (t <= 0) return offset(0);
    return offset(e(staggerLocal(t, i, n, span)));
  }
  if (style === "slide") {
    if (t <= 0) return offset(0);
    return offset(e(staggerLocal(t, i, n, span)));
  }
  if (t <= 0) return { opacity: 0, dx: 0, dy: 0 };
  return { opacity: e(t), dx: 0, dy: 0 };
};

export type SidebarAnimOpts = {
  enabled: boolean;
  style: string;
  ms: number;
  slideCells: number;
  dir: SlideDir;
  staggerPct: number;
  ease: EaseKey;
  includeTitle: boolean;
};

type SidebarAnimCtx = {
  renderer: any;
  byId(id: string): any;
  opts(): SidebarAnimOpts;
  rootId(): string;
  rowIds(): string[];
  // the app-name title block: leads the cascade (index 0) when includeTitle
  // is on, ignored otherwise
  titleId(): string;
  // virtual-clock seam for the 100ms start fallback (Bun has no fake timers)
  sched?: Scheduler;
};

export const makeSidebarAnim = (ctx: SidebarAnimCtx) => {
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let entries: Array<{ node: any; i: number; n: number }> = [];
  let cfg: SidebarAnimCfg = {};
  let style: SidebarAnimStyle = "fade";
  const sched: Scheduler = ctx.sched ?? globalThis;

  // pending start gate: the renderer frame callback + the timeout fallback.
  // Both are cancelled by replay/stop so a stale gate can never start a
  // timeline retargeted at newer nodes.
  let frameCb: ((dt: number) => Promise<void>) | null = null;
  let fallback: unknown = null;
  const cancelGate = (): void => {
    if (frameCb) {
      try {
        ctx.renderer?.removeFrameCallback?.(frameCb);
      } catch {}
      frameCb = null;
    }
    if (fallback !== null && fallback !== undefined) {
      try {
        sched.clearTimeout(fallback);
      } catch {}
      fallback = null;
    }
  };

  const write = (node: any, f: SidebarAnimFrame): void => {
    try {
      node.opacity = Number.isFinite(f.opacity) ? f.opacity : 1;
      // whole cells only: a fractional translate propagates to child image
      // placements and OpenTUI's buffer.drawImage rejects them
      node.translateX = quantizeDy(f.dx);
      node.translateY = quantizeDy(f.dy);
    } catch {}
  };

  const apply = (raw: number): void => {
    for (const { node, i, n } of entries) {
      if (!node) continue;
      write(node, sidebarFrameAt(style, raw, i, n, cfg));
    }
  };

  const settle = (): void => {
    if (!entries.length) return;
    for (const { node } of entries) if (node) write(node, { opacity: 1, dx: 0, dy: 0 });
    // NO Bun.gc here (same reason as file-anim): a synchronous full GC inside
    // the settle frame stalls the render loop for no measurable gain.
  };

  // cancel a running intro: drop the gate, unregister, snap the current nodes
  // back to rest, and forget the timeline so the next play re-registers it
  const stop = (): void => {
    cancelGate();
    if (tl) {
      try {
        engine.unregister(tl);
      } catch {}
    }
    tl = null;
    usedMs = -1;
    settle();
    entries = [];
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

  const play = (): void => {
    try {
      cancelGate();
      const o = ctx.opts();
      if (!o.enabled || !(o.ms > 0)) {
        stop();
        return;
      }
      const st = sidebarStyleFrom(o.style);
      const lookup = (id: string): any => {
        try {
          return ctx.byId(id);
        } catch {
          return null;
        }
      };
      const deduped = (ids: string[]): any[] => {
        const seen = new Set<unknown>();
        const out: any[] = [];
        for (const id of ids) {
          const n = lookup(id);
          if (n && !seen.has(n)) {
            seen.add(n);
            out.push(n);
          }
        }
        return out;
      };
      if (st === "stagger" || st === "stagger-slide") {
        // rows cascade (opacity, or each row's own slide+fade), the title
        // leading at index 0 when opted in; the root animates alone (reads
        // as a plain fade) only when there is nothing to cascade over
        const head = o.includeTitle ? [ctx.titleId()] : [];
        const items = deduped([...head, ...(ctx.rowIds() ?? [])]);
        const animated = items.length ? items : deduped([ctx.rootId()]);
        if (!animated.length) {
          stop();
          return;
        }
        entries = animated.map((node, i, arr) => ({ node, i, n: arr.length }));
      } else {
        // fade/slide move the whole sidebar as one root node
        const animated = deduped([ctx.rootId()]);
        if (!animated.length) {
          stop();
          return;
        }
        entries = [{ node: animated[0], i: 0, n: 1 }];
      }
      style = st;
      cfg = {
        dist: Number.isFinite(o.slideCells) && o.slideCells > 0 ? Math.round(o.slideCells) : 0,
        span: o.staggerPct / 100,
        ease: o.ease,
        dir: o.dir,
      };
      ensure(o.ms);
      // stage frame 0 synchronously so the first presented frame never flashes
      // the finished sidebar before the intro starts
      apply(0);
      let frames = 0;
      const cb = async (_dt: number): Promise<void> => {
        frames++;
        if (frames >= 2) {
          cancelGate();
          try {
            tl?.restart();
          } catch {}
        }
      };
      if (typeof ctx.renderer?.setFrameCallback === "function") {
        frameCb = cb;
        try {
          ctx.renderer.setFrameCallback(cb);
        } catch {
          frameCb = null;
        }
      }
      fallback = sched.setTimeout(() => {
        cancelGate();
        try {
          tl?.restart();
        } catch {}
      }, 100);
    } catch {
      stop();
    }
  };

  // A renderer without a frame loop (unit-test fakes) must never reach
  // engine.attach: attach overwrites the singleton's renderer BEFORE calling
  // setFrameCallback, so a fake wedges the shared engine — every later
  // attach (including other test files in the same process) throws out of
  // detach and no timeline ever advances again.
  try {
    if (typeof ctx.renderer?.setFrameCallback === "function") engine.attach(ctx.renderer);
  } catch {}

  return { play, stop };
};
