import { describe, expect, test } from "bun:test";
import { runBoot, type BootCtx } from "./boot";

const mkCtx = (calls: string[], over: Partial<BootCtx> = {}): BootCtx => ({
  waitForResolution: async () => {
    calls.push("resolution");
  },
  buildLayout: () => {
    calls.push("layout");
  },
  loadGlobs2: async () => {
    calls.push("globs2");
  },
  restoreSession: () => {
    calls.push("session");
  },
  loadSystemPlaces: async () => {
    calls.push("places");
  },
  renderAll: () => {
    calls.push("render");
  },
  debugTrace: () => {
    calls.push("debug");
  },
  launchToast: () => {
    calls.push("toast");
  },
  startHygiene: () => {
    calls.push("hygiene");
  },
  wireSearchInput: () => {
    calls.push("search");
  },
  isDebug: false,
  showLaunchTime: () => false,
  ...over,
});

describe("runBoot", () => {
  test("the load-bearing order: resolution -> layout -> globs2 -> session -> places -> render", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls));
    expect(calls).toEqual(["resolution", "layout", "globs2", "session", "places", "render", "hygiene", "search"]);
  });

  test("quiet boot: no debug trace, no launch toast", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls));
    expect(calls).not.toContain("debug");
    expect(calls).not.toContain("toast");
  });

  test("show-launch-time surfaces the toast but not the debug trace", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls, { showLaunchTime: () => true }));
    expect(calls).toContain("toast");
    expect(calls).not.toContain("debug");
  });

  test("--debug traces AND toasts (debug implies the launch time)", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls, { isDebug: true }));
    expect(calls).toContain("debug");
    expect(calls).toContain("toast");
  });

  test("hygiene + search wiring run after the first render", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls));
    expect(calls.indexOf("render")).toBeLessThan(calls.indexOf("hygiene"));
    expect(calls.indexOf("hygiene")).toBeLessThan(calls.indexOf("search"));
  });

  test("a throwing step is reported but the sequence continues (no blank TUI)", async () => {
    const calls: string[] = [];
    const reported: string[] = [];
    // buildLayout throws (native-OOM class) — renderAll must STILL run so the
    // app paints instead of a silently-alive blank pane
    await runBoot(
      mkCtx(calls, {
        buildLayout: () => {
          calls.push("layout");
          throw new Error("boom");
        },
        reportBootError: (name, _err) => {
          reported.push(name);
        },
      }),
    );
    expect(reported).toEqual(["buildLayout"]);
    expect(calls).toContain("render"); // boot completes despite the throw
  });

  test("a rejecting async step is reported but the sequence continues", async () => {
    const calls: string[] = [];
    const reported: string[] = [];
    await runBoot(
      mkCtx(calls, {
        loadSystemPlaces: async () => {
          calls.push("places");
          throw new Error("async-boom");
        },
        reportBootError: (name) => {
          reported.push(name);
        },
      }),
    );
    expect(reported).toEqual(["loadSystemPlaces"]);
    expect(calls).toContain("render");
  });

  test("restart child clears stale kitty placements before anything draws", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls, { isRestartChild: true, clearStaleImages: () => calls.push("clearImages") }));
    expect(calls[0]).toBe("clearImages");
    expect(calls.indexOf("clearImages")).toBeLessThan(calls.indexOf("render"));
  });

  test("fresh boot never touches placements (other apps' images are safe)", async () => {
    const calls: string[] = [];
    await runBoot(mkCtx(calls, { clearStaleImages: () => calls.push("clearImages") }));
    expect(calls).not.toContain("clearImages");
  });

  test("a throwing clearStaleImages is reported but the sequence continues", async () => {
    const calls: string[] = [];
    const reported: string[] = [];
    await runBoot(
      mkCtx(calls, {
        isRestartChild: true,
        clearStaleImages: () => {
          throw new Error("stdout closed");
        },
        reportBootError: (name) => {
          reported.push(name);
        },
      }),
    );
    expect(reported).toEqual(["clearStaleImages"]);
    expect(calls).toContain("render");
  });
});
