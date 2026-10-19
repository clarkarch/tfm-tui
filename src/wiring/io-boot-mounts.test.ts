// --- Boot mounts branch ([ui] lazy-startup): the decision wiring/io.ts makes
// ON TOP of loadSystemPlaces. runBootMountsLoad picks skipMounts vs full
// load; runBootMountsRefresh repaints after first paint (lazy) or no-ops
// (classic). Both take injected fakes — no lsblk spawn, no renderer. ---
import { describe, expect, test } from "bun:test";
import { runBootMountsLoad, runBootMountsRefresh, type BootMountsCtx } from "./io";

const harness = (over: Partial<{ lazy: boolean; drainRejects: boolean }> = {}) => {
  const calls: string[] = [];
  const ctx: BootMountsCtx = {
    lazyBoot: () => over.lazy ?? false,
    loadAll: () => {
      calls.push("load-all");
      return Promise.resolve();
    },
    loadWithoutMounts: () => {
      calls.push("load-without-mounts");
      return Promise.resolve();
    },
    repaintSidebar: () => {
      calls.push("repaint");
    },
    drainIcons: () => {
      calls.push("drain");
      return over.drainRejects ? Promise.reject(new Error("node gone")) : Promise.resolve();
    },
  };
  return { ctx, calls };
};

// poll helper (suite rule for fire-and-forget races — never Bun.sleep)
const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("settleUntil timed out");
    await Bun.sleep(10);
  }
};

describe("runBootMountsLoad", () => {
  test("lazy on skips mounts at boot (refresh fills them after first paint)", async () => {
    const { ctx, calls } = harness({ lazy: true });
    await runBootMountsLoad(ctx);
    expect(calls).toEqual(["load-without-mounts"]);
  });

  test("lazy off (default) loads everything inline, no skip", async () => {
    const { ctx, calls } = harness({ lazy: false });
    await runBootMountsLoad(ctx);
    expect(calls).toEqual(["load-all"]);
  });
});

describe("runBootMountsRefresh", () => {
  test("lazy on reloads mounts then repaints sidebar + drains icons", async () => {
    const { ctx, calls } = harness({ lazy: true });
    runBootMountsRefresh(ctx);
    await settleUntil(() => calls.includes("repaint"));
    await settleUntil(() => calls.includes("drain"));
    expect(calls[0]).toBe("load-all");
    expect(calls.indexOf("load-all")).toBeLessThan(calls.indexOf("repaint"));
  });

  test("classic boot refresh is a pure no-op (no load, no repaint, no drain)", async () => {
    const { ctx, calls } = harness({ lazy: false });
    runBootMountsRefresh(ctx);
    await Bun.sleep(50); // fire-and-forget would have fired by now if wired wrong
    expect(calls).toEqual([]);
  });

  test("an async drain rejection never surfaces (node destroyed mid-raster)", async () => {
    // drainIcons rejects ASYNC — a bare `void <promise>` never catches it.
    // The seam attaches .catch; without it this test fails with an unhandled
    // rejection instead of settling quietly.
    const { ctx, calls } = harness({ lazy: true, drainRejects: true });
    runBootMountsRefresh(ctx);
    await settleUntil(() => calls.includes("repaint"));
    await Bun.sleep(50); // let the rejection land (or crash the test)
    expect(calls).toContain("load-all");
  });
});
