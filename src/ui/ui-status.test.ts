import { describe, expect, test } from "bun:test";
import { makeStatus } from "./ui-status";

// virtual clock: the reclaim debounce is a timing unit — no wall-clock sleeps
const makeClock = () => {
  const jobs: { at: number; fn: () => void }[] = [];
  let now = 0;
  return {
    setTimeout(cb: () => void, ms: number): unknown {
      const job = { at: now + ms, fn: cb };
      jobs.push(job);
      return job;
    },
    clearTimeout(handle: unknown): void {
      const i = jobs.indexOf(handle as { at: number; fn: () => void });
      if (i >= 0) jobs.splice(i, 1);
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        jobs.sort((a, b) => a.at - b.at);
        const next = jobs[0];
        if (!next || next.at > end) break;
        now = next.at;
        jobs.shift()!.fn();
      }
      now = end;
    },
  };
};

const mkEnv = (resetDelayMs = 30) => {
  const nodes: Record<string, { content: string }> = { "tfm-status-label": { content: "" } };
  let refreshes = 0;
  const clock = makeClock();
  const { setStatusMsg } = makeStatus({
    byId: (id) => nodes[id],
    refresh: () => {
      refreshes++;
    },
    resetDelayMs,
    sched: clock,
  });
  return { nodes, setStatusMsg, refreshCount: () => refreshes, clock };
};

describe("makeStatus", () => {
  test("writes to the status label node", () => {
    const { nodes, setStatusMsg } = mkEnv();
    setStatusMsg("Copied 3 items");
    expect(nodes["tfm-status-label"]!.content).toBe("Copied 3 items");
  });

  test("a missing node is tolerated (rebuilds kill nodes constantly)", () => {
    const { setStatusMsg } = makeStatus({ byId: () => null, refresh: () => {}, resetDelayMs: 5, sched: makeClock() });
    expect(() => setStatusMsg("x")).not.toThrow();
  });

  test("the selection-summary refresh reclaims the bar after the quiet period", () => {
    const { setStatusMsg, refreshCount, clock } = mkEnv(30);
    setStatusMsg("transient");
    clock.advance(10);
    expect(refreshCount()).toBe(0);
    clock.advance(30);
    expect(refreshCount()).toBe(1);
  });

  test("rapid messages debounce: the reset fires once, after the LAST call", () => {
    const { setStatusMsg, refreshCount, clock } = mkEnv(40);
    setStatusMsg("a");
    clock.advance(15);
    setStatusMsg("b");
    clock.advance(15);
    setStatusMsg("c");
    expect(refreshCount()).toBe(0);
    clock.advance(80);
    expect(refreshCount()).toBe(1);
  });

  test("default reset delay is used when none is given", async () => {
    // no sched injected: exercises the real-clock default — the 2500ms
    // default cannot fire inside a 50ms window, a safe negative assert
    const nodes: Record<string, { content: string }> = { "tfm-status-label": { content: "" } };
    let refreshes = 0;
    const { setStatusMsg } = makeStatus({
      byId: (id) => nodes[id],
      refresh: () => {
        refreshes++;
      },
    });
    setStatusMsg("x");
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshes).toBe(0); // 2500ms default — must not have fired yet
  });
});
