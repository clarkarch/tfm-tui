import { describe, expect, test } from "bun:test";
import { makeQuit, type QuitCtx } from "./quit";

const mkCtx = (
  calls: string[],
  fail?: "drops" | "release" | "destroy" | "session" | "terminal" | "onQuit",
): QuitCtx & { codes: number[] } => {
  const codes: number[] = [];
  return {
    codes,
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
  test("teardown order: drops -> release -> session -> terminal -> onQuit -> destroy -> exit(0)", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "onQuit", "destroy", "exit:0"]);
  });

  test("a throwing disableDrops still completes teardown and exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "drops"))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "onQuit", "destroy", "exit:1"]);
  });

  test("a throwing shift-release still completes teardown and exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "release"))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "onQuit", "destroy", "exit:1"]);
  });

  test("a throwing renderer destroy still exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "destroy"))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "onQuit", "destroy", "exit:1"]);
  });

  test("exit code is 0 clean, 1 when any teardown step threw", () => {
    const okCalls: string[] = [];
    const okCtx = mkCtx(okCalls);
    makeQuit(okCtx)();
    expect(okCtx.codes).toEqual([0]);
    for (const fail of ["drops", "release", "destroy", "session", "terminal", "onQuit"] as const) {
      const calls: string[] = [];
      const ctx = mkCtx(calls, fail);
      makeQuit(ctx)();
      expect(ctx.codes).toEqual([1]);
    }
  });
});
