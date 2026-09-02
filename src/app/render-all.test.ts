import { describe, expect, test } from "bun:test";
import { makeRenderAll, type RenderAllCtx } from "./render-all";
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
  test("runs tab-sync first, steps in insertion order, session-save last", () => {
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

  test("out-of-range histIdx keeps the current cwd", () => {
    const state = mkState("/a");
    state.histIdx = 99;
    makeRenderAll({
      state,
      syncTabFromState: () => {},
      scheduleSaveSession: () => {},
      log: () => {},
      steps: {},
    })();
    expect(state.cwd).toBe("/a");
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
