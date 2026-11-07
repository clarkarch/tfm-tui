import { describe, expect, test } from "bun:test";
import { makeForceQuit, makeQuit, type QuitCtx } from "./quit";
import { makeTeardownState } from "../lib/teardown-state";

const mkCtx = (
  calls: string[],
  fail?:
    | "drops"
    | "release"
    | "destroy"
    | "session"
    | "terminal"
    | "gpm"
    | "chrome"
    | "updates"
    | "devices"
    | "onQuit"
    | "watchers"
    | "config",
): QuitCtx & { codes: number[] } => {
  const codes: number[] = [];
  return {
    codes,
    teardown: makeTeardownState(),
    disableDrops: () => {
      calls.push("drops");
      if (fail === "drops") throw new Error("osc write failed");
    },
    releaseShiftCapture: () => {
      calls.push("release");
      if (fail === "release") throw new Error("stdout closed");
    },
    flushSession: () => {
      calls.push("session");
      if (fail === "session") throw new Error("journal write failed");
    },
    closeTerminal: () => {
      calls.push("terminal");
      if (fail === "terminal") throw new Error("pty close failed");
    },
    stopGpm: () => {
      calls.push("gpm");
      if (fail === "gpm") throw new Error("gpm close failed");
    },
    stopChromeTimers: () => {
      calls.push("chrome");
      if (fail === "chrome") throw new Error("chrome timer clear failed");
    },
    stopDevices: () => {
      calls.push("devices");
      if (fail === "devices") throw new Error("device poller close failed");
    },
    stopUpdates: () => {
      calls.push("updates");
      if (fail === "updates") throw new Error("update fetch abort failed");
    },
    stopWatchers: () => {
      calls.push("watchers");
      if (fail === "watchers") throw new Error("watcher close failed");
    },
    stopConfigWatch: () => {
      calls.push("config");
      if (fail === "config") throw new Error("config watch close failed");
    },
    onQuit: () => {
      calls.push("onQuit");
      if (fail === "onQuit") throw new Error("plugin deactivate failed");
    },
    destroy: () => {
      calls.push("destroy");
      if (fail === "destroy") throw new Error("renderer gone");
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
      codes.push(code);
    },
  };
};

describe("makeQuit", () => {
  test("teardown order: drops -> release -> session -> terminal -> gpm -> chrome -> devices -> updates -> watchers -> config -> onQuit -> destroy -> exit(0)", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls))();
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
      "exit:0",
    ]);
  });

  test("a throwing disableDrops still completes teardown and exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "drops"))();
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
      "exit:1",
    ]);
  });

  test("a throwing shift-release still completes teardown and exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "release"))();
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
      "exit:1",
    ]);
  });

  test("a throwing renderer destroy still exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "destroy"))();
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
      "exit:1",
    ]);
  });

  test("refuses to quit while file ops are in flight (no teardown, no exit)", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    let busied = 0;
    const busyCtx: QuitCtx & { codes: number[] } = {
      ...ctx,
      codes: ctx.codes,
      isBusy: () => true,
      onBusy: () => {
        busied++;
      },
    };
    makeQuit(busyCtx)();
    expect(calls).toEqual([]);
    expect(busied).toBe(1);
  });

  test("exit code is 0 clean, 1 when any teardown step threw", () => {
    const okCalls: string[] = [];
    const okCtx = mkCtx(okCalls);
    makeQuit(okCtx)();
    expect(okCtx.codes).toEqual([0]);
    for (const fail of [
      "drops",
      "release",
      "destroy",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "updates",
      "devices",
      "watchers",
      "config",
      "onQuit",
    ] as const) {
      const calls: string[] = [];
      const ctx = mkCtx(calls, fail);
      makeQuit(ctx)();
      expect(ctx.codes).toEqual([1]);
    }
  });

  test("exit waits for renderer.closed (0.6.0: destroy returns at once, terminal restore finishes later)", async () => {
    // deferred closed: exit must NOT run until the async teardown settles, or
    // the terminal restore truncates and the alt screen never unwinds
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    let resolveClosed!: () => void;
    (ctx as QuitCtx & { closed?: () => Promise<void> }).closed = () => new Promise<void>((r) => (resolveClosed = r));
    makeQuit(ctx)();
    // the USB device poller stops with the chrome timers (a poll landing
    // post-teardown would re-render into the destroyed renderer)
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
    ]);
    resolveClosed();
    await Bun.sleep(0);
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
      "exit:0",
    ]);
  });

  test("a rejected closed exits 1 (stream failure during async teardown)", async () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    (ctx as QuitCtx & { closed?: () => Promise<void> }).closed = () => Promise.reject(new Error("stdout EIO"));
    makeQuit(ctx)();
    await Bun.sleep(0);
    expect(ctx.codes).toEqual([1]);
  });

  test("a throwing destroy bypasses the closed wait (never-armed closed would hang)", () => {
    // upstream arms closed only past destroy's internal arming — a destroy
    // that throws never settles closed, so waiting would hang instead of
    // exiting 1. The never-promise proves no wait: exit is synchronous.
    const calls: string[] = [];
    const ctx = mkCtx(calls, "destroy");
    (ctx as QuitCtx & { closed?: () => Promise<void> }).closed = () => new Promise<void>(() => {});
    makeQuit(ctx)();
    expect(calls[calls.length - 1]).toBe("exit:1");
    expect(ctx.codes).toEqual([1]);
  });

  test("a synchronously-throwing closed() exits 1", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    (ctx as QuitCtx & { closed?: () => Promise<void> }).closed = () => {
      throw new Error("seam gone");
    };
    makeQuit(ctx)();
    expect(ctx.codes).toEqual([1]);
  });

  test("force quit bypasses the busy refusal (signal path must never re-orphan)", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    let busied = 0;
    const busyCtx: QuitCtx & { codes: number[] } = {
      ...ctx,
      codes: ctx.codes,
      isBusy: () => true,
      onBusy: () => {
        busied++;
      },
    };
    makeForceQuit(busyCtx)();
    expect(busied).toBe(0);
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "terminal",
      "gpm",
      "chrome",
      "devices",
      "updates",
      "watchers",
      "config",
      "onQuit",
      "destroy",
      "exit:0",
    ]);
  });

  test("force quit closes watchers + config watch even without the busy guard", () => {
    const calls: string[] = [];
    makeForceQuit(mkCtx(calls))();
    expect(calls).toContain("watchers");
    expect(calls).toContain("config");
  });

  test("force quit caps a never-settling closed (dead pts must not re-orphan)", async () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    (ctx as QuitCtx & { closed?: () => Promise<void> }).closed = () => new Promise<void>(() => {});
    const t0 = Date.now();
    makeForceQuit(ctx)();
    while (ctx.codes.length === 0 && Date.now() - t0 < 5000) await Bun.sleep(25);
    expect(ctx.codes).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

// The teardown lifecycle has ONE owner. Before this, "the app is shutting
// down" had no state variable at all: a HELD ctrl+q (the quit action has no
// autorepeat guard, unlike the restart action next to it) ran the whole
// 11-step teardown N times — two renderer.destroy() calls, two exit chains.
describe("teardown ownership", () => {
  test("a second quit runs NOTHING (the teardown steps run once)", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    const quit = makeQuit(ctx);
    quit();
    quit();
    // exactly ONE pass through the teardown, and exactly ONE exit
    expect(calls.filter((c) => c === "drops")).toHaveLength(1);
    expect(calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("exit:"))).toHaveLength(1);
    expect(ctx.codes).toEqual([0]);
  });

  test("force quit still CASes: a quit after a force quit runs nothing", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    makeForceQuit(ctx)();
    makeQuit(ctx)();
    expect(calls.filter((c) => c === "drops")).toHaveLength(1);
    expect(calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect(ctx.codes).toEqual([0]);
  });

  test("a quit after a force quit is refused even when a file op is running", () => {
    // the busy refusal must not be reached a second time — the teardown is
    // already owned, so the second call is a NO-OP (no second busy toast)
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    let busied = 0;
    const busyCtx: QuitCtx & { codes: number[] } = {
      ...ctx,
      codes: ctx.codes,
      isBusy: () => true,
      onBusy: () => {
        busied++;
      },
    };
    makeForceQuit(busyCtx)();
    makeQuit(busyCtx)();
    expect(busied).toBe(0);
    expect(calls.filter((c) => c === "destroy")).toHaveLength(1);
  });

  test("a busy refusal does NOT consume the teardown (a later quit still works)", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    let busy = true;
    const busyCtx: QuitCtx & { codes: number[] } = {
      ...ctx,
      codes: ctx.codes,
      isBusy: () => busy,
      onBusy: () => {},
    };
    makeQuit(busyCtx)();
    expect(calls).toEqual([]);
    busy = false;
    makeQuit(busyCtx)();
    expect(calls).toContain("destroy");
    expect(ctx.codes).toEqual([0]);
  });
});
