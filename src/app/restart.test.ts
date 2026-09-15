import { describe, expect, test } from "bun:test";
import { consumeRestartFlag, makeRestart, RESTART_ENV, restartArgs, type RestartCtx } from "./restart";

const mkCtx = (
  calls: string[],
  opts: {
    status?: number | null;
    spawnThrow?: boolean;
    spawnError?: boolean;
    preflightThrow?: boolean;
    destroyThrow?: boolean;
    teardownThrow?: boolean;
    recoverThrow?: boolean;
    busy?: boolean;
  } = {},
): RestartCtx & { codes: number[] } => {
  const codes: number[] = [];
  return {
    codes,
    execPath: "/usr/bin/tfm",
    argv: ["one", "two"],
    preflight: (p) => {
      calls.push(`preflight:${p}`);
      if (opts.preflightThrow) throw new Error("nope");
    },
    spawn: ((cmd: string, args: string[], spawnOpts: unknown) => {
      calls.push(`spawn:${cmd}:${args.join(",")}:${JSON.stringify(spawnOpts)}`);
      if (opts.spawnThrow) throw new Error("boom");
      if (opts.spawnError) return { status: null, error: new Error("ENOENT") };
      return { status: opts.status !== undefined ? opts.status : 0 };
    }) as never,
    isBusy: () => !!opts.busy,
    disableDrops: () => {
      calls.push("drops");
      if (opts.teardownThrow) throw new Error("osc write failed");
    },
    releaseShiftCapture: () => calls.push("release"),
    flushSession: () => calls.push("session"),
    closeTerminal: () => calls.push("terminal"),
    onQuit: () => calls.push("onQuit"),
    destroy: () => {
      calls.push("destroy");
      if (opts.destroyThrow) throw new Error("renderer gone");
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
      codes.push(code);
    },
    recover: () => {
      calls.push("recover");
      if (opts.recoverThrow) throw new Error("render failed");
    },
    notify: (m: string) => calls.push(`notify:${m}`),
  };
};

describe("makeRestart", () => {
  test("preflight -> teardown -> spawn (inherit, same group) -> destroy -> exit(child status)", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls, { status: 42 });
    makeRestart(ctx)();
    expect(calls).toEqual([
      "preflight:/usr/bin/tfm",
      "drops",
      "release",
      "session",
      "terminal",
      "onQuit",
      expect.stringMatching(/^spawn:\/usr\/bin\/tfm:one,two:\{"stdio":"inherit","env":.*\}$/),
      "destroy",
      "exit:42",
    ]);
    expect(ctx.codes).toEqual([42]);
  });

  test("spawn env marks the child as a restart generation (boot clears stale images)", () => {
    let seen: { stdio?: unknown; detached?: unknown; env?: Record<string, string | undefined> } | undefined;
    const ctx = mkCtx([]);
    ctx.spawn = ((_cmd: string, _args: string[], opts: NonNullable<typeof seen>) => {
      seen = opts;
      return { status: 0 };
    }) as never;
    makeRestart(ctx)();
    // inherit keeps the foreground with the waiting parent (a detached child
    // competes with the shell for input — echoed garbage + dead keys)
    expect(seen?.stdio).toBe("inherit");
    expect(seen).not.toHaveProperty("detached");
    expect(seen?.env?.TFM_RESTART).toBe("1");
  });

  test("spawn passes argv through untouched", () => {
    const seen: string[][] = [];
    const ctx = mkCtx([]);
    ctx.argv = ["--config", "/tmp/c.toml", "/some/dir"];
    ctx.spawn = ((cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return { status: 0 };
    }) as never;
    makeRestart(ctx)();
    expect(seen).toEqual([["/usr/bin/tfm", "--config", "/tmp/c.toml", "/some/dir"]]);
  });

  test("preflight failure notifies and touches nothing else", () => {
    const calls: string[] = [];
    makeRestart(mkCtx(calls, { preflightThrow: true }))();
    expect(calls).toEqual(["preflight:/usr/bin/tfm", "notify:restart failed: nope"]);
  });

  test("spawn failure recovers, notifies, and never destroys/exits", () => {
    const calls: string[] = [];
    makeRestart(mkCtx(calls, { spawnThrow: true }))();
    expect(calls).toEqual([
      "preflight:/usr/bin/tfm",
      "drops",
      "release",
      "session",
      "terminal",
      "onQuit",
      expect.stringContaining("spawn:"),
      "recover",
      "notify:restart failed: boom",
    ]);
  });

  test("signaled child (null status) exits 1; teardown failure exits 1 with child status dropped", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls, { status: null });
    makeRestart(ctx)();
    expect(ctx.codes).toEqual([1]);

    const calls2: string[] = [];
    const ctx2 = mkCtx(calls2, { status: 0, destroyThrow: true });
    makeRestart(ctx2)();
    expect(ctx2.codes).toEqual([1]);
  });

  test("busy queue refuses before teardown (live transfer keeps its staging temp)", () => {
    const calls: string[] = [];
    makeRestart(mkCtx(calls, { busy: true }))();
    expect(calls).toEqual(["preflight:/usr/bin/tfm", "notify:Can't restart during file operations"]);
  });

  test("teardown failure still spawns, then exits 1", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls, { status: 0, teardownThrow: true });
    makeRestart(ctx)();
    expect(calls).toEqual([
      "preflight:/usr/bin/tfm",
      "drops",
      "release",
      "session",
      "terminal",
      "onQuit",
      expect.stringContaining("spawn:"),
      "destroy",
      "exit:1",
    ]);
    expect(ctx.codes).toEqual([1]);
  });

  test("spawnSync error RESULT (no throw) recovers and notifies like a throw", () => {
    const calls: string[] = [];
    makeRestart(mkCtx(calls, { spawnError: true }))();
    expect(calls).toEqual([
      "preflight:/usr/bin/tfm",
      "drops",
      "release",
      "session",
      "terminal",
      "onQuit",
      expect.stringContaining("spawn:"),
      "recover",
      "notify:restart failed: ENOENT",
    ]);
  });

  test("a throwing recover still notifies and stays alive", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls, { spawnThrow: true, recoverThrow: true });
    makeRestart(ctx)();
    expect(calls).toContain("recover");
    expect(calls).toContain("notify:restart failed: boom");
    expect(calls).not.toContain("destroy");
    expect(ctx.codes).toEqual([]);
  });
});

describe("restartArgs", () => {
  test("compiled binary strips the /$bunfs/ virtual entry (else the child treats it as a PATH)", () => {
    expect(restartArgs(["bun", "/$bunfs/root/tfm", "--debug", "/tmp"])).toEqual(["--debug", "/tmp"]);
  });

  test("compiled binary with no user args spawns bare", () => {
    expect(restartArgs(["bun", "/$bunfs/root/tfm"])).toEqual([]);
  });

  test("dev runner strips the script token", () => {
    expect(restartArgs(["/home/u/.bun/bin/bun", "/repo/src/index.ts", "/tmp"])).toEqual(["/tmp"]);
  });

  test("a real user path is never stripped (non-runner argv[0])", () => {
    expect(restartArgs(["/usr/bin/tfm", "index.ts"])).toEqual(["index.ts"]);
  });
});

describe("consumeRestartFlag", () => {
  test("marked env reads true and is deleted", () => {
    const env: Record<string, string | undefined> = { [RESTART_ENV]: "1", PATH: "/bin" };
    expect(consumeRestartFlag(env)).toBe(true);
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("unmarked and stale values read false but are still cleared", () => {
    expect(consumeRestartFlag({})).toBe(false);
    const stale: Record<string, string | undefined> = { [RESTART_ENV]: "0" };
    expect(consumeRestartFlag(stale)).toBe(false);
    expect(stale).toEqual({});
  });

  test("re-set after consume reads true again (nested restarts)", () => {
    const env: Record<string, string | undefined> = { [RESTART_ENV]: "1" };
    expect(consumeRestartFlag(env)).toBe(true);
    env[RESTART_ENV] = "1"; // what the next restart's spawn env does
    expect(consumeRestartFlag(env)).toBe(true);
  });
});
