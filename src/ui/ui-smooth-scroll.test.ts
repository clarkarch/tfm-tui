import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, getTimelineEngine, MouseEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  glideDelta,
  glideOffsetAt,
  installGridWheelHandler,
  makeSmoothGlide,
  makeWheelSmoother,
  MIN_GLIDE_CELLS,
  WHEEL_BEAT_MAX_MS,
  WHEEL_BEAT_MIN_MS,
  WHEEL_QUEUE_CELLS,
  wheelBeatMs,
} from "./ui-smooth-scroll";
import type { Scheduler } from "../lib/uiutil";

describe("glideDelta", () => {
  test("no movement glides nothing", () => {
    expect(glideDelta(10, 10, 24)).toBe(0);
  });

  test("a small scroll glides by its signed distance", () => {
    expect(glideDelta(10, 14, 24)).toBe(4);
    expect(glideDelta(14, 10, 24)).toBe(-4);
  });

  test("a jump past the cap snaps instead of gliding (page jumps stay instant)", () => {
    expect(glideDelta(0, 25, 24)).toBe(0);
    expect(glideDelta(25, 0, 24)).toBe(0);
    expect(glideDelta(0, 24, 24)).toBe(24);
  });

  test("sub-cell glides snap: a 1-cell offset quantizes to hold-then-snap, never motion", () => {
    // whole-cell rounding turns a 1-cell tween into "hold 1, then jump to 0"
    // (pinned in glideOffsetAt below) — routing it would only add a delayed
    // snap, so the floor stays in the delta, not the curve
    expect(MIN_GLIDE_CELLS).toBe(2);
    expect(glideDelta(10, 11)).toBe(0);
    expect(glideDelta(11, 10)).toBe(0);
    expect(glideDelta(10, 12)).toBe(2);
    expect(glideDelta(10, 11, 24, 1)).toBe(1);
  });
});

describe("glideOffsetAt", () => {
  test("starts at the old view, lands exactly at rest", () => {
    expect(glideOffsetAt(4, 0)).toBe(4);
    expect(glideOffsetAt(4, 1)).toBe(0);
    expect(glideOffsetAt(-4, 0)).toBe(-4);
    expect(glideOffsetAt(-4, 1)).toBe(0);
  });

  test("stays on whole cells (fractional offsets crash image draw)", () => {
    expect(Number.isInteger(glideOffsetAt(5, 0.37))).toBe(true);
    expect(glideOffsetAt(0.4, 0.9999)).toBe(0);
  });
});

describe("makeSmoothGlide (engine)", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 60, height: 20 });
    await t.renderOnce();
  });
  afterAll(() => t.dispose());

  const step = (ms: number): void => getTimelineEngine(t.renderer).update(ms);

  test("glides the container from the old view to rest, then settles", async () => {
    t.renderer.root.add(Box({ id: "sm-inner", width: 40, height: 8, flexDirection: "column" }));
    await t.renderOnce();
    const node = t.renderer.root.findDescendantById("sm-inner") as any;
    const glide = makeSmoothGlide({ renderer: t.renderer as any });
    try {
      glide.glide(node, 4, 90);
      // staged synchronously at the old view — no first-frame pop
      expect(node.translateY).toBe(4);
      step(45);
      await t.renderOnce();
      const mid = node.translateY as number;
      expect(Number.isInteger(mid)).toBe(true);
      expect(mid).toBeGreaterThanOrEqual(0);
      expect(mid).toBeLessThan(4);
      step(200);
      await t.renderOnce();
      expect(node.translateY).toBe(0);
    } finally {
      glide.stop();
    }
  });

  test("stop snaps back to rest and a retarget restarts the glide", async () => {
    const node = t.renderer.root.findDescendantById("sm-inner") as any;
    const glide = makeSmoothGlide({ renderer: t.renderer as any });
    try {
      glide.glide(node, 6, 1000);
      step(1);
      glide.stop();
      expect(node.translateY).toBe(0);
      glide.glide(node, -3, 1000);
      expect(node.translateY).toBe(-3);
    } finally {
      glide.stop();
    }
    expect((t.renderer.root.findDescendantById("sm-inner") as any).translateY).toBe(0);
  });
});

describe("wheelBeatMs", () => {
  test("a lone notch keeps the snappy max pace regardless of the budget", () => {
    expect(wheelBeatMs(160, 1)).toBe(WHEEL_BEAT_MAX_MS);
    expect(wheelBeatMs(800, 1)).toBe(WHEEL_BEAT_MAX_MS);
  });

  test("a burst spreads over the drain budget", () => {
    // 20 cells over 160ms = one cell every 8ms — bounded lag, even pacing
    expect(wheelBeatMs(160, 20)).toBe(WHEEL_BEAT_MIN_MS);
    expect(wheelBeatMs(160, 5)).toBe(30);
  });

  test("never crawls below the frame floor, never stalls on a bad budget", () => {
    expect(wheelBeatMs(160, 100000)).toBe(WHEEL_BEAT_MIN_MS);
    expect(wheelBeatMs(0, 20)).toBe(WHEEL_BEAT_MAX_MS);
    expect(wheelBeatMs(Number.NaN, 20)).toBe(WHEEL_BEAT_MAX_MS);
    expect(wheelBeatMs(160, Number.NaN)).toBe(WHEEL_BEAT_MAX_MS);
  });
});

// virtual clock (Bun has no fake timers): the smoother only ever holds one
// pending timer, so a tiny manual queue drivers it deterministically
const mkClock = () => {
  let seq = 0;
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    sched: {
      setTimeout: (cb: () => void, ms?: number) => {
        const id = ++seq;
        timers.set(id, cb);
        delays.push(ms ?? 0);
        return id;
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number);
      },
    } as Scheduler,
    pending: () => timers.size,
    delays: () => [...delays],
    lastDelay: () => delays[delays.length - 1] ?? 0,
    fire: () => {
      const first = [...timers.entries()][0];
      if (!first) throw new Error("no timer armed");
      timers.delete(first[0]);
      first[1]();
    },
  };
};

describe("makeWheelSmoother", () => {
  test("a push beats 1 cell per tick toward the target, then goes idle", () => {
    const clock = mkClock();
    let top = 0;
    const writes: number[] = [];
    const sm = makeWheelSmoother({
      scrollTop: () => top,
      scrollBy: (d: number) => {
        writes.push(d);
        top += d;
      },
      sched: clock.sched,
    });
    sm.push(3, 160);
    // metronome: nothing applies synchronously — the beat picks it up, so
    // pacing holds from the first cell instead of reproducing tick lumpiness
    expect(top).toBe(0);
    expect(clock.pending()).toBe(1);
    clock.fire();
    expect(top).toBe(1);
    clock.fire();
    expect(top).toBe(2);
    clock.fire();
    expect(top).toBe(3);
    expect(clock.pending()).toBe(0);
    expect(writes).toEqual([1, 1, 1]);
  });

  test("the beat is derived from the drain budget and held for the whole drain", () => {
    const clock = mkClock();
    let top = 0;
    const sm = makeWheelSmoother({
      scrollTop: () => top,
      scrollBy: (d: number) => {
        top += d;
      },
      sched: clock.sched,
    });
    // one cell: the frame-capped snappy pace, same as before the budget system
    sm.push(1, 160);
    expect(clock.lastDelay()).toBe(WHEEL_BEAT_MAX_MS);
    clock.fire();
    expect(clock.pending()).toBe(0);
    expect(top).toBe(1);
    // a 20-cell burst: the budget (160ms) spread across the queue = the floor,
    // held constant so the total drain stays within the budget
    sm.push(20, 160);
    expect(clock.pending()).toBe(1);
    const beat = clock.lastDelay();
    expect(beat).toBe(WHEEL_BEAT_MIN_MS);
    for (let i = 0; i < 20; i++) clock.fire();
    expect(top).toBe(21);
    expect(clock.pending()).toBe(0);
    const drainBeats = clock.delays().filter((d) => d === beat).length;
    expect(drainBeats).toBe(20);
    expect(drainBeats * beat).toBeLessThanOrEqual(160);
  });

  test("a second push while running extends the queue (bursts coalesce)", () => {
    const clock = mkClock();
    let top = 0;
    const sm = makeWheelSmoother({
      scrollTop: () => top,
      scrollBy: (d: number) => {
        top += d;
      },
      sched: clock.sched,
    });
    sm.push(2, 160);
    expect(top).toBe(0);
    sm.push(2, 160);
    clock.fire();
    clock.fire();
    clock.fire();
    clock.fire();
    expect(top).toBe(4);
    expect(clock.pending()).toBe(0);
  });

  test("an external write (keyboard jump, thumb drag) drops the queue", () => {
    const clock = mkClock();
    let top = 0;
    const writes: number[] = [];
    const sm = makeWheelSmoother({
      scrollTop: () => top,
      scrollBy: (d: number) => {
        writes.push(d);
        top += d;
      },
      sched: clock.sched,
    });
    sm.push(9, 160);
    clock.fire();
    expect(top).toBe(1);
    top = 50; // keyboard jump lands elsewhere before the next tick
    clock.fire();
    expect(writes).toEqual([1]);
    expect(clock.pending()).toBe(0);
    // settled exactly on the jump: no corrective write back
    expect(top).toBe(50);
  });

  test("the queue caps so a fling never banks seconds of catch-up", () => {
    const clock = mkClock();
    let top = 0;
    const sm = makeWheelSmoother({
      scrollTop: () => top,
      scrollBy: (d: number) => {
        top += d;
      },
      sched: clock.sched,
    });
    expect(WHEEL_QUEUE_CELLS).toBeGreaterThan(0);
    sm.push(1000, 160, 5);
    expect(top).toBe(0);
    for (let i = 0; i < 5; i++) clock.fire();
    expect(top).toBe(5);
    expect(clock.pending()).toBe(0);
  });

  test("stop drops the queue and zero/NaN pushes are no-ops", () => {
    const clock = mkClock();
    let top = 0;
    const sm = makeWheelSmoother({
      scrollTop: () => top,
      scrollBy: (d: number) => {
        top += d;
      },
      sched: clock.sched,
    });
    sm.push(9, 160);
    expect(top).toBe(0);
    expect(clock.pending()).toBe(1);
    sm.stop();
    expect(clock.pending()).toBe(0);
    sm.push(0, 160);
    sm.push(Number.NaN, 160);
    expect(top).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});

describe("makeGridWheelHandler (interception over a real ScrollBox)", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 60, height: 20 });
    await t.renderOnce();
  });
  afterAll(() => t.dispose());

  let seq = 0;
  const buildScroller = async () => {
    const { ScrollBoxRenderable, Text } = await import("@opentui/core");
    const id = `whl-scroll-${seq++}`;
    const scroller = new ScrollBoxRenderable(t.renderer as any, {
      id,
      width: 40,
      height: 10,
      scrollY: true,
      contentOptions: { flexDirection: "column" },
    });
    for (let i = 0; i < 30; i++) {
      scroller.content.add(Text({ content: `row ${i}`, width: 40, height: 1 } as any) as any);
    }
    (t.renderer.root as any).add(scroller);
    await t.renderOnce();
    return scroller as any;
  };
  // destroy() alone leaves the node attached (hit-test ghosts keep eating
  // later tests' wheel events) — detach first, like ui-grid's reapRow
  const teardownScroller = async (scroller: any) => {
    try {
      (t.renderer.root as any).remove(scroller);
    } catch {}
    try {
      scroller.destroy();
    } catch {}
    await t.renderOnce();
  };

  test("a consumed tick suppresses the native jump; the stepper owns the motion", async () => {
    const clock = mkClock();
    const scroller = await buildScroller();
    try {
      const pushed: Array<{ dir: 1 | -1; cells: number }> = [];
      const smoother = makeWheelSmoother({
        scrollTop: () => scroller.scrollTop,
        scrollBy: (d: number) => {
          scroller.scrollTop = Math.max(0, Math.round(scroller.scrollTop + d));
        },
        sched: clock.sched,
      });
      installGridWheelHandler(scroller, 0, (_pane, dir, cells) => {
        pushed.push({ dir, cells });
        smoother.push(dir * cells, 160);
        return true;
      });

      await t.mockMouse.scroll(5, 5, "down");
      await t.renderOnce();
      // metronome: the tick only queues — nothing moves synchronously, and a
      // leaked native jump would already show here
      expect(pushed).toEqual([{ dir: 1, cells: 1 }]);
      expect(scroller.scrollTop).toBe(0);
      expect(clock.pending()).toBe(1);
      // the beat settles it, then idle — total motion exactly the tick
      clock.fire();
      await t.renderOnce();
      expect(scroller.scrollTop).toBe(1);
      expect(clock.pending()).toBe(0);
      smoother.stop();
    } finally {
      await teardownScroller(scroller);
    }
  });

  test("multi-cell ticks trail on the cadence with no native double-move", async () => {
    const clock = mkClock();
    const scroller = await buildScroller();
    try {
      const smoother = makeWheelSmoother({
        scrollTop: () => scroller.scrollTop,
        scrollBy: (d: number) => {
          scroller.scrollTop = Math.max(0, Math.round(scroller.scrollTop + d));
        },
        sched: clock.sched,
      });
      installGridWheelHandler(scroller, 0, (_pane, dir, cells) => {
        smoother.push(dir * cells, 160);
        return true;
      });

      // a 3-cell tick (fast flick) beats out 1-2-3 — never 3+3 native double
      scroller.processMouseEvent(
        new MouseEvent(scroller, {
          type: "scroll",
          button: 0,
          x: 5,
          y: 5,
          modifiers: { shift: false, alt: false, ctrl: false },
          scroll: { direction: "down", delta: 3 },
        }),
      );
      await t.renderOnce();
      expect(scroller.scrollTop).toBe(0);
      clock.fire();
      expect(scroller.scrollTop).toBe(1);
      clock.fire();
      expect(scroller.scrollTop).toBe(2);
      clock.fire();
      expect(scroller.scrollTop).toBe(3);
      expect(clock.pending()).toBe(0);
      smoother.stop();
    } finally {
      await teardownScroller(scroller);
    }
  });

  test("unconsumed ticks (master off) and sideways ticks stay native", async () => {
    const scroller = await buildScroller();
    try {
      let pushCalls = 0;
      installGridWheelHandler(scroller, 0, () => {
        pushCalls++;
        return false; // master off: don't consume
      });

      await t.mockMouse.scroll(5, 5, "down");
      await t.renderOnce();
      // native jump applied exactly once (no smoother on top)
      expect(pushCalls).toBe(1);
      expect(scroller.scrollTop).toBe(1);

      // sideways ticks never even reach pushWheel (horizontal stays native)
      scroller.processMouseEvent(
        new MouseEvent(scroller, {
          type: "scroll",
          button: 0,
          x: 5,
          y: 5,
          modifiers: { shift: false, alt: false, ctrl: false },
          scroll: { direction: "left", delta: 3 },
        }),
      );
      expect(pushCalls).toBe(1);
    } finally {
      await teardownScroller(scroller);
    }
  });
});
