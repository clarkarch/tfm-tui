import { describe, expect, test } from "bun:test";
import {
  ensureSudoAuth,
  isPrivilegeError,
  makeEnsureSudo,
  sudoAvailable,
  sudoCpArgv,
  sudoExecError,
  sudoMvArgv,
  sudoLaunchArgv,
  sudoOpenArgv,
  sudoRmArgv,
} from "./elevate";
import { errCode, fsErrText } from "./fsutil";

describe("isPrivilegeError", () => {
  test("EACCES/EPERM qualify, others do not", () => {
    expect(isPrivilegeError({ code: "EACCES" })).toBe(true);
    expect(isPrivilegeError({ code: "EPERM" })).toBe(true);
    expect(isPrivilegeError({ code: "ENOENT" })).toBe(false);
    expect(isPrivilegeError(new Error("some other failure"))).toBe(false);
  });
  test("wrapped source-partially-removed with permission denied qualifies", () => {
    expect(isPrivilegeError(new Error("source partially removed: permission denied"))).toBe(true);
  });
});

describe("sudo argv", () => {
  test("cp/mv carry -- and never embed a password", () => {
    expect(sudoCpArgv("/a/-dash", "/b/out")).toEqual(["sudo", "-n", "cp", "-a", "--", "/a/-dash", "/b/out"]);
    expect(sudoMvArgv("/a/x", "/b/y")).toEqual(["sudo", "-n", "mv", "--", "/a/x", "/b/y"]);
  });
  test("sudoAvailable honors injected which", () => {
    expect(sudoAvailable(() => null)).toBe(false);
    expect(sudoAvailable(() => "/usr/bin/sudo")).toBe(true);
  });
});

describe("ensureSudoAuth", () => {
  test("cached timestamp skips password prompt", async () => {
    let prompts = 0;
    const ok = await ensureSudoAuth({
      cached: async () => true,
      validate: async () => {
        throw new Error("should not validate");
      },
      prompt: async () => {
        prompts++;
        return "pw";
      },
      notify: () => {},
    });
    expect(ok).toBe(true);
    expect(prompts).toBe(0);
  });
  test("cancel resolves false without validate", async () => {
    let validated = 0;
    const ok = await ensureSudoAuth({
      cached: async () => false,
      validate: async () => {
        validated++;
        return true;
      },
      prompt: async () => null,
      notify: () => {},
    });
    expect(ok).toBe(false);
    expect(validated).toBe(0);
  });
  test("wrong password notifies and retries, third success wins", async () => {
    const notes: string[] = [];
    let calls = 0;
    const ok = await ensureSudoAuth({
      cached: async () => false,
      validate: async () => ++calls >= 3,
      prompt: async (_title: string) => "pw",
      notify: (m: string) => void notes.push(m),
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(notes.some((n) => n.includes("Authentication failed"))).toBe(true);
  });
});

describe("sudo argv shapes", () => {
  test("open carries -n -E but no -- (sudo strips the HYPHEN var that makes -- legal)", () => {
    expect(sudoOpenArgv("/a/-dash.txt")).toEqual(["sudo", "-n", "-E", "xdg-open", "/a/-dash.txt"]);
  });
  test("launch carries desktop file + target, no --", () => {
    expect(sudoLaunchArgv("/x/micro.desktop", "/root/f")).toEqual([
      "sudo",
      "-n",
      "-E",
      "gio",
      "launch",
      "/x/micro.desktop",
      "/root/f",
    ]);
  });
  test("rm carries --", () => {
    expect(sudoRmArgv("/a/-dash")).toEqual(["sudo", "-n", "rm", "-rf", "--", "/a/-dash"]);
  });
});

describe("sudoExecError", () => {
  test("permission-denied stderr keeps a classifiable code", () => {
    const err = sudoExecError("cp: cannot create regular file 'x': Permission denied\n");
    expect(err.message).toBe("cp: cannot create regular file 'x': Permission denied");
    expect(fsErrText(err)).toBe("permission denied");
  });
  test("other stderr stays raw without a code", () => {
    const err = sudoExecError("cp: omitting directory 'x'\n");
    expect(fsErrText(err)).toBe("cp");
    expect(errCode(err)).toBeUndefined();
  });
  test("empty stderr degrades to permission denied", () => {
    expect(fsErrText(sudoExecError(""))).toBe("permission denied");
  });
});

describe("ensureSudoAuth failure paths", () => {
  test("three wrong passwords resolve false with a notify per attempt", async () => {
    const notes: string[] = [];
    let calls = 0;
    const ok = await ensureSudoAuth({
      cached: async () => false,
      validate: async () => {
        calls++;
        return false;
      },
      prompt: async () => "pw",
      notify: (m: string) => void notes.push(m),
    });
    expect(ok).toBe(false);
    expect(calls).toBe(3);
    expect(notes.filter((n) => n.includes("Authentication failed")).length).toBe(3);
  });
  test("missing sudo notifies and never prompts", async () => {
    const notes: string[] = [];
    let prompts = 0;
    const ok = await ensureSudoAuth({
      cached: async () => false,
      validate: async () => true,
      prompt: async () => {
        prompts++;
        return "pw";
      },
      notify: (m: string) => void notes.push(m),
      available: () => false,
    });
    expect(ok).toBe(false);
    expect(prompts).toBe(0);
    expect(notes.some((n) => n.includes("no sudo found"))).toBe(true);
  });
});

describe("makeEnsureSudo", () => {
  test("cached timestamp skips the prompt; password travels via stdin, never argv", async () => {
    const seen: Array<{ argv: string[]; stdin?: string }> = [];
    const exec = async (argv: string[], stdin?: string): Promise<{ status: number }> => {
      seen.push({ argv, stdin });
      if (argv.includes("-v")) return { status: stdin === "s3cret" ? 0 : 1 };
      return { status: 1 };
    };
    let prompts = 0;
    const ensure = makeEnsureSudo({
      getPrompt: () => ({
        open: async (o: { title: string }) => {
          prompts++;
          expect(o.title).toContain("copy things");
          return "s3cret";
        },
      }),
      notify: () => {},
      exec,
    });
    expect(await ensure("copy things")).toBe(true);
    expect(prompts).toBe(1);
    const validateCall = seen.find((s) => s.argv.includes("-v"))!;
    expect(validateCall.argv).toEqual(["sudo", "-S", "-v"]);
    expect(validateCall.stdin).toBe("s3cret");
    expect(seen.every((s) => !s.argv.some((a) => a.includes("s3cret")))).toBe(true);
  });
  test("cached hit never prompts", async () => {
    let prompts = 0;
    const ensure = makeEnsureSudo({
      getPrompt: () => ({
        open: async () => {
          prompts++;
          return "pw";
        },
      }),
      notify: () => {},
      exec: async (argv: string[]): Promise<{ status: number }> => ({ status: argv.includes("true") ? 0 : 1 }),
    });
    expect(await ensure("x")).toBe(true);
    expect(prompts).toBe(0);
  });
});
