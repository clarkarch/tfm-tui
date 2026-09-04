import { describe, expect, test } from "bun:test";
import { makeResizeWatcher } from "./resize";

// virtual clock: no wall-clock sleeps — resize debounce is a timing unit
const makeClock = () => {
  const jobs: { at: number; fn: () => void }[] = [];
  let now = 0;
  return {
    setTimeout(cb: () => void, ms: number): unknown {
      const job = { at: now + ms, fn: cb };
      jobs.push(job);
      return job;
    },
    clearTimeout(handle: unknown): void {
      const i = jobs.indexOf(handle as { at: number; fn: () => void });
      if (i >= 0) jobs.splice(i, 1);
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        jobs.sort((a, b) => a.at - b.at);
        const next = jobs[0];
        if (!next || next.at > end) break;
        now = next.at;
        jobs.shift()!.fn();
      }
      now = end;
    },
  };
};

describe("makeResizeWatcher", () => {
  test("a burst of resize events coalesces into ONE rebuild", () => {
    let rebuilds = 0;
    let resets = 0;
    const clock = makeClock();
    const { onResize } = makeResizeWatcher({
      resetIconQueue: () => {
        resets++;
      },
      renderAll: () => {
        rebuilds++;
      },
      delayMs: 30,
      sched: clock,
    });
    for (let i = 0; i < 8; i++) {
      onResize();
      clock.advance(5);
    }
    expect(rebuilds).toBe(0); // still inside the debounce window
    clock.advance(30);
    expect(rebuilds).toBe(1);
    expect(resets).toBe(1);
  });

  test("the icon queue resets BEFORE renderAll so rasters re-bake at new pixels", () => {
    const order: string[] = [];
    const clock = makeClock();
    const { onResize } = makeResizeWatcher({
      resetIconQueue: () => {
        order.push("reset");
      },
      renderAll: () => {
        order.push("render");
      },
      delayMs: 5,
      sched: clock,
    });
    onResize();
    clock.advance(5);
    expect(order).toEqual(["reset", "render"]);
  });

  test("separate bursts past the window each rebuild once", () => {
    let rebuilds = 0;
    const clock = makeClock();
    const { onResize } = makeResizeWatcher({
      resetIconQueue: () => {},
      renderAll: () => {
        rebuilds++;
      },
      delayMs: 10,
      sched: clock,
    });
    onResize();
    clock.advance(40);
    onResize();
    clock.advance(40);
    expect(rebuilds).toBe(2);
  });
});
