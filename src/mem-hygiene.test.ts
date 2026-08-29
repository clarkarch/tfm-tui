import { describe, expect, test } from "bun:test";
import { nativeMemLine, startMemHygiene } from "./mem-hygiene";

describe("nativeMemLine", () => {
  test("formats allocator stats + rss", () => {
    const line = nativeMemLine({ activeAllocations: 1234, totalRequestedBytes: 52 * 1048576 });
    expect(line).toContain("native active=1234");
    expect(line).toContain("mem=52.0MB");
    expect(line).toContain("rss=");
  });

  test("n/a when the private stats call is unavailable", () => {
    const line = nativeMemLine(null);
    expect(line).toContain("n/a");
    expect(line).toContain("rss=");
  });
});

describe("startMemHygiene", () => {
  test("heartbeats on the interval and stop() ends it", async () => {
    const lines: string[] = [];
    let statsReads = 0;
    const stop = startMemHygiene({
      allocatorStats: () => { statsReads++; return { activeAllocations: 7, totalRequestedBytes: 0 }; },
      debugLog: (msg) => lines.push(msg),
      intervalMs: 15,
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    const afterStop = lines.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(statsReads).toBeGreaterThan(0);
    expect(lines.length).toBe(afterStop);
    expect(lines[0]).toMatch(/^mem native active=7/);
  });

  test("no debugLog -> no per-tick work beyond the gc poke", async () => {
    let reads = 0;
    const stop = startMemHygiene({ allocatorStats: () => { reads++; return null; }, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 35));
    stop();
    expect(reads).toBe(0);
  });
});
