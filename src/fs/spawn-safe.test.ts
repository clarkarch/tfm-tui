import { describe, expect, test } from "bun:test";
import { spawnSafe } from "./spawn-safe";

// Bun.spawn-backed spawnSafe. Contract (same as the node version, pinned):
// a missing binary NEVER throws and NEVER fires an async uncaughtException —
// it reports through onFail and returns null, or opening a file on a system
// without xdg-open kills the whole TUI. Differences from node: onFail fires
// SYNCHRONOUSLY (Bun.spawn throws sync, there is no async error event), so
// callers null-guard instead of relying on a later event.

describe("spawnSafe", () => {
  test("missing binary reports through onFail and returns null (never throws)", () => {
    const errs: Error[] = [];
    const child = spawnSafe("tfm-no-such-binary-xyz", [], { stdio: "ignore" }, (e) => errs.push(e));
    expect(child).toBeNull();
    expect(errs.length).toBe(1);
    expect(errs[0]).toBeInstanceOf(Error);
  });

  test("existing binary still runs and exits cleanly", async () => {
    const p = spawnSafe(process.execPath, ["--version"]);
    expect(p).not.toBeNull();
    expect(await p!.exited).toBe(0);
    p!.unref();
  });

  test("piped stdin still works (clipboard tool shape)", async () => {
    const p = spawnSafe(process.execPath, ["-e", "const b = await Bun.stdin.text(); process.stdout.write(b)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(p).not.toBeNull();
    const stdin = p!.stdin;
    if (stdin === null || stdin === undefined || typeof stdin === "number") throw new Error("expected a piped stdin");
    stdin.write("payload");
    stdin.end();
    if (!(p!.stdout instanceof ReadableStream)) throw new Error("expected a piped stdout");
    const out = await new Response(p!.stdout).text();
    expect(await p!.exited).toBe(0);
    expect(out).toBe("payload");
  });

  test("timeoutMs kills a wedged helper instead of never resolving", async () => {
    // without the backstop this test hangs forever: a wedged udisksctl never
    // resolves, never toasts, never dies (use sleep — universally present)
    const p = spawnSafe("sleep", ["30"], { stdio: "ignore", timeoutMs: 50 });
    expect(p).not.toBeNull();
    expect(await p!.exited).not.toBe(0);
  });

  test("detached fire-and-forget shape (xdg-open) is accepted", () => {
    const errs: Error[] = [];
    const p = spawnSafe("true", [], { stdio: "ignore", detached: true }, (e) => errs.push(e));
    expect(p).not.toBeNull();
    p!.unref();
    expect(errs).toEqual([]);
  });

  test("binary resolution honors runtime PATH changes (stub dir)", async () => {
    // Bun.spawn resolves against a stale PATH unless env is passed fresh
    // (probed 1.4.0) — pin the fresh-PATH behavior with a stub binary
    const dir = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    try {
      await Bun.write(`${dir}/tfm-stub-echo`, "#!/bin/sh\necho stubbed\n");
      await Bun.$`chmod +x ${dir}/tfm-stub-echo`.quiet();
      const oldPath = process.env.PATH;
      process.env.PATH = `${dir}:${oldPath ?? ""}`;
      try {
        const p = spawnSafe("tfm-stub-echo", [], { stdio: ["ignore", "pipe", "ignore"] });
        expect(p).not.toBeNull();
        if (!(p!.stdout instanceof ReadableStream)) throw new Error("expected a piped stdout");
        const out = await new Response(p!.stdout).text();
        expect(await p!.exited).toBe(0);
        expect(out.trim()).toBe("stubbed");
      } finally {
        process.env.PATH = oldPath;
      }
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet();
    }
  });
});
