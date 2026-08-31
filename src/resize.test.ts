import { describe, expect, test } from "bun:test";
import { makeResizeWatcher } from "./resize";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("makeResizeWatcher", () => {
  test("a burst of resize events coalesces into ONE rebuild", async () => {
    let rebuilds = 0;
    let resets = 0;
    const { onResize } = makeResizeWatcher({
      resetIconQueue: () => { resets++; },
      renderAll: () => { rebuilds++; },
      delayMs: 30,
    });
    for (let i = 0; i < 8; i++) { onResize(); await sleep(5); }
    expect(rebuilds).toBe(0); // still inside the debounce window
    await sleep(60);
    expect(rebuilds).toBe(1);
    expect(resets).toBe(1);
  });

  test("the icon queue resets BEFORE renderAll so rasters re-bake at new pixels", async () => {
    const order: string[] = [];
    const { onResize } = makeResizeWatcher({
      resetIconQueue: () => { order.push("reset"); },
      renderAll: () => { order.push("render"); },
      delayMs: 5,
    });
    onResize();
    await sleep(40);
    expect(order).toEqual(["reset", "render"]);
  });

  test("separate bursts past the window each rebuild once", async () => {
    let rebuilds = 0;
    const { onResize } = makeResizeWatcher({
      resetIconQueue: () => {},
      renderAll: () => { rebuilds++; },
      delayMs: 10,
    });
    onResize();
    await sleep(40);
    onResize();
    await sleep(40);
    expect(rebuilds).toBe(2);
  });
});
