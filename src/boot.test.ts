import { describe, expect, test } from "bun:test";
import { runBoot, type BootCtx } from "./boot";

const mkCtx = (calls: string[], over: Partial<BootCtx> = {}): BootCtx => ({
  waitForResolution: async () => { calls.push("resolution"); },
  buildLayout: () => { calls.push("layout"); },
  loadGlobs2: async () => { calls.push("globs2"); },
  restoreSession: () => { calls.push("session"); },
  loadSystemPlaces: async () => { calls.push("places"); },
  renderAll: () => { calls.push("render"); },
  debugTrace: () => { calls.push("debug"); },
  launchToast: () => { calls.push("toast"); },
  startHygiene: () => { calls.push("hygiene"); },
  wireSearchInput: () => { calls.push("search"); },
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
});
