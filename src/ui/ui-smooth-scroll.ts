// --- Scroll glide: the cheap half of smooth scrolling.
//
// A terminal paints whole cells and ScrollBox only applies integer scrollTop,
// so pixel-smooth scrolling is impossible. What reads as smooth is a short
// visual glide: the window math jumps instantly (one incremental slide, one
// icon/thumb drain — the expensive parts run ONCE), while the mounted window
// container starts offset at the old view and tweens back to rest.
//
// One node, one reused timeline per pane (same rule as ui-hover-drawer /
// ui-grid-anim: never createTimeline per event — the engine's Set never
// unregisters). Whole-cell offsets only: a fractional translateY propagates
// to child image placements and buffer.drawImage rejects them. Pure helpers
// are tested; the factory writes translateY and nothing else, so it can never
// fight the file-anim reveal (rows/tiles) or opacity. ---

import { type CliRenderer, createTimeline, engine, getTimelineEngine, type JSAnimation } from "@opentui/core";
import type { Scheduler } from "../lib/uiutil";
import type { MaybeNode } from "../lib/node-like";

// jumps past this many cells snap instead of gliding — a page jump gliding
// the whole distance reads as lag, and long glides hold the container offset
// while the user is already scrolling further
export const MAX_GLIDE_CELLS = 24;

// glides below this many cells snap: whole-cell rounding turns a 1-cell tween
// into "hold 1, then jump to 0" (see glideOffsetAt) — not motion, just a
// delayed snap, so routing it only adds lag. The wheel rides time-distributed
// 1-cell steps instead (makeWheelSmoother below), which ARE the animation.
export const MIN_GLIDE_CELLS = 2;

// pure: the signed glide distance for a scrollTop move, or 0 when there is
// nothing to glide (no move, below the visibility floor, or a jump past the
// cap that must snap)
export const glideDelta = (
  from: number,
  to: number,
  maxCells: number = MAX_GLIDE_CELLS,
  minCells: number = MIN_GLIDE_CELLS,
): number => {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(maxCells > 0)) return 0;
  const d = Math.round(to - from);
  if (d === 0) return 0;
  const a = Math.abs(d);
  if (!(minCells > 0) || a < minCells || a > maxCells) return 0;
  return d;
};

// pure: container offset at progress p for a glide of `start` cells — the old
// view at p=0, rest at p=1, whole cells throughout (-0 normalized, like
// quantizeDy in ui-grid-anim)
export const glideOffsetAt = (start: number, p: number): number => {
  if (!Number.isFinite(start) || !Number.isFinite(p)) return 0;
  if (p <= 0) return start === 0 ? 0 : Math.round(start);
  if (p >= 1) return 0;
  const q = Math.round(start * (1 - p));
  return q === 0 ? 0 : q;
};

export const makeSmoothGlide = (ctx: { renderer: CliRenderer }) => {
  // 0.6.0: per-renderer timeline engine (same rule as ui-grid-anim) — fakes
  // without a frame loop keep the legacy default-engine path below.
  let owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null = null;
  try {
    if (typeof ctx.renderer?.setFrameCallback === "function") owner = getTimelineEngine(ctx.renderer);
  } catch {}
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  const holder = { p: 0 };
  let node: MaybeNode = null;
  let start = 0;

  const write = (v: number): void => {
    if (!node || (node as { isDestroyed?: boolean }).isDestroyed) return;
    try {
      (node as { translateY?: number }).translateY = v;
    } catch {}
  };

  const stop = (): void => {
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    tl = null;
    usedMs = -1;
    // snap the last driven node home (a no-op on a destroyed one)
    write(0);
    node = null;
    start = 0;
  };

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
      // linear: the glide retriggers per notch under key repeat — an eased
      // curve would front-load every restart into judder, while even segments
      // chain seamlessly
      ease: "linear",
      onUpdate: (a: JSAnimation) => write(glideOffsetAt(start, a.progress)),
      onComplete: () => {
        write(0);
      },
    });
  };

  // glide a scroll move: stage the old view synchronously (no first-frame
  // pop), then tween home. A running glide retargets. Never throws. `target`
  // is unknown at the seam (the grid hands its mounted Renderable straight
  // through) — only translateY/isDestroyed are ever touched.
  const glide = (target: unknown, deltaCells: number, ms: number): void => {
    try {
      const t = target as MaybeNode;
      if (!t || !Number.isFinite(deltaCells) || Math.round(deltaCells) === 0 || !(ms > 0)) {
        return;
      }
      node = t;
      start = Math.round(deltaCells);
      holder.p = 0;
      write(start);
      ensure(ms);
      tl?.restart();
    } catch {
      stop();
    }
  };

  return { glide, stop };
};

// --- Wheel stepping: the half of smooth scrolling the container glide can't
// do. A wheel tick moves exactly 1 cell — below the glide floor above — so
// offset-tweening it is invisible. Instead ticks only ever SET the target and
// a steady beat steps through 1 cell per tick while it is ahead: the even
// pacing IS the animation (human ticks arrive lumpily; instant-applying each
// one just reproduces the lumpiness). Every step rides the hooked setter so
// the windowed slide + reveal + drains behave exactly like instant scrolling,
// just spread over time. A lone tick settles one beat later — the unavoidable
// price, since a single 1-cell move cannot look like anything else.
//
// One pending timer at most (a chain, never overlapping); a keyboard jump,
// thumb drag or rebuild clamp landing anywhere unexpected drops the queue
// instead of fighting it. The ScrollBox setter clamps + rounds on its own,
// so no maxTop plumbing is needed — a stall against the clamp reads as an
// external write on the next tick and drains the queue. ---

// bounds for the per-cell beat interval ([ui] smooth-wheel-ms); the schema
// range-coerces the knob, the push guard below treats anything unusable as
// "don't consume"
export const WHEEL_STEP_MIN_MS = 5;
export const WHEEL_STEP_MAX_MS = 200;
// a fling never banks more than this many trailing cells — past it the target
// pins and the steps chase continuously instead of queuing seconds of lag
export const WHEEL_QUEUE_CELLS = 24;

// pure: clamp a wheel beat into the sane range (schema already range-checks;
// this is the backstop for hand-rolled config objects in tests)
export const clampWheelBeat = (ms: number): number => {
  if (!Number.isFinite(ms)) return WHEEL_STEP_MIN_MS;
  return Math.max(WHEEL_STEP_MIN_MS, Math.min(WHEEL_STEP_MAX_MS, Math.round(ms)));
};

export const makeWheelSmoother = (ctx: {
  scrollTop(): number;
  scrollBy(deltaCells: number): void;
  sched?: Scheduler;
}) => {
  const sched: Scheduler = ctx.sched ?? globalThis;
  let target: number | null = null;
  let timer: unknown = null;
  let lastDriven: number | null = null;
  let cadence = WHEEL_STEP_MIN_MS;

  const clear = (): void => {
    if (timer !== null && timer !== undefined) {
      try {
        sched.clearTimeout(timer);
      } catch {}
    }
    timer = null;
  };

  const step = (): void => {
    timer = null;
    if (target === null) return;
    let cur = 0;
    try {
      cur = Math.round(ctx.scrollTop());
    } catch {
      target = null;
      lastDriven = null;
      return;
    }
    // an external write owns the viewport now — drop the queue (landing
    // exactly on the target/previous step is a no-op drain, never a fight)
    if (lastDriven !== null && cur !== lastDriven && cur !== target) {
      target = null;
      lastDriven = null;
      return;
    }
    if (cur === target) {
      target = null;
      lastDriven = null;
      return;
    }
    const next = cur + Math.sign(target - cur);
    lastDriven = next;
    try {
      ctx.scrollBy(next - cur);
    } catch {
      target = null;
      lastDriven = null;
      return;
    }
    // landed exactly (the common case — no clamp in the way): drain now
    // instead of arming a trailing tick that would no-op. A clamped write
    // leaves cur short of target, so the chain continues and the next tick's
    // external-write check above drops it.
    try {
      if (Math.round(ctx.scrollTop()) === target) {
        target = null;
        lastDriven = null;
        return;
      }
    } catch {}
    try {
      timer = sched.setTimeout(step, cadence);
    } catch {
      target = null;
      lastDriven = null;
    }
  };
  // queue a relative move; nothing applies synchronously — the beat picks it
  // up, so even pacing holds from the first cell (an instant first cell would
  // reproduce tick lumpiness: the very thing this exists to remove). A lone
  // tick settles one beat later. Never throws.
  const push = (deltaCells: number, stepMs: number, maxQueue: number = WHEEL_QUEUE_CELLS): void => {
    try {
      const d = Math.round(deltaCells);
      if (!Number.isFinite(d) || d === 0) return;
      const cur = Math.round(ctx.scrollTop());
      if (!Number.isFinite(cur)) return;
      cadence = Number.isFinite(stepMs) && stepMs > 0 ? Math.round(stepMs) : WHEEL_STEP_MIN_MS;
      const cap = maxQueue > 0 ? maxQueue : WHEEL_QUEUE_CELLS;
      const base = target ?? cur;
      // a push landing between an external write and the step that would
      // notice it must rebase — extending a stale target scrolls AWAY from
      // where the user just jumped
      const from = target !== null && lastDriven !== null && cur !== lastDriven && cur !== target ? cur : base;
      let next = from + d;
      if (next > cur + cap) next = cur + cap;
      if (next < cur - cap) next = cur - cap;
      target = Math.round(next);
      if (target === cur) {
        target = null;
        return;
      }
      if (timer === null) {
        try {
          timer = sched.setTimeout(step, cadence);
        } catch {
          target = null;
        }
      }
    } catch {
      // scrolling must never break because the smoother did
    }
  };

  const stop = (): void => {
    target = null;
    lastDriven = null;
    clear();
  };

  return { push, stop };
};

// --- Content-level wheel interception: the handler wiring/io installs on each
// grid scroller's CONTENT node. Content sits below ScrollBox in the bubble
// path (tile → row → inner → content → scroller) and user listeners run
// before a node's own onMouseEvent — so stopPropagation() here kills the
// native instant jump while Shift+wheel (horizontal) and other directions
// bubble on untouched. The event shape is structural (all-optional) so tests
// can drive it with fakes; the real MouseEvent satisfies it. ---
export type WheelEventLike = {
  scroll?: { direction?: string; delta?: number } | null;
  modifiers?: { shift?: boolean } | null;
  stopPropagation?: () => void;
};

export const makeGridWheelHandler =
  (pushWheel: (pane: 0 | 1, dir: 1 | -1, cells: number) => boolean) =>
  (pane: 0 | 1) =>
  (ev: WheelEventLike): void => {
    try {
      const dir = ev.scroll?.direction;
      if (dir !== "up" && dir !== "down") return;
      if (ev.modifiers?.shift) return;
      const cells = Math.max(1, Math.round(Math.abs(ev.scroll?.delta ?? 1)));
      if (!Number.isFinite(cells)) return;
      if (pushWheel(pane, dir === "down" ? 1 : -1, cells)) ev.stopPropagation?.();
    } catch {}
  };
