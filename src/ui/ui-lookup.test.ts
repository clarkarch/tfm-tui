import { describe, expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import {
  makeLookup,
  makeResolutionGate,
  RESOLUTION_POLL_MS,
  RESOLUTION_RENDER_MS,
  RESOLUTION_SETTLE_MS,
} from "./ui-lookup";

// fake renderable tree: nodes expose getChildren() like the real renderer
const leaf = (id: string, extra: any = {}): any => ({
  id,
  children: [],
  getChildren() {
    return this.children;
  },
  ...extra,
});
const branch = (id: string | undefined, ...children: any[]): any => ({
  id,
  children,
  getChildren() {
    return this.children;
  },
});

const find = (node: any, id: string): any => {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
};

// fake root: like the real renderer.root it IS a renderable (getChildren)
// that also carries findDescendantById
const mkRoot = (tree: any): any => ({
  ...tree,
  findDescendantById: (id: string) => find(tree, id),
});

describe("makeLookup", () => {
  test("byId finds nested nodes post-mount", () => {
    const tree = branch(undefined, branch("tfm-panel", leaf("tfm-label")));
    const { byId } = makeLookup({ root: () => mkRoot(tree) });
    expect(byId("tfm-label")?.id).toBe("tfm-label");
  });

  test("byId tolerates a miss (nodes die on every rebuild)", () => {
    const tree = branch(undefined);
    const { byId } = makeLookup({ root: () => mkRoot(tree) });
    expect(byId("nope")).toBeNull();
  });

  test("byId survives a throwing root (pre-mount)", () => {
    const { byId } = makeLookup({
      root: () => {
        throw new Error("not mounted");
      },
    });
    expect(byId("x")).toBeNull();
  });

  test("setTextOnId writes text content on the node", () => {
    const label = leaf("tfm-status-label", { content: "old" });
    const tree = branch(undefined, label);
    const { setTextOnId } = makeLookup({ root: () => mkRoot(tree) });
    setTextOnId("tfm-status-label", "hello");
    expect(label.content).toBe("hello");
  });

  test("setTextOnId no-ops on a missing node", () => {
    const tree = branch(undefined);
    const { setTextOnId } = makeLookup({ root: () => mkRoot(tree) });
    expect(() => setTextOnId("ghost", "x")).not.toThrow();
  });

  test("setOnId applies a mutation fn; missing node skips it", () => {
    const box = leaf("tfm-x", { visible: false });
    const tree = branch(undefined, box);
    const { setOnId } = makeLookup({ root: () => mkRoot(tree) });
    const seen: any[] = [];
    setOnId("tfm-x", (n: any) => {
      seen.push(n);
      n.visible = true;
    });
    setOnId("ghost", (n: any) => {
      seen.push(n);
    });
    expect(seen.length).toBe(1);
    expect(box.visible).toBe(true);
  });

  test("stripSelectable clears selectable on the whole subtree", () => {
    const a = leaf("a", { selectable: true });
    const b = leaf("b", { selectable: false });
    const tree = branch("root", a, b);
    const { stripSelectable } = makeLookup({ root: () => mkRoot(tree) });
    stripSelectable();
    expect(a.selectable).toBe(false);
    expect(b.selectable).toBe(false);
  });

  test("stripSelectable starts from an explicit node and skips destroyed", () => {
    const child = leaf("c", { selectable: true });
    const other = leaf("o", { selectable: true });
    const subtree = branch("sub", child);
    const tree = branch("root", subtree, other);
    const { stripSelectable } = makeLookup({ root: () => mkRoot(tree) });
    stripSelectable(subtree);
    expect(child.selectable).toBe(false);
    expect(other.selectable).toBe(true);
    const destroyed: any = { isDestroyed: true, selectable: true, children: [leaf("d", { selectable: true })] };
    expect(() => stripSelectable(destroyed)).not.toThrow();
    expect(destroyed.children[0].selectable).toBe(true);
  });
});

// virtual clock: the gate's whole point is that it must NOT hard-sleep real
// milliseconds on the render path, so its budget is observed through this
// (bun:test has no fake timers — same injected-clock rule as uiutil.debounced)
const mkClock = () => {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    slept,
    now: (): number => t,
    sleep: async (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
    },
  };
};

// a resolution the test can flip mid-park, like a late terminal reply
const mkRenderer = (get: () => { width: number; height: number } | null): CliRenderer =>
  ({
    get resolution() {
      return get();
    },
  }) as unknown as CliRenderer;

describe("makeResolutionGate", () => {
  test("settle returns without sleeping when the terminal already reported pixels", async () => {
    const clock = mkClock();
    const logs: string[] = [];
    const gate = makeResolutionGate(() => mkRenderer(() => ({ width: 800, height: 480 })), {
      sleep: clock.sleep,
      now: clock.now,
      log: (m) => logs.push(m),
    });
    await gate.settle();
    expect(clock.slept).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("settle latches after the full budget and logs why", async () => {
    // the console/tmux case: no reply ever comes. The 2s boot budget is spent
    // ONCE, then the render path must never park again.
    const clock = mkClock();
    const logs: string[] = [];
    const gate = makeResolutionGate(() => mkRenderer(() => null), {
      sleep: clock.sleep,
      now: clock.now,
      log: (m) => logs.push(m),
    });
    await gate.settle();
    expect(clock.slept.length).toBe(RESOLUTION_SETTLE_MS / RESOLUTION_POLL_MS);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain(`none after ${RESOLUTION_SETTLE_MS}ms`);

    // latched: the render path is free, and a second settle is a no-op
    const before = clock.slept.length;
    await gate.wait();
    await gate.settle();
    expect(clock.slept.length).toBe(before);
  });

  test("a rasterless terminal (tty mode / force-glyph) never parks at all", async () => {
    // no rasters means cell pixels are never read: waiting on them is pure
    // startup/navigation delay for data nothing consumes (the console's
    // leftover 2s boot stall)
    const clock = mkClock();
    const logs: string[] = [];
    const gate = makeResolutionGate(() => mkRenderer(() => null), {
      sleep: clock.sleep,
      now: clock.now,
      log: (m) => logs.push(m),
      rasterless: () => true,
    });
    await gate.settle();
    await gate.wait();
    expect(clock.slept).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("skipped");
  });

  test("the render-path wait parks its short budget without latching", async () => {
    // a terminal that DOES report pixels: a resize nulls the resolution for
    // its requery, so the rebuild that follows waits — bounded, and it must not
    // latch (the next resize would then never be waited for)
    const clock = mkClock();
    const gate = makeResolutionGate(() => mkRenderer(() => null), { sleep: clock.sleep, now: clock.now });
    await gate.wait();
    expect(clock.slept.length).toBe(RESOLUTION_RENDER_MS / RESOLUTION_POLL_MS);
    await gate.wait();
    expect(clock.slept.length).toBe((2 * RESOLUTION_RENDER_MS) / RESOLUTION_POLL_MS);
    // not latched: the boot settle still spends its own full budget
    await gate.settle();
    expect(clock.slept.length).toBe((2 * RESOLUTION_RENDER_MS + RESOLUTION_SETTLE_MS) / RESOLUTION_POLL_MS);
  });

  test("wait returns as soon as a late reply lands mid-park", async () => {
    const clock = mkClock();
    let polls = 0;
    const gate = makeResolutionGate(
      () =>
        mkRenderer(() => {
          polls++;
          return polls <= 3 ? null : { width: 640, height: 400 };
        }),
      { sleep: clock.sleep, now: clock.now },
    );
    await gate.wait();
    // the first read is wait()'s own early-out check, then one sleep per
    // unanswered park read — the reply lands on the third read and ends it
    expect(clock.slept.length).toBe(2);
    expect(clock.slept.length).toBeLessThan(RESOLUTION_RENDER_MS / RESOLUTION_POLL_MS);
  });
});
