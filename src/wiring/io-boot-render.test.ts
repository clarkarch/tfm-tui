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
    markBootRendered: () => {
      calls.push("mark");
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
  test("the render is marked as painted before the async work settles", async () => {
    // markBootRendered flips the lazy plugin-scan repaint gate: a scan that
    // settles BEFORE the first paint needs no repaint (the paint includes it).
    const { ctx, calls } = harness();
    await runBootRender(ctx);
    expect(calls.indexOf("mark")).toBeLessThan(calls.indexOf("settled"));
  });

  test("lazy startup paints immediately (no wait — the progressive arrival is the feature)", async () => {
    // with lazy startup ON the app is NOT hidden: the first paint must not
    // wait for the grid build or the rasters (that wait IS the burst startup)
    const { ctx, calls } = harness({ burst: false, gridDelayMs: 50, drainDelayMs: 50 });
    await runBootRender(ctx);
    expect(calls).toEqual(["render", "mark"]);
  });

  test("the boot waits for the grid build AND the icon rasters", async () => {
    // the icons are rastered inside the grid build (fire-and-forget there) —
    // the boot drains once more so the FIRST painted frame carries rasters,
    // not fallback glyphs
    const { ctx, calls } = harness();
    await runBootRender(ctx);
    expect(calls).toEqual(["render", "mark", "settled", "drain"]);
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
