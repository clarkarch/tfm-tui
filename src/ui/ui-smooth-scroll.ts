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

// The glide's state: ONE record. The old code had four parallel fields
// (`tl`, `usedMs`, `node`, `start`) whose combinations named "idle" vs
// "gliding" vs "gliding with a dead node" — and the dead-node case was
// invisible: `write` swallowed the throw and the timeline kept driving a
// node that was already gone. The node and the distance it glides FROM are
// the glide's state; the timeline and its duration are RESOURCES (the
// timeline is rebuilt when the duration changes).
export type GlidePhase = { kind: "idle" } | { kind: "gliding" };

type GlideState = { kind: "idle" } | { kind: "gliding"; node: MaybeNode; start: number };

export const makeSmoothGlide = (ctx: { renderer: CliRenderer }) => {
  // 0.6.0: per-renderer timeline engine (same rule as ui-grid-anim) — fakes
  // without a frame loop keep the legacy default-engine path below.
  let owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null = null;
  try {
    if (typeof ctx.renderer?.setFrameCallback === "function") owner = getTimelineEngine(ctx.renderer);
  } catch {}
  let tl: ReturnType<typeof createTimeline> | null = null;
  // the duration the CURRENT timeline was built for (a glide with another
  // duration gets its own timeline)
  let tlMs = -1;
  const holder = { p: 0 };
  let state: GlideState = { kind: "idle" };

  const write = (v: number): void => {
    if (state.kind !== "gliding") return;
    const node = state.node;
    if (!node || (node as { isDestroyed?: boolean }).isDestroyed) return;
    try {
      (node as { translateY?: number }).translateY = v;
    } catch {}
  };

  const stop = (): void => {
    // snap the last driven node home (a no-op on a destroyed one) BEFORE the
    // state is cleared — the write reads the node from the state
    write(0);
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    tl = null;
    tlMs = -1;
    state = { kind: "idle" };
  };

  const ensure = (ms: number): void => {
    if (tl && tlMs === ms) return;
    if (tl) {
      try {
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    tlMs = ms;
    tl = owner ? createTimeline({ autoplay: false }, ctx.renderer) : createTimeline({ autoplay: false });
    tl.add(holder, {
      p: 1,
      duration: ms,
      // linear: the glide retriggers per notch under key repeat — an eased
      // curve would front-load every restart into judder, while even segments
      // chain seamlessly
      ease: "linear",
      onUpdate: (a: JSAnimation) => write(glideOffsetAt(state.kind === "gliding" ? state.start : 0, a.progress)),
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
      state = { kind: "gliding", node: t, start: Math.round(deltaCells) };
      holder.p = 0;
      write(state.start);
      ensure(ms);
      tl?.restart();
    } catch {
      stop();
    }
  };

  const phase = (): GlidePhase => (state.kind === "gliding" ? { kind: "gliding" } : { kind: "idle" });

  return { glide, stop, phase };
};

// --- Wheel stepping: the half of smooth scrolling the container glide can't
// do. A wheel tick moves exactly 1 cell — below the glide floor above — so
// offset-tweening it is invisible. Instead ticks only ever SET the target and
// a steady beat steps through 1 cell per tick while it is ahead: the even
// pacing IS the animation (human ticks arrive lumpily; instant-applying each
// one just reproduces the lumpiness). Every step rides the hooked setter so
// the windowed slide + reveal + drains behave exactly like instant scrolling,
// just spread over time.
//
// The beat comes from the [ui] smooth-scroll-ms budget, NOT a fixed interval:
// a lone notch keeps the snappy frame-capped pace, while a burst spreads the
// SAME budget over all its cells — so a fling never trails the input by
// `cells x interval` seconds (the old fixed 30 ms beat left a 20-notch spin
// creeping for ~600 ms after the wheel stopped). One knob drives both halves.
//
// One pending timer at most (a chain, never overlapping); a keyboard jump,
// thumb drag or rebuild clamp landing anywhere unexpected drops the queue
// instead of fighting it. The ScrollBox setter clamps + rounds on its own,
// so no maxTop plumbing is needed — a stall against the clamp reads as an
// external write on the next tick and drains the queue. ---

// per-cell beat bounds: MIN is about half a 60 fps frame (a burst still steps
// faster than the terminal can present, so it coalesces into one smooth
// slide), MAX is the historical lone-notch pace (a single cell cannot read as
// motion, so there is no point crawling it)
export const WHEEL_BEAT_MIN_MS = 8;
export const WHEEL_BEAT_MAX_MS = 30;
// a fling never banks more than this many trailing cells — past it the target
// pins and the steps chase continuously instead of queuing seconds of lag
export const WHEEL_QUEUE_CELLS = 24;

// pure: the per-cell beat for a queue `remainingCells` deep at a `drainMs`
// budget. A lone cell gets MAX (snappy); a burst gets budget/cells clamped to
// [MIN, MAX], so the whole drain finishes within ~the budget. Never returns a
// value that would stall the chain — an unusable budget falls back to MAX.
export const wheelBeatMs = (drainMs: number, remainingCells: number): number => {
  if (!Number.isFinite(drainMs) || drainMs <= 0) return WHEEL_BEAT_MAX_MS;
  const cells = Number.isFinite(remainingCells) ? Math.max(1, Math.abs(Math.round(remainingCells))) : 1;
  return Math.max(WHEEL_BEAT_MIN_MS, Math.min(WHEEL_BEAT_MAX_MS, Math.round(drainMs / cells)));
};

// The queue's state: ONE record. The old code had THREE nullable fields
// (`target`, `timer`, `lastDriven`) whose COMBINATION named four states
// (idle / queued / driving / dropped-by-an-external-write) — and whose
// ILLEGAL combinations were reachable: a push that cancelled the queue
// cleared `target` but LEFT `lastDriven`, so the next beat compared the
// scroll position against a cell the smoother no longer owned and dropped
// the queue — the user's wheel tick was swallowed.
//
//   kind    what the queue is
//   target  the cell the fling is driving toward
//   at      the cell the scroll is at, as far as the smoother knows: the
//           cell it last LANDED on (driving) or the cell it observed when
//           the queue was created (queued). It is the cell the smoother
//           OWNS, so a position that is neither `at` nor `target` means
//           somebody else moved the viewport.
//
// The timer rides in the record: a queue owns its pending beat, so "armed"
// is not a second truth about the queue.
export type WheelPhase =
  | { kind: "idle" }
  | { kind: "queued"; target: number }
  | { kind: "driving"; target: number; at: number };

type WheelState =
  | { kind: "idle"; timer: null }
  | { kind: "queued"; target: number; at: number; timer: unknown }
  | { kind: "driving"; target: number; at: number; timer: unknown };

export const makeWheelSmoother = (ctx: {
  scrollTop(): number;
  scrollBy(deltaCells: number): void;
  sched?: Scheduler;
}) => {
  const sched: Scheduler = ctx.sched ?? globalThis;
  let state: WheelState = { kind: "idle", timer: null };
  // per-cell beat for the CURRENT drain, derived from the [ui]
  // smooth-scroll-ms budget when the queue was last pushed. Held constant for
  // the drain (even pacing) so the whole burst finishes within ~the budget —
  // recomputing per tick from the shrinking queue would slow the tail back to
  // the lone-notch pace and stretch a spin's lag out again. It is a TUNING
  // value of the drain, not a state.
  let beat = WHEEL_BEAT_MAX_MS;

  const setTimer = (timer: unknown): void => {
    if (state.kind === "idle") return;
    state =
      state.kind === "queued"
        ? { kind: "queued", target: state.target, at: state.at, timer }
        : { kind: "driving", target: state.target, at: state.at, timer };
  };

  const goIdle = (): void => {
    if (state.timer !== null && state.timer !== undefined) {
      try {
        sched.clearTimeout(state.timer);
      } catch {}
    }
    state = { kind: "idle", timer: null };
  };

  const arm = (): void => {
    if (state.kind === "idle" || state.timer !== null) return;
    try {
      setTimer(sched.setTimeout(step, beat));
    } catch {
      goIdle();
    }
  };

  const step = (): void => {
    if (state.kind === "idle") return;
    // the beat fired — the queue owns no pending timer until it re-arms
    if (state.timer !== null && state.timer !== undefined) {
      try {
        sched.clearTimeout(state.timer);
      } catch {}
      setTimer(null);
    }
    const target = state.target;
    const owned = state.at;
    let cur = 0;
    try {
      cur = Math.round(ctx.scrollTop());
    } catch {
      goIdle();
      return;
    }
    // an external write owns the viewport now — drop the queue (landing
    // exactly on the target/the cell we own is a no-op drain, never a fight)
    if (cur !== owned && cur !== target) {
      goIdle();
      return;
    }
    if (cur === target) {
      goIdle();
      return;
    }
    const next = cur + Math.sign(target - cur);
    try {
      ctx.scrollBy(next - cur);
    } catch {
      goIdle();
      return;
    }
    // read back where the scroll ACTUALLY landed: the write can be clamped
    // (the list's edge) or shortened (a content resize), so the cell we
    // ASKED for is not always the cell we GOT. Owning the landed cell (not
    // the intended one) is what keeps a clamp from reading as an external
    // write.
    let landed = next;
    try {
      landed = Math.round(ctx.scrollTop());
    } catch {
      landed = next;
    }
    if (landed === target) {
      goIdle();
      return;
    }
    if (landed === cur) {
      // the scroll cannot move (the list's edge): the fling is done where it
      // stands — settling HERE is the honest end state, and no beat is kept
      // alive past it.
      goIdle();
      return;
    }
    state = { kind: "driving", target, at: landed, timer: null };
    arm();
  };
  // queue a relative move; nothing applies synchronously — the beat picks it
  // up, so even pacing holds from the first cell (an instant first cell would
  // reproduce tick lumpiness: the very thing this exists to remove). The beat
  // shortens as the queue deepens, so the trailing lag stays ~`drainMs`.
  const push = (deltaCells: number, drainMs: number, maxQueue: number = WHEEL_QUEUE_CELLS): void => {
    try {
      const d = Math.round(deltaCells);
      if (!Number.isFinite(d) || d === 0) return;
      const cur = Math.round(ctx.scrollTop());
      if (!Number.isFinite(cur)) return;
      const cap = maxQueue > 0 ? maxQueue : WHEEL_QUEUE_CELLS;
      // the cell the smoother owns: the one it landed on, or the one it
      // observed when the queue was created
      const owned = state.kind === "idle" ? cur : state.at;
      // somebody else moved the viewport (a keyboard jump, a thumb drag): a
      // push landing between that write and the beat that would notice it
      // must REBASE — the tick the user just made is honored and the fling
      // continues from where the view actually is (the old code kept the
      // stale target AND the stale ownership, so the next beat dropped the
      // whole queue and the tick was swallowed).
      const external = state.kind !== "idle" && cur !== owned && cur !== state.target;
      const from = external || state.kind === "idle" ? cur : state.target;
      let next = from + d;
      if (next > cur + cap) next = cur + cap;
      if (next < cur - cap) next = cur - cap;
      const target = Math.round(next);
      if (target === cur) {
        // the tick cancels the fling exactly where the view already is
        goIdle();
        return;
      }
      // derive the beat from the whole distance now queued, and hold it for
      // the drain (a deeper queue = proportionally faster beats within the
      // same budget; a lone notch = the snappy max pace)
      beat = wheelBeatMs(drainMs, Math.abs(target - cur));
      state = {
        kind: state.kind === "driving" ? "driving" : "queued",
        target,
        at: external ? cur : owned,
        timer: state.timer,
      };
      arm();
    } catch {
      // scrolling must never break because the smoother did
    }
  };

  const stop = (): void => {
    goIdle();
  };

  const phase = (): WheelPhase => {
    if (state.kind === "idle") return { kind: "idle" };
    if (state.kind === "queued") return { kind: "queued", target: state.target };
    return { kind: "driving", target: state.target, at: state.at };
  };

  return { push, stop, phase };
};

// --- Wheel interception: the handler wiring/io installs on each grid scroller.
//
// OpenTUI 0.8.0 moved the wheel handling INTO the ScrollBox (its own
// `onMouseEvent` → `scrollByWheel`) and turned `content` into a facade over
// native state — a facade, not a renderable, so there is no `onMouseScroll`
// listener left to hang on. The typed `onMouseScroll` listener still runs
// BEFORE the node's own `onMouseEvent` (Renderable.processMouseEvent), so the
// handler marks the event as taken and the wrapper below skips the box's own
// step: the same "a consumed tick never reaches the native instant jump"
// contract the old content-level listener had.
//
// Shift+wheel (horizontal) and the scrollbar's own wheel stay native.
//
// The event shape is structural (all-optional) so tests can drive it with
// fakes; the real MouseEvent satisfies it. ---
export type WheelEventLike = {
  scroll?: { direction?: string; delta?: number } | null;
  modifiers?: { shift?: boolean } | null;
  stopPropagation?: () => void;
};

// Decides whether a wheel tick belongs to the smoother. Returns true when the
// tick was consumed (the caller must then suppress the box's own step).
export const makeGridWheelHandler =
  (pushWheel: (pane: 0 | 1, dir: 1 | -1, cells: number) => boolean) =>
  (pane: 0 | 1) =>
  (ev: WheelEventLike): boolean => {
    try {
      const dir = ev.scroll?.direction;
      if (dir !== "up" && dir !== "down") return false;
      if (ev.modifiers?.shift) return false;
      const cells = Math.max(1, Math.round(Math.abs(ev.scroll?.delta ?? 1)));
      if (!Number.isFinite(cells)) return false;
      if (!pushWheel(pane, dir === "down" ? 1 : -1, cells)) return false;
      // keep the tick from reaching anything outside this scroller (an outer
      // scroller would otherwise take it) — the box's OWN handling is stopped
      // by the wrapper below, not by this call.
      ev.stopPropagation?.();
      return true;
    } catch {
      return false;
    }
  };

// Installs the wheel interception on a grid scroller: the typed scroll
// listener decides, the wrapper around the box's own mouse handler suppresses
// the instant jump when the tick was consumed.
//
// Returns the typed listener it installed, so a caller (and the test) can
// drive the decision half on its own.
export const installGridWheelHandler = (
  scroller: object,
  pane: 0 | 1,
  pushWheel: (pane: 0 | 1, dir: 1 | -1, cells: number) => boolean,
): ((ev: WheelEventLike) => void) => {
  try {
    const target = scroller as {
      onMouseScroll?: (ev: WheelEventLike) => void;
      onMouseEvent?: (ev: { type?: string }) => void;
    };
    const handler = makeGridWheelHandler(pushWheel)(pane);
    // The latch NAMES the event it was set for: the node-level handler runs
    // right after the typed listener for the SAME event, so a latch that
    // outlived its event (a node torn down between the two) could swallow the
    // NEXT event's native jump.
    let consumedFor: WheelEventLike | null = null;
    const onScroll = (ev: WheelEventLike): void => {
      consumedFor = handler(ev) ? ev : null;
    };
    target.onMouseScroll = onScroll;
    // The box's own handler runs right after the typed listener, so the flag
    // is fresh by then. Only a "scroll" event is ever suppressed: the box's
    // handler does nothing else for that event type.
    //
    // `onMouseEvent` is `protected` in TS but an ordinary prototype method at
    // runtime; it may sit several levels up the chain (ScrollBox declares its
    // own, Box/Renderable declare the base), so WALK the chain instead of
    // reading one level.
    let orig: ((ev: unknown) => void) | undefined;
    for (let p = Object.getPrototypeOf(scroller); p; p = Object.getPrototypeOf(p)) {
      const fn = (p as { onMouseEvent?: unknown }).onMouseEvent;
      if (typeof fn === "function") {
        orig = fn as (ev: unknown) => void;
        break;
      }
    }
    if (typeof orig === "function") {
      target.onMouseEvent = function (ev: { type?: string } & WheelEventLike) {
        const skip = consumedFor === ev && ev?.type === "scroll";
        consumedFor = null;
        if (skip) return;
        orig.call(this, ev);
      };
    }
    return onScroll;
  } catch {
    return () => {};
  }
};
