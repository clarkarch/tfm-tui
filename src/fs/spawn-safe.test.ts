import { describe, expect, test } from "bun:test";
import { spawnSafe } from "./spawn-safe";

// spawn() of a missing binary does not throw synchronously — it fires an
// async uncaughtException ("Executable not found in $PATH") that the crash
// handler turns into exit(1). spawnSafe must swallow that via a listener
// armed at spawn time, or opening a file on a system without xdg-open kills
// the whole TUI.

const until = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await Bun.sleep(5);
  }
  return true;
};

describe("spawnSafe", () => {
  test("missing binary reports through onFail instead of an uncaughtException", async () => {
    const errs: Error[] = [];
    spawnSafe("tfm-no-such-binary-xyz", [], { stdio: "ignore" }, (e) => errs.push(e));
    // poll the observable: the error event must arrive, and the test process
    // must still be alive to observe it (a bare spawn would have exited us)
    expect(await until(() => errs.length > 0)).toBe(true);
    expect(errs[0]).toBeInstanceOf(Error);
  });

  test("existing binary still runs and exits cleanly", async () => {
    const p = spawnSafe(process.execPath, ["--version"]);
    const code: number = await new Promise((res) => p.on("exit", (c) => res(c ?? -1)));
    expect(code).toBe(0);
  });

  test("piped stdin still works (clipboard tool shape)", async () => {
    // wl-copy/xclip publish via stdin — the helper must not disturb the pipe
    const p = spawnSafe(process.execPath, ["-e", "const b = await Bun.stdin.text(); process.stdout.write(b)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    p.stdin?.end("payload");
    let out = "";
    p.stdout?.on("data", (c: Buffer) => (out += String(c)));
    const code: number = await new Promise((res) => p.on("exit", (c) => res(c ?? -1)));
    expect(code).toBe(0);
    expect(out).toBe("payload");
  });
});
