import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, getTimelineEngine } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  clampWheelBeat,
  glideDelta,
  glideOffsetAt,
  makeGridWheelHandler,
  makeSmoothGlide,
  makeWheelSmoother,
  MIN_GLIDE_CELLS,
  WHEEL_QUEUE_CELLS,
  WHEEL_STEP_MAX_MS,
  WHEEL_STEP_MIN_MS,
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

describe("clampWheelBeat", () => {
  test("keeps the beat inside the sane range", () => {
    expect(clampWheelBeat(10)).toBe(10);
    expect(clampWheelBeat(160)).toBe(160);
    expect(clampWheelBeat(1000)).toBe(WHEEL_STEP_MAX_MS);
    expect(clampWheelBeat(-3)).toBe(WHEEL_STEP_MIN_MS);
    expect(clampWheelBeat(Number.NaN)).toBe(WHEEL_STEP_MIN_MS);
  });
});

// virtual clock (Bun has no fake timers): the smoother only ever holds one
// pending timer, so a tiny manual queue drivers it deterministically
const mkClock = () => {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    sched: {
      setTimeout: (cb: () => void) => {
        const id = ++seq;
        timers.set(id, cb);
        return id;
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number);
      },
    } as Scheduler,
    pending: () => timers.size,
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
    sm.push(3, 25);
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
    sm.push(2, 25);
    expect(top).toBe(0);
    sm.push(2, 25);
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
    sm.push(9, 25);
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
    sm.push(1000, 25, 5);
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
    sm.push(9, 25);
    expect(top).toBe(0);
    expect(clock.pending()).toBe(1);
    sm.stop();
    expect(clock.pending()).toBe(0);
    sm.push(0, 25);
    sm.push(Number.NaN, 25);
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
      scroller.content.onMouseScroll = makeGridWheelHandler((_pane, dir, cells) => {
        pushed.push({ dir, cells });
        smoother.push(dir * cells, 25);
        return true;
      })(0);

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
      const handler = makeGridWheelHandler((_pane, dir, cells) => {
        smoother.push(dir * cells, 25);
        return true;
      })(0);
      scroller.content.onMouseScroll = handler;

      // a 3-cell tick (fast flick) beats out 1-2-3 — never 3+3 native double
      handler({
        scroll: { direction: "down", delta: 3 },
        modifiers: {},
        stopPropagation: () => {},
      });
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
      const handler = makeGridWheelHandler(() => {
        pushCalls++;
        return false; // master off: don't consume
      })(0);
      scroller.content.onMouseScroll = handler;

      await t.mockMouse.scroll(5, 5, "down");
      await t.renderOnce();
      // native jump applied exactly once (no smoother on top)
      expect(pushCalls).toBe(1);
      expect(scroller.scrollTop).toBe(1);

      // sideways ticks never even reach pushWheel (horizontal stays native)
      handler({
        scroll: { direction: "left", delta: 3 },
        modifiers: {},
        stopPropagation: () => {},
      });
      expect(pushCalls).toBe(1);
    } finally {
      await teardownScroller(scroller);
    }
  });
});
