import { describe, expect, test, vi } from "bun:test";
import { clearChildren, debounced, safeRenderStep } from "./uiutil";

describe("clearChildren", () => {
  test("removes every child of the node", () => {
    const removed: any[] = [];
    const kids = [{}, {}, {}];
    const node = {
      getChildren: () => [...kids],
      remove: (c: any) => removed.push(c),
    };
    clearChildren(node);
    expect(removed).toEqual(kids);
  });

  test("tolerates null nodes and throwing hosts", () => {
    expect(() => clearChildren(null)).not.toThrow();
    expect(() => clearChildren(undefined)).not.toThrow();
    expect(() => clearChildren({ getChildren: () => { throw new Error("dead"); } })).not.toThrow();
  });
});

describe("debounced", () => {
  test("trails: every call pushes the run back, body sees latest closure state", async () => {
    let state = "a";
    let runs = 0;
    const run = debounced(30, () => { runs++; state += "!"; });
    run();
    await Bun.sleep(10);
    state = "b";
    run(); // pushes the pending run back
    await Bun.sleep(10);
    expect(runs).toBe(0); // still waiting
    await Bun.sleep(40);
    expect(runs).toBe(1);
    expect(state).toBe("b!"); // body read the latest state when it fired
  });

  test("without new calls it fires once", async () => {
    let runs = 0;
    const run = debounced(20, () => runs++);
    run();
    await Bun.sleep(50);
    expect(runs).toBe(1);
  });
});

describe("safeRenderStep", () => {
  test("sync throw is logged, not thrown", () => {
    const logs: string[] = [];
    expect(() =>
      safeRenderStep("step", () => { throw new Error("boom"); }, (m) => logs.push(m)),
    ).not.toThrow();
    expect(logs.length).toBe(1);
    // logged as `render <name>: <stack-or-error>`
    expect(logs[0]).toContain("render step:");
    expect(logs[0]).toContain("boom");
  });

  test("async rejection is caught and logged", async () => {
    const logs: string[] = [];
    safeRenderStep("async-step", async () => { throw new Error("late boom"); }, (m) => logs.push(m));
    await Bun.sleep(20);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("render async-step (async):");
    expect(logs[0]).toContain("late boom");
  });

  test("happy path runs the fn", () => {
    let ran = false;
    safeRenderStep("ok", () => { ran = true; });
    expect(ran).toBe(true);
  });
});
