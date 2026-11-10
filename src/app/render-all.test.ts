import { describe, expect, test } from "bun:test";
import { makeRenderAll, RENDER_STEP_ORDER, type RenderAllCtx } from "./render-all";
import type { AppState } from "./nav";

const mkState = (cwd: string): AppState => ({
  cwd,
  history: [cwd, "/second", "/third"],
  histIdx: 0,
  showHidden: false,
  sortBy: "name",
  sortAsc: true,
});

const settleUntil = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("settleUntil timeout");
};

describe("makeRenderAll", () => {
  test("runs tab-sync first, steps in the canonical order, session-save last", () => {
    const order: string[] = [];
    const state = mkState("/a");
    const ctx: RenderAllCtx = {
      state,
      syncTabFromState: () => order.push("syncTab"),
      scheduleSaveSession: () => order.push("save"),
      log: () => {},
      steps: {
        cwdWatcher: () => {
          order.push("cwdWatcher");
        },
        tabbar: () => {
          order.push("tabbar");
        },
        grid: () => {
          order.push("grid");
        },
        preview: () => {
          order.push("preview");
        },
      },
    };
    makeRenderAll(ctx)();
    expect(order).toEqual(["syncTab", "cwdWatcher", "tabbar", "grid", "preview", "save"]);
  });

  test("the step order is the canonical one, NOT the record's key order", () => {
    // The order was the KEY ORDER of the steps record — reordering the
    // literal silently changed the paint order (sidebar before grid before
    // preview is load-bearing). The order is data now: a record written
    // backwards still paints in the canonical order.
    const order: string[] = [];
    makeRenderAll({
      state: mkState("/a"),
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: () => {},
      steps: {
        preview: () => {
          order.push("preview");
        },
        grid: () => {
          order.push("grid");
        },
        sidebar: () => {
          order.push("sidebar");
        },
        tabbar: () => {
          order.push("tabbar");
        },
      },
    })();
    expect(order).toEqual(["tabbar", "sidebar", "grid", "preview"]);
  });

  test("the canonical order keeps the load-bearing painting sequence", () => {
    const at = (name: string): number => RENDER_STEP_ORDER.indexOf(name as never);
    // the sidebar paints before the grid (the grid reads the sidebar's
    // effective width), the grid before the preview (the preview renders
    // against the listing the grid just built), and the icon drain before
    // both (the slots the grid asks for must be queued first)
    expect(at("sidebar")).toBeLessThan(at("grid"));
    expect(at("grid")).toBeLessThan(at("preview"));
    expect(at("iconQueue")).toBeLessThan(at("grid"));
    // the session write sees the settled state
    expect(at("stripSelectable")).toBe(RENDER_STEP_ORDER.length - 1);
  });

  test("syncs state.cwd from history[histIdx] before the steps run", () => {
    const state = mkState("/a");
    state.histIdx = 2;
    let cwdSeen = "";
    const renderAll = makeRenderAll({
      state,
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: () => {},
      steps: {
        probe: () => {
          cwdSeen = state.cwd;
        },
      },
    });
    renderAll();
    expect(cwdSeen).toBe("/third");
    expect(state.cwd).toBe("/third");
  });

  test("an out-of-range histIdx is RESET, not silently ignored", () => {
    const state = mkState("/a");
    state.histIdx = 99;
    const logs: string[] = [];
    makeRenderAll({
      state,
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: (m) => logs.push(m),
      steps: {},
    })();
    // the index was clamped into range — the cwd follows the history
    expect(state.histIdx).toBe(2);
    expect(state.cwd).toBe("/third");
    // and the repair was ANNOUNCED (the old shape kept the cwd silently)
    expect(logs.some((m) => m.includes("history index"))).toBe(true);
  });

  test("a throwing step is logged and the remaining steps still run", () => {
    const order: string[] = [];
    const logs: string[] = [];
    makeRenderAll({
      state: mkState("/a"),
      syncTabFromState: () => {},
      scheduleSaveSession: () => order.push("save"),
      log: (m) => logs.push(m),
      steps: {
        first: () => {
          order.push("first");
        },
        boom: () => {
          throw new Error("kaboom");
        },
        after: () => {
          order.push("after");
        },
      },
    })();
    expect(order).toEqual(["first", "after", "save"]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("render boom");
    expect(logs[0]).toContain("kaboom");
  });

  test("settled() waits for the async steps (the grid build is async)", async () => {
    // The boot reveals the app after settled(): a render that only waits for
    // the sync tail paints a half-built app (the grid arrives a frame later).
    let built = false;
    const renderAll = makeRenderAll({
      state: mkState("/a"),
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: () => {},
      steps: {
        grid: async () => {
          await new Promise((r) => setTimeout(r, 20));
          built = true;
        },
      },
    });
    renderAll();
    expect(built).toBe(false);
    await renderAll.settled();
    expect(built).toBe(true);
  });

  test("settled() survives a rejected async step (the error is logged, not rethrown)", async () => {
    const logs: string[] = [];
    const renderAll = makeRenderAll({
      state: mkState("/a"),
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: (m) => logs.push(m),
      steps: {
        grid: async () => {
          throw new Error("late kaboom");
        },
      },
    });
    renderAll();
    await renderAll.settled();
    expect(logs.some((l) => l.includes("late kaboom"))).toBe(true);
  });

  test("an async step rejection is logged without blocking the sync tail", async () => {
    const logs: string[] = [];
    let resolved = false;
    makeRenderAll({
      state: mkState("/a"),
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: (m) => logs.push(m),
      steps: {
        asyncBoom: async () => {
          await new Promise((r) => setTimeout(r, 5));
          resolved = true;
          throw new Error("late kaboom");
        },
      },
    })();
    await settleUntil(() => resolved);
    await settleUntil(() => logs.some((l) => l.includes("late kaboom")));
    expect(logs.some((l) => l.includes("render asyncBoom (async)"))).toBe(true);
  });
});
