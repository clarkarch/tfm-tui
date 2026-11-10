// --- Boot render seam ([ui] lazy-startup OFF = "burst" startup): the app
// paints in ONE frame, so the boot must wait for the ASYNC parts of the
// first render (the grid build) and for the icon rasters before it reveals
// the content. Without the wait the user watches tfm assemble itself: the
// title + background first, then the sidebar, then the grid, then the icons.
// The seam takes injected fakes — no renderer, no fs. ---
import { describe, expect, test } from "bun:test";
import { runBootRender, runBootReveal, type BootRenderCtx } from "./io";

const harness = (over: Partial<{ gridDelayMs: number; drainDelayMs: number; burst: boolean }> = {}) => {
  const calls: string[] = [];
  const ctx: BootRenderCtx = {
    renderAll: () => {
      calls.push("render");
    },
    beginBootPaint: () => {
      calls.push("begin");
    },
    endBootPaint: () => {
      calls.push("end");
    },
    renderAllSettled: async () => {
      calls.push("settled");
      await Bun.sleep(over.gridDelayMs ?? 0);
    },
    drainIcons: async () => {
      calls.push("drain");
      await Bun.sleep(over.drainDelayMs ?? 0);
    },
    burst: over.burst ?? true,
  };
  return { ctx, calls };
};

describe("runBootRender", () => {
  test("the paint's phase opens before the async work settles", async () => {
    // the boot paint's PHASE gates the lazy plugin scan's repaint: an arrival
    // that lands while the paint is in flight is deferred until it settles
    // (a repaint now would interleave a second full render with the paint)
    const { ctx, calls } = harness();
    await runBootRender(ctx);
    expect(calls).toContain("begin");
    expect(calls).toContain("end");
    expect(calls.indexOf("begin")).toBeLessThan(calls.indexOf("settled"));
    expect(calls.indexOf("end")).toBeGreaterThan(calls.indexOf("settled"));
  });

  test("lazy startup paints immediately (no wait — the progressive arrival is the feature)", async () => {
    // with lazy startup ON the app is NOT hidden: the first paint must not
    // wait for the grid build or the rasters (that wait IS the burst startup)
    const { ctx, calls } = harness({ burst: false, gridDelayMs: 50, drainDelayMs: 50 });
    await runBootRender(ctx);
    // the render happened; the rasters were NOT awaited (the drain never ran)
    expect(calls).toContain("render");
    expect(calls).not.toContain("drain");
  });

  test("the boot waits for the grid build AND the icon rasters", async () => {
    // the icons are rastered inside the grid build (fire-and-forget there) —
    // the boot drains once more so the FIRST painted frame carries rasters,
    // not fallback glyphs
    const { ctx, calls } = harness();
    await runBootRender(ctx);
    expect(calls.indexOf("settled")).toBeLessThan(calls.indexOf("drain"));
    expect(calls).toContain("drain");
  });

  test("the boot does not finish before the rasters landed", async () => {
    // the app is hidden until the first frame is complete: a reveal before
    // the drain would show a frame of fallback glyphs
    const { ctx, calls } = harness({ drainDelayMs: 30 });
    let resolved = false;
    const p = runBootRender(ctx).then(() => {
      resolved = true;
    });
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
    expect(calls).toContain("drain");
  });

  test("a hung listing cannot keep the app invisible forever (the budget expires)", async () => {
    // a folder that never lists (a hung network mount) would leave the whole
    // app at opacity 0 — the budget gives up and the app is revealed with
    // what is painted (the grid's loading placeholder covers the rest)
    const logs: string[] = [];
    const ctx: BootRenderCtx = {
      renderAll: () => {},
      renderAllSettled: () => new Promise<void>(() => {}),
      drainIcons: () => {},
      burst: true,
      budgetMs: 20,
      log: (m) => logs.push(m),
    };
    await runBootRender(ctx);
    expect(logs.some((l) => l.includes("budget expired"))).toBe(true);
  });

  test("a failed drain is reported, not thrown (the boot continues)", async () => {
    const logs: string[] = [];
    const ctx: BootRenderCtx = {
      renderAll: () => {},
      renderAllSettled: async () => {},
      drainIcons: async () => {
        throw new Error("node gone");
      },
      burst: true,
      log: (m) => logs.push(m),
    };
    await runBootRender(ctx);
    expect(logs.some((l) => l.includes("node gone"))).toBe(true);
  });
});

describe("runBootReveal", () => {
  test("the clear color is restored BEFORE the content is shown (one frame)", () => {
    // The app must appear with its bg AND its widgets in ONE frame: the
    // renderer's clear color goes back to tfm's bg first, then the content's
    // opacity flips. The other order would paint the app over the terminal's
    // bg for a frame.
    const calls: string[] = [];
    runBootReveal({
      restoreBackgroundColor: () => calls.push("bg"),
      setBootHidden: (hidden) => calls.push(`hidden:${hidden}`),
    });
    expect(calls).toEqual(["bg", "hidden:false"]);
  });
});
