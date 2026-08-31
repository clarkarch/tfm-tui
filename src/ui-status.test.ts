import { describe, expect, test } from "bun:test";
import { makeStatus } from "./ui-status";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mkEnv = (resetDelayMs = 30) => {
  const nodes: Record<string, { content: string }> = { "tfm-status-label": { content: "" } };
  let refreshes = 0;
  const { setStatusMsg } = makeStatus({
    byId: (id) => nodes[id],
    refresh: () => { refreshes++; },
    resetDelayMs,
  });
  return { nodes, setStatusMsg, refreshCount: () => refreshes };
};

describe("makeStatus", () => {
  test("writes to the status label node", () => {
    const { nodes, setStatusMsg } = mkEnv();
    setStatusMsg("Copied 3 items");
    expect(nodes["tfm-status-label"]!.content).toBe("Copied 3 items");
  });

  test("a missing node is tolerated (rebuilds kill nodes constantly)", () => {
    const { setStatusMsg } = makeStatus({ byId: () => null, refresh: () => {}, resetDelayMs: 5 });
    expect(() => setStatusMsg("x")).not.toThrow();
  });

  test("the selection-summary refresh reclaims the bar after the quiet period", async () => {
    const { setStatusMsg, refreshCount } = mkEnv(30);
    setStatusMsg("transient");
    await sleep(10);
    expect(refreshCount()).toBe(0);
    await sleep(60);
    expect(refreshCount()).toBe(1);
  });

  test("rapid messages debounce: the reset fires once, after the LAST call", async () => {
    const { setStatusMsg, refreshCount } = mkEnv(40);
    setStatusMsg("a");
    await sleep(15);
    setStatusMsg("b");
    await sleep(15);
    setStatusMsg("c");
    expect(refreshCount()).toBe(0);
    await sleep(80);
    expect(refreshCount()).toBe(1);
  });

  test("default reset delay is used when none is given", async () => {
    const nodes: Record<string, { content: string }> = { "tfm-status-label": { content: "" } };
    let refreshes = 0;
    const { setStatusMsg } = makeStatus({ byId: (id) => nodes[id], refresh: () => { refreshes++; } });
    setStatusMsg("x");
    await sleep(50);
    expect(refreshes).toBe(0); // 2500ms default — must not have fired yet
  });
});
