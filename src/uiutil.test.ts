import { describe, expect, test } from "bun:test";
import { clearChildren, debounced, safeRenderStep, type Scheduler } from "./uiutil";

// Bun 1.3.14 has no fake timers, so debounced takes an injected Scheduler:
// these tests advance a virtual clock and never race the wall clock (a
// fixed-sleep version of the trails test flaked red under parallel load).
const mkClock = () => {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const sched: Scheduler = {
    setTimeout: (cb, ms) => {
      timers.set(++id, { at: now + ms, cb });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (const [k, t] of [...timers]) {
      if (t.at <= target) {
        timers.delete(k);
        now = t.at;
        t.cb();
      }
    }
    now = target;
  };
  return { sched, advance, pending: () => timers.size };
};

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
    expect(() =>
      clearChildren({
        getChildren: () => {
          throw new Error("dead");
        },
      }),
    ).not.toThrow();
  });
});

describe("debounced", () => {
  test("trails: every call pushes the run back, body sees latest closure state", () => {
    const { sched, advance, pending } = mkClock();
    let state = "a";
    let runs = 0;
    const run = debounced(30, () => {
      runs++;
      state += "!";
    }, sched);
    run();
    advance(10);
    state = "b";
    run(); // pushes the pending run back
    advance(10);
    expect(runs).toBe(0); // still waiting
    advance(40);
    expect(runs).toBe(1);
    expect(state).toBe("b!"); // body read the latest state when it fired
    expect(pending()).toBe(0);
  });

  test("without new calls it fires exactly once", () => {
    const { sched, advance } = mkClock();
    let runs = 0;
    const run = debounced(20, () => runs++, sched);
    run();
    advance(1000);
    expect(runs).toBe(1);
    advance(1000);
    expect(runs).toBe(1);
  });

  test("default scheduler still works against the real clock", async () => {
    let runs = 0;
    const run = debounced(5, () => runs++);
    run();
    await Bun.sleep(50);
    expect(runs).toBe(1);
  });
});

describe("safeRenderStep", () => {
  test("sync throw is logged, not thrown", () => {
    const logs: string[] = [];
    expect(() =>
      safeRenderStep(
        "step",
        () => {
          throw new Error("boom");
        },
        (m) => logs.push(m),
      ),
    ).not.toThrow();
    expect(logs.length).toBe(1);
    // logged as `render <name>: <stack-or-error>`
    expect(logs[0]).toContain("render step:");
    expect(logs[0]).toContain("boom");
  });

  test("async rejection is caught and logged", async () => {
    const logs: string[] = [];
    safeRenderStep(
      "async-step",
      async () => {
        throw new Error("late boom");
      },
      (m) => logs.push(m),
    );
    await Bun.sleep(20);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("render async-step (async):");
    expect(logs[0]).toContain("late boom");
  });

  test("happy path runs the fn", () => {
    let ran = false;
    safeRenderStep("ok", () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
