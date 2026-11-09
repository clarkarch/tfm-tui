import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, type CliRenderer } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeTopbarAnim, type TopbarAnimOpts } from "./ui-sidebar-anim";
import type { Scheduler } from "../lib/uiutil";

// virtual clock: the start gate + the intro's safety net are timing units —
// no wall-clock sleeps
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

const opts = (over: Partial<TopbarAnimOpts> = {}): TopbarAnimOpts => ({
  enabled: true,
  style: "fade",
  ms: 120,
  slideCells: 8,
  dir: "down",
  staggerPct: 40,
  ease: "ease-out",
  ...over,
});

// fake-node factory: plain objects are enough for the synchronous paths
// (staging/stop never touch the engine timeline)
const fakeNodes = () => {
  const map = new Map<string, any>();
  return {
    byId: (id: string) => map.get(id) ?? null,
    add: (id: string) => {
      const n = { opacity: 1, translateX: 0, translateY: 0 };
      map.set(id, n);
      return n;
    },
  };
};

const fakeCtx = (o: TopbarAnimOpts, entries: string[], sched?: Scheduler) => {
  const nodes = fakeNodes();
  for (const b of entries) nodes.add(b);
  const anim = makeTopbarAnim({
    renderer: {} as unknown as CliRenderer,
    byId: nodes.byId,
    opts: () => o,
    barIds: () => entries,
    sched,
  });
  return { anim, byId: nodes.byId };
};

describe("makeTopbarAnim (synchronous paths)", () => {
  test("fade stages all entries transparent at frame 0, stop settles them to rest", () => {
    const { anim, byId } = fakeCtx(opts({ style: "fade" }), ["tb-0", "tb-1"]);
    anim.play();
    expect((byId("tb-0") as any).opacity).toBe(0);
    expect((byId("tb-1") as any).opacity).toBe(0);
    anim.stop();
    expect((byId("tb-0") as any).opacity).toBe(1);
    expect((byId("tb-1") as any).opacity).toBe(1);
    expect((byId("tb-0") as any).translateY).toBe(0);
    expect((byId("tb-1") as any).translateY).toBe(0);
  });

  test("slide moves all entries in sync from above (down = from -Y)", () => {
    const { anim, byId } = fakeCtx(opts({ style: "slide", slideCells: 8, dir: "down" }), ["tb-0", "tb-1"]);
    anim.play();
    expect((byId("tb-0") as any).opacity).toBe(0);
    expect((byId("tb-0") as any).translateY).toBe(-8);
    // slide is one wave: all entries share the offset, never staggered
    expect((byId("tb-1") as any).translateY).toBe(-8);
    expect((byId("tb-1") as any).translateX).toBe(0);
    anim.stop();
    expect((byId("tb-0") as any).translateY).toBe(0);
    expect((byId("tb-1") as any).translateY).toBe(0);
  });

  test("disabled leaves the nodes alone (cold boot stays instant)", () => {
    const { anim, byId } = fakeCtx(opts({ enabled: false }), ["tb-off-0", "tb-off-1"]);
    anim.play();
    expect((byId("tb-off-0") as any).opacity).toBe(1);
    expect((byId("tb-off-1") as any).opacity).toBe(1);
    anim.stop();
  });

  test("ms <= 0 leaves the nodes alone", () => {
    const { anim, byId } = fakeCtx(opts({ ms: 0 }), ["tb-instant-0", "tb-instant-1"]);
    anim.play();
    expect((byId("tb-instant-0") as any).opacity).toBe(1);
    anim.stop();
  });

  test("unknown style falls back to fade (no offset)", () => {
    const { anim, byId } = fakeCtx(opts({ style: "bogus" }), ["tb-fb-0", "tb-fb-1"]);
    anim.play();
    expect((byId("tb-fb-0") as any).opacity).toBe(0);
    expect((byId("tb-fb-0") as any).translateY).toBe(0);
    expect((byId("tb-fb-1") as any).opacity).toBe(0);
    anim.stop();
  });

  test("a missing id never throws (animates the entry that exists)", () => {
    const nodes = fakeNodes();
    nodes.add("tb-one");
    const anim = makeTopbarAnim({
      renderer: {} as unknown as CliRenderer,
      byId: nodes.byId,
      opts: () => opts({ style: "fade" }),
      barIds: () => ["tb-one", "tb-absent"],
    });
    anim.play();
    expect((nodes.byId("tb-one") as any).opacity).toBe(0);
    anim.stop();
    expect((nodes.byId("tb-one") as any).opacity).toBe(1);
  });

  test("playIds stages ONLY the listed nodes (shared prefix stays put)", () => {
    const nodes = fakeNodes();
    nodes.add("tb-c0");
    nodes.add("tb-c1");
    nodes.add("tb-c2");
    const anim = makeTopbarAnim({
      renderer: {} as unknown as CliRenderer,
      byId: nodes.byId,
      opts: () => opts({ style: "stagger" }),
      barIds: () => ["tb-c0", "tb-c1", "tb-c2"],
    });
    anim.playIds(["tb-c2"]);
    expect((nodes.byId("tb-c0") as any).opacity).toBe(1);
    expect((nodes.byId("tb-c1") as any).opacity).toBe(1);
    expect((nodes.byId("tb-c2") as any).opacity).toBe(0);
    anim.stop();
    expect((nodes.byId("tb-c2") as any).opacity).toBe(1);
  });

  test("playIds with an empty list is a silent no-op (going up animates nothing)", () => {
    const nodes = fakeNodes();
    nodes.add("tb-n0");
    const anim = makeTopbarAnim({
      renderer: {} as unknown as CliRenderer,
      byId: nodes.byId,
      opts: () => opts({ style: "stagger" }),
      barIds: () => ["tb-n0"],
    });
    anim.playIds([]);
    expect((nodes.byId("tb-n0") as any).opacity).toBe(1);
    anim.stop();
  });

  test("playIds honors the master switch like play()", () => {
    const nodes = fakeNodes();
    nodes.add("tb-d0");
    const anim = makeTopbarAnim({
      renderer: {} as unknown as CliRenderer,
      byId: nodes.byId,
      opts: () => opts({ enabled: false }),
      barIds: () => ["tb-d0"],
    });
    anim.playIds(["tb-d0"]);
    expect((nodes.byId("tb-d0") as any).opacity).toBe(1);
    anim.stop();
  });

  test("a staged intro that never starts restores full opacity", () => {
    // the intro stages frame 0 (opacity 0) BEFORE anything guarantees a
    // start: if the start gate passes but the engine never ticks (a dead
    // renderer, a terminal that never presents a frame), the top bar must
    // not stay INVISIBLE — the intro is settled instead. The topbar runs the
    // SAME machine as the sidebar, so it inherits the safety net.
    const clock = makeClock();
    const { anim, byId } = fakeCtx(opts({ style: "fade" }), ["tb-never-0", "tb-never-1"], clock);
    try {
      anim.play();
      expect((byId("tb-never-0") as any).opacity).toBe(0); // staged
      expect((byId("tb-never-1") as any).opacity).toBe(0);
      // the start gate passes, the engine never advances
      clock.advance(2000);
      expect((byId("tb-never-0") as any).opacity).toBe(1); // restored to rest
      expect((byId("tb-never-1") as any).opacity).toBe(1);
      expect((byId("tb-never-0") as any).translateY).toBe(0);
    } finally {
      anim.stop();
    }
  });

  test("the phase names the intro's state (idle → armed → running → idle)", () => {
    const clock = makeClock();
    const { anim } = fakeCtx(opts({ style: "fade" }), ["tb-phase-0"], clock);
    try {
      expect(anim.phase()).toBe("idle");
      anim.play();
      expect(anim.phase()).toBe("armed"); // the start gate is pending
      clock.advance(100); // the fallback consumes the gate
      expect(anim.phase()).toBe("running");
      clock.advance(1000); // the safety net settles an intro that never advances
      expect(anim.phase()).toBe("idle");
    } finally {
      anim.stop();
    }
  });
});

// real engine glue: the timeline starts after the frame gate and settles every
// entry back to rest
describe("makeTopbarAnim (engine)", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 60, height: 20 });
    await t.renderOnce();
  });
  afterAll(() => t.dispose()); // 0.6.0: destroy + await closed

  const settleUntil = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(5);
      await t.renderOnce();
      if (cond()) return;
    }
    throw new Error("settleUntil timed out");
  };

  test("fade animates all entries to rest", async () => {
    t.renderer.root.add(Box({ id: "tb-e-0", width: 20, height: 1 }));
    t.renderer.root.add(Box({ id: "tb-e-1", width: 20, height: 1 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeTopbarAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", ms: 60 }),
      barIds: () => ["tb-e-0", "tb-e-1"],
    });
    anim.play();
    try {
      await settleUntil(() => (byId("tb-e-0") as any)?.opacity === 1 && (byId("tb-e-1") as any)?.opacity === 1);
      expect((byId("tb-e-0") as any).translateY).toBe(0);
      expect((byId("tb-e-1") as any).translateY).toBe(0);
    } finally {
      anim.stop();
    }
  });
});
