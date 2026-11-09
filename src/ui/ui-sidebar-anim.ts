// --- Sidebar startup intro: cold-boot-only fade/slide/stagger of the places
// sidebar. The ONLY caller is the `playSidebarIntro` boot step after the first
// renderAll (see app/boot.ts) — never on navigate/theme-flip/resize.
//
// Rules (same family as ui-grid-anim / ui-hover-drawer):
// - ONE reused timeline (`restart()`, owner engine captured once — the
//   engine's Set never unregisters, so never createTimeline per event).
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
//   unseen. A staged intro that never advances is settled by the WATCHDOG —
//   staging writes opacity 0 BEFORE anything guarantees a start, so a stuck
//   intro must never leave the sidebar INVISIBLE.
// - Unknown styles fall back to fade.
//
// The curves reuse the shared file-animation helpers (`easeAt`,
// `staggerLocal`, `quantizeDy`); only the frame assembly + the gate are new. ---

import { type CliRenderer, createTimeline, engine, getTimelineEngine, type JSAnimation } from "@opentui/core";
import { easeAt, quantizeDy, staggerLocal, type EaseKey, type SlideDir } from "./ui-grid-anim";
import { clamp01, type Scheduler } from "../lib/uiutil";
import type { MaybeNode, NodeLike } from "../lib/node-like";

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

// --- the shared intro machine (ONE animator for the sidebar + topbar) ---
// The old code had TWO factories with the whole machine duplicated (the
// timeline, the start gate, the staging, the settle) — a fix in one missed
// the other. The sidebar and the topbar differ only in HOW they resolve
// their nodes; everything below is shared.

// the knobs every intro shares (the sidebar adds `includeTitle`)
export type IntroOpts = {
  enabled: boolean;
  style: string;
  ms: number;
  slideCells: number;
  dir: SlideDir;
  staggerPct: number;
  ease: EaseKey;
};

export type SidebarAnimOpts = IntroOpts & {
  // the app-name title block: leads the cascade (index 0) when on
  includeTitle: boolean;
};

// one animated node + its place in the cascade (i of n)
export type IntroEntry = { node: NodeLike; i: number; n: number };

// the intro's phase — ONE named state (the old code had EIGHT parallel
// variables: tl, usedMs, holder, entries, cfg, style, frameCb, fallback).
export type IntroPhase = "idle" | "staged" | "armed" | "running";

// the pending start gate — ONE record. The old code kept the frame callback
// and the timeout fallback as TWO nullable fields whose pairing was a
// convention; both arms are armed together and cancelled together, so they
// live in ONE variant ("a pending gate" vs "no gate") — a half-cancelled
// gate could start a timeline retargeted at newer nodes.
export type IntroGate =
  | { kind: "none" }
  | { kind: "pending"; frameCb: ((dt: number) => Promise<void>) | null; fallback: unknown };

// the wall-clock start: the frame gate waits for the 2nd presented frame so a
// short intro cannot finish before the terminal shows its first frame
const START_FALLBACK_MS = 100;
// the safety net: an intro that never advances must still reach rest
const WATCHDOG_SLACK_MS = 150;

type IntroCtx = {
  renderer: CliRenderer;
  opts(): IntroOpts;
  // virtual-clock seam for the start fallback + the watchdog (Bun has no fake
  // timers)
  sched?: Scheduler;
};

export const makeIntroAnimator = (ctx: IntroCtx) => {
  // 0.6.0: per-renderer timeline engine (same rule as ui-grid-anim) — the
  // shared `engine` singleton belongs to React/Solid; fakes keep the
  // default-engine path (never attached).
  let owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null = null;
  try {
    if (typeof ctx.renderer?.setFrameCallback === "function") owner = getTimelineEngine(ctx.renderer);
  } catch {}
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let entries: IntroEntry[] = [];
  let cfg: SidebarAnimCfg = {};
  let style: SidebarAnimStyle = "fade";
  const sched: Scheduler = ctx.sched ?? globalThis;
  // the phase + the pending start gate — ONE state each (the old code had
  // eight parallel variables and two nullable gate fields)
  let phase: IntroPhase = "idle";
  let gate: IntroGate = { kind: "none" };
  // the safety net's handle (a staged intro that never advances must still
  // reach rest — the staging writes opacity 0 BEFORE any start is guaranteed)
  let watchdog: unknown = null;

  const clearWatchdog = (): void => {
    if (watchdog === null || watchdog === undefined) return;
    try {
      sched.clearTimeout(watchdog);
    } catch {}
    watchdog = null;
  };

  // cancel the pending start gate: BOTH arms go together (the frame callback
  // and the timeout fallback), so the gate is ONE record
  const cancelGate = (): void => {
    if (gate.kind === "none") return;
    const { frameCb, fallback } = gate;
    if (frameCb) {
      try {
        ctx.renderer?.removeFrameCallback?.(frameCb);
      } catch {}
    }
    if (fallback !== null && fallback !== undefined) {
      try {
        sched.clearTimeout(fallback);
      } catch {}
    }
    gate = { kind: "none" };
  };

  const write = (node: NodeLike, f: SidebarAnimFrame): void => {
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

  // cancel a running intro: drop the gate + the watchdog, unregister, snap
  // the current nodes back to rest, and forget the timeline so the next play
  // re-registers it
  const stop = (): void => {
    cancelGate();
    clearWatchdog();
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    tl = null;
    usedMs = -1;
    settle();
    entries = [];
    phase = "idle";
  };

  // one item, recreated only when the duration changes (duration is baked at
  // add time); restart() retargets the node list without accumulating items
  const ensure = (ms: number): void => {
    if (tl && usedMs === ms) return;
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    usedMs = ms;
    tl = owner ? createTimeline({ autoplay: false }, ctx.renderer) : createTimeline({ autoplay: false });
    tl.add(holder, {
      p: 1,
      duration: ms,
      ease: "linear",
      onUpdate: (a: JSAnimation) => apply(a.progress),
      onComplete: () => {
        settle();
        // the intro is done — the watchdog has nothing left to guard
        clearWatchdog();
        phase = "idle";
      },
    });
  };

  // the start attempt: the timeline begins. The watchdog is armed HERE, so a
  // timeline that never advances (a dead engine, a torn-down renderer) is
  // settled instead of leaving the staged nodes at opacity 0 forever.
  const start = (ms: number): void => {
    cancelGate();
    phase = "running";
    clearWatchdog();
    watchdog = sched.setTimeout(() => {
      watchdog = null;
      // the intro never reached rest: settle it — a staged intro must never
      // leave the sidebar INVISIBLE
      if (phase === "idle") return;
      stop();
    }, ms + WATCHDOG_SLACK_MS);
    try {
      tl?.restart();
    } catch {}
  };

  // run an intro: the caller resolves the nodes (the sidebar picks the
  // root/rows/title, the topbar takes an explicit id list); the machine owns
  // the phase, the gate, the staging and the settle.
  const run = (resolve: (style: SidebarAnimStyle) => IntroEntry[]): void => {
    try {
      cancelGate();
      clearWatchdog();
      const o = ctx.opts();
      if (!o.enabled || !(o.ms > 0)) {
        stop();
        return;
      }
      const st = sidebarStyleFrom(o.style);
      const next = resolve(st);
      if (!next.length) {
        stop();
        return;
      }
      entries = next;
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
      phase = "staged";
      // arm the start gate: the 2nd presented frame (renderer-backed) + the
      // wall-clock fallback. The gate record is assigned BEFORE the fallback
      // so a throw while arming can still cancel the frame callback.
      let frames = 0;
      const cb = async (_dt: number): Promise<void> => {
        frames++;
        // the gate is ONE record: once it is consumed (the intro started) a
        // late frame callback must NOT start it again — a second start would
        // restart the timeline and re-arm the watchdog, so a stuck intro
        // could never be settled.
        if (frames >= 2 && gate.kind === "pending") start(o.ms);
      };
      let frameCb: ((dt: number) => Promise<void>) | null = null;
      if (typeof ctx.renderer?.setFrameCallback === "function") {
        try {
          ctx.renderer.setFrameCallback(cb);
          frameCb = cb;
        } catch {
          frameCb = null;
        }
      }
      gate = { kind: "pending", frameCb, fallback: null };
      const fallback = sched.setTimeout(() => start(o.ms), START_FALLBACK_MS);
      gate = { kind: "pending", frameCb, fallback };
      phase = "armed";
    } catch {
      stop();
    }
  };

  return { run, stop, phase: (): IntroPhase => phase };
};

// --- Sidebar intro: the nodes are resolved from the sidebar's own ids (the
// rows cascade, the title leads them, fade/slide move the root alone). ---

type SidebarAnimCtx = {
  renderer: CliRenderer;
  byId(id: string): MaybeNode;
  opts(): SidebarAnimOpts;
  rootId(): string;
  rowIds(): string[];
  // the app-name title block: leads the cascade (index 0) when includeTitle
  // is on, ignored otherwise
  titleId(): string;
  // virtual-clock seam for the start fallback + the watchdog (Bun has no
  // fake timers)
  sched?: Scheduler;
};

export const makeSidebarAnim = (ctx: SidebarAnimCtx) => {
  const anim = makeIntroAnimator({
    renderer: ctx.renderer,
    opts: ctx.opts,
    sched: ctx.sched,
  });

  const lookup = (id: string): MaybeNode => {
    try {
      return ctx.byId(id);
    } catch {
      return null;
    }
  };
  // only resolvable ids come back: an unresolvable one has nothing to animate
  const deduped = (ids: string[]): NodeLike[] => {
    const seen = new Set<unknown>();
    const out: NodeLike[] = [];
    for (const id of ids) {
      const n = lookup(id);
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };

  const play = (): void => {
    anim.run((st) => {
      const o = ctx.opts();
      if (st === "stagger" || st === "stagger-slide") {
        // rows cascade (opacity, or each row's own slide+fade), the title
        // leading at index 0 when opted in; the root animates alone (reads
        // as a plain fade) only when there is nothing to cascade over
        const head = o.includeTitle ? [ctx.titleId()] : [];
        const items = deduped([...head, ...(ctx.rowIds() ?? [])]);
        const animated = items.length ? items : deduped([ctx.rootId()]);
        return animated.map((node, i, arr) => ({ node, i, n: arr.length }));
      }
      // fade/slide move the whole sidebar as one root node
      const only = deduped([ctx.rootId()])[0];
      return only ? [{ node: only, i: 0, n: 1 }] : [];
    });
  };

  return { play, stop: anim.stop, phase: anim.phase };
};

// --- Top bar intro: cold-boot fade/slide/stagger over the pane toolbars'
// contents (buttons + crumbs), plus the per-navigate crumbs replay. Same
// timeline engine + curves as the sidebar intro (`sidebarFrameAt`/
// `sidebarStyleFrom` above); only the node resolution is new. `fade`/`slide`
// move the entries as ONE wave (each runs i=0/n=1, so `slide` never staggers
// the set apart), while the stagger styles cascade across them in list order.
// Render-only props (opacity + whole-cell translates), same as the sidebar
// intro, so rethemeChrome can never collide with a running intro. ---

export type TopbarAnimOpts = IntroOpts;

type TopbarAnimCtx = {
  renderer: CliRenderer;
  byId(id: string): MaybeNode;
  opts(): TopbarAnimOpts;
  barIds(): string[];
  // virtual-clock seam for the start fallback + the watchdog (Bun has no
  // fake timers)
  sched?: Scheduler;
};

export const makeTopbarAnim = (ctx: TopbarAnimCtx) => {
  const anim = makeIntroAnimator({
    renderer: ctx.renderer,
    opts: ctx.opts,
    sched: ctx.sched,
  });

  // shared start: resolve + dedupe the id list. `play()` animates the ctx id
  // list (boot intro); `playIds()` animates an explicit subset (per-navigate:
  // only the newly appeared crumbs — the shared prefix stays put).
  const runIds = (rawIds: string[]): void => {
    anim.run((st) => {
      const seen = new Set<unknown>();
      const bars: NodeLike[] = [];
      for (const id of rawIds) {
        let n: MaybeNode = null;
        try {
          n = ctx.byId(id);
        } catch {
          n = null;
        }
        if (n && !seen.has(n)) {
          seen.add(n);
          bars.push(n);
        }
      }
      // fade/slide move the entries as one wave (i=0/n=1 each — `slide` must
      // not stagger the set apart); the stagger styles cascade across them
      const cascade = st === "stagger" || st === "stagger-slide";
      return bars.map((node, i, arr) => (cascade ? { node, i, n: arr.length } : { node, i: 0, n: 1 }));
    });
  };

  const play = (): void => runIds(ctx.barIds() ?? []);
  const playIds = (ids: string[]): void => runIds(ids ?? []);

  // (attach comment removed: getTimelineEngine above owns the engine now)

  return { play, playIds, stop: anim.stop, phase: anim.phase };
};
