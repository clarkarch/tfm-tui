import { describe, expect, test } from "bun:test";
import { makeQuit, type QuitCtx } from "./quit";

const mkCtx = (calls: string[], fail?: "drops" | "release" | "destroy"): QuitCtx & { codes: number[] } => {
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
    destroy: () => {
      calls.push("destroy");
      if (fail === "destroy") throw new Error("renderer gone");
    },
    exit: (code) => { calls.push(`exit:${code}`); codes.push(code); },
  };
};

describe("makeQuit", () => {
  test("teardown order: drops -> shift-release -> destroy -> exit(0)", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls))();
    expect(calls).toEqual(["drops", "release", "destroy", "exit:0"]);
  });

  test("a throwing disableDrops still releases, destroys and exits", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "drops"))();
    expect(calls).toEqual(["drops", "release", "destroy", "exit:0"]);
  });

  test("a throwing shift-release still destroys and exits", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "release"))();
    expect(calls).toEqual(["drops", "release", "destroy", "exit:0"]);
  });

  test("a throwing renderer destroy still exits", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "destroy"))();
    expect(calls).toEqual(["drops", "release", "destroy", "exit:0"]);
  });

  test("exit code is always 0", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    makeQuit(ctx)();
    expect(ctx.codes).toEqual([0]);
  });
});
