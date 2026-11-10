import { describe, expect, test } from "bun:test";
import {
  ensureSudoAuth,
  isPrivilegeError,
  makeEnsureSudo,
  runSudo,
  sudoAvailable,
  sudoCpArgv,
  sudoExecError,
  sudoMvArgv,
  sudoLaunchArgv,
  sudoOpenArgv,
  sudoRmArgv,
} from "./elevate";
import { PrivilegeError } from "./privilege-error";
import { errCode, fsErrText, SourceRemovalFailedError } from "./fsutil";

describe("isPrivilegeError", () => {
  test("EACCES/EPERM qualify, others do not", () => {
    expect(isPrivilegeError({ code: "EACCES" })).toBe(true);
    expect(isPrivilegeError({ code: "EPERM" })).toBe(true);
    expect(isPrivilegeError({ code: "ENOENT" })).toBe(false);
    expect(isPrivilegeError(new Error("some other failure"))).toBe(false);
  });
  test("a non-privilege error with permission-denied TEXT does not trigger sudo", () => {
    // the old detector matched the prose anywhere in the message, so a stray
    // "permission denied" (a remote host's message, a tool's own wording)
    // asked the user for a ROOT PASSWORD — the privilege fact must travel
    // with the error, not be guessed from its text
    expect(isPrivilegeError(new Error("the remote host said: permission denied"))).toBe(false);
    expect(isPrivilegeError(new Error("permission denied"))).toBe(false);
  });
  test("a source-partially-removed wrapper qualifies when the removal error was privileged", () => {
    // the wrapper keeps the ORIGINAL error, so the fact travels with it —
    // the old "the message says permission denied" match was the bug
    const inner = Object.assign(new Error("rm: EACCES"), { code: "EACCES" });
    expect(isPrivilegeError(new SourceRemovalFailedError("/dest", inner))).toBe(true);
    // ... and a wrapper whose inner error was NOT privileged does not qualify
    expect(isPrivilegeError(new SourceRemovalFailedError("/dest", new Error("device busy")))).toBe(false);
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
  test("runSudo degrades to null-status on a missing binary, never rejects", async () => {
    // Bun throws ENOENT synchronously (unlike node spawn's async error event)
    // — the runner must convert it so callers toast instead of rejecting
    const r = await runSudo(["definitely-not-a-binary-tfm-xyz"]);
    expect(r.status).toBeNull();
    expect(r.stderr).toMatch(/not found/i);
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
  test("the refusal is the NORMALIZED type, not a prose match", () => {
    // the sudo layer knows what a refusal looks like — it classifies the
    // child's stderr ONCE and throws the one type the detector understands
    expect(sudoExecError("cp: cannot create regular file 'x': Permission denied\n")).toBeInstanceOf(PrivilegeError);
    // a failure that is NOT a refusal stays a plain error (no code, no type)
    const other = sudoExecError("cp: omitting directory 'x'\n");
    expect(other).not.toBeInstanceOf(PrivilegeError);
  });
  test("a sudo failure with unusual wording is still a privilege error", () => {
    // EPERM's strerror is "Operation not permitted" — the old matcher only
    // knew "Permission denied", so a privileged failure worded the other way
    // was MISSED and the escalation never happened
    const err = sudoExecError("cp: cannot create regular file 'x': Operation not permitted\n");
    expect(isPrivilegeError(err)).toBe(true);
    expect(fsErrText(err)).toBe("permission denied");
  });
  test("other stderr stays raw without a code", () => {
    const err = sudoExecError("cp: omitting directory 'x'\n");
    expect(fsErrText(err)).toBe("cp");
    expect(errCode(err)).toBeUndefined();
  });
  test("empty stderr degrades to permission denied", () => {
    expect(fsErrText(sudoExecError(""))).toBe("permission denied");
    // a silent refusal is still a refusal (the old default said so)
    expect(isPrivilegeError(sudoExecError(""))).toBe(true);
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
    expect(notes.some((n) => n.includes("sudo missing"))).toBe(true);
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
