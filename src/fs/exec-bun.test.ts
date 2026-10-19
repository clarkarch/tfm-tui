import { describe, expect, test } from "bun:test";
import { execBun } from "./exec-bun";

// Bun.spawn-backed execFile replacement (measured ~2.7x faster than
// promisified execFile on small outputs). Contract mirrors runArchiveTool:
// never throws for spawn failures — a missing binary resolves code -1 — and
// a timeout SIGKILLs (SIGCONT first) and resolves code -1 like any failure.

describe("execBun", () => {
  test("captures stdout and resolves code 0", async () => {
    const res = await execBun("echo", ["hi"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });

  test("non-zero exits resolve with their code, not a throw", async () => {
    const res = await execBun("sh", ["-c", "exit 3"]);
    expect(res.code).toBe(3);
  });

  test("a missing binary resolves code -1 instead of throwing", async () => {
    const res = await execBun("tfm-no-such-binary-xyz", []);
    expect(res.code).toBe(-1);
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  test("stderr is captured alongside stdout", async () => {
    const res = await execBun("sh", ["-c", "echo out; echo err >&2"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("out");
    expect(res.stderr.trim()).toBe("err");
  });

  test("timeoutMs kills a wedged helper instead of never resolving", async () => {
    const t0 = Date.now();
    const res = await execBun("sleep", ["30"], { timeoutMs: 100 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain("timed out");
  });
});
