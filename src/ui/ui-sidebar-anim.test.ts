import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, type CliRenderer } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeSidebarAnim, sidebarFrameAt, sidebarStyleFrom, type SidebarAnimOpts } from "./ui-sidebar-anim";

const opts = (over: Partial<SidebarAnimOpts> = {}): SidebarAnimOpts => ({
  enabled: true,
  style: "fade",
  ms: 120,
  slideCells: 8,
  dir: "left",
  staggerPct: 40,
  ease: "ease-out",
  includeTitle: false,
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

const fakeCtx = (o: SidebarAnimOpts, ids: { root: string; rows: string[]; title?: string }) => {
  const nodes = fakeNodes();
  nodes.add(ids.root);
  for (const r of ids.rows) nodes.add(r);
  // titleId always resolves to *something*: absent titles point at a node that
  // was never added (byId null), exactly like a hidden title in production
  const titleId = ids.title ?? `${ids.root}-title`;
  if (ids.title) nodes.add(ids.title);
  const anim = makeSidebarAnim({
    renderer: {} as unknown as CliRenderer,
    byId: nodes.byId,
    opts: () => o,
    rootId: () => ids.root,
    rowIds: () => ids.rows,
    titleId: () => titleId,
  });
  return { anim, byId: nodes.byId };
};

describe("sidebarStyleFrom", () => {
  test("maps the four styles, unknown falls back to fade", () => {
    expect(sidebarStyleFrom("fade")).toBe("fade");
    expect(sidebarStyleFrom("slide")).toBe("slide");
    expect(sidebarStyleFrom("stagger")).toBe("stagger");
    expect(sidebarStyleFrom("stagger-slide")).toBe("stagger-slide");
    expect(sidebarStyleFrom("bogus")).toBe("fade");
    expect(sidebarStyleFrom(undefined)).toBe("fade");
  });
});

describe("sidebarFrameAt", () => {
  test("fade goes 0 → 1 with no offset", () => {
    expect(sidebarFrameAt("fade", 0, 0, 1, {})).toEqual({ opacity: 0, dx: 0, dy: 0 });
    expect(sidebarFrameAt("fade", 1, 0, 1, {})).toEqual({ opacity: 1, dx: 0, dy: 0 });
    expect(sidebarFrameAt("fade", 0.5, 0, 1, {}).dx).toBe(0);
  });

  test("slide starts off-screen by slideCells and lands at rest", () => {
    const start = sidebarFrameAt("slide", 0, 0, 1, { dist: 8, dir: "left" });
    expect(start.opacity).toBe(0);
    expect(start.dx).toBe(-8);
    expect(start.dy).toBe(0);
    expect(sidebarFrameAt("slide", 1, 0, 1, { dist: 8, dir: "left" })).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("slide right mirrors the offset", () => {
    expect(sidebarFrameAt("slide", 0, 0, 1, { dist: 8, dir: "right" }).dx).toBe(8);
  });

  test("stagger lags later rows behind earlier ones and never translates", () => {
    const n = 4;
    const first = sidebarFrameAt("stagger", 0.5, 0, n, { span: 0.4 });
    const last = sidebarFrameAt("stagger", 0.5, n - 1, n, { span: 0.4 });
    expect(first.opacity).toBeGreaterThan(last.opacity);
    expect(last.dx).toBe(0);
    expect(last.dy).toBe(0);
    expect(sidebarFrameAt("stagger", 1, n - 1, n, { span: 0.4 })).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("dist 0 turns slide into a plain fade", () => {
    expect(sidebarFrameAt("slide", 0, 0, 1, { dist: 0 })).toEqual({ opacity: 0, dx: 0, dy: 0 });
    expect(sidebarFrameAt("slide", 0.5, 0, 1, { dist: 0 }).dx).toBe(0);
  });

  test("stagger-slide staggers each row's own slide and fade (files-style)", () => {
    const n = 4;
    const cfg = { dist: 8, dir: "left" as const, span: 0.4 };
    const first = sidebarFrameAt("stagger-slide", 0.5, 0, n, cfg);
    const last = sidebarFrameAt("stagger-slide", 0.5, n - 1, n, cfg);
    expect(first.opacity).toBeGreaterThan(last.opacity);
    expect(first.dx).toBeGreaterThan(last.dx); // first has slid further home (closer to 0 from below)
    expect(sidebarFrameAt("stagger-slide", 0, 0, n, cfg)).toEqual({ opacity: 0, dx: -8, dy: 0 });
    expect(sidebarFrameAt("stagger-slide", 1, n - 1, n, cfg)).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });
});

describe("makeSidebarAnim (synchronous paths)", () => {
  test("play stages frame 0 synchronously (fade starts transparent)", () => {
    const { anim, byId } = fakeCtx(opts({ style: "fade" }), { root: "sb-root", rows: [] });
    anim.play();
    expect((byId("sb-root") as any).opacity).toBe(0);
    anim.stop();
    expect((byId("sb-root") as any).opacity).toBe(1);
  });

  test("disabled leaves the nodes alone (cold boot stays instant)", () => {
    const { anim, byId } = fakeCtx(opts({ enabled: false }), { root: "sb-off", rows: [] });
    anim.play();
    expect((byId("sb-off") as any).opacity).toBe(1);
    anim.stop();
  });

  test("ms <= 0 leaves the nodes alone", () => {
    const { anim, byId } = fakeCtx(opts({ ms: 0 }), { root: "sb-instant", rows: [] });
    anim.play();
    expect((byId("sb-instant") as any).opacity).toBe(1);
    anim.stop();
  });

  test("replay cancels the pending start and still settles to rest", () => {
    const { anim, byId } = fakeCtx(opts({ style: "fade" }), { root: "sb-replay", rows: [] });
    anim.play();
    anim.play();
    anim.stop();
    expect((byId("sb-replay") as any).opacity).toBe(1);
    expect((byId("sb-replay") as any).translateX).toBe(0);
  });

  test("includeTitle stages the title at frame 0 alongside the rows", () => {
    const { anim, byId } = fakeCtx(opts({ style: "stagger", includeTitle: true }), {
      root: "sb-t",
      rows: ["sb-t-0"],
      title: "sb-t-title",
    });
    anim.play();
    expect((byId("sb-t-title") as any).opacity).toBe(0);
    expect((byId("sb-t-0") as any).opacity).toBe(0);
    anim.stop();
    expect((byId("sb-t-title") as any).opacity).toBe(1);
  });

  test("without includeTitle the title node is never touched", () => {
    const { anim, byId } = fakeCtx(opts({ style: "stagger" }), {
      root: "sb-nt",
      rows: ["sb-nt-0"],
      title: "sb-nt-title",
    });
    anim.play();
    expect((byId("sb-nt-title") as any).opacity).toBe(1);
    expect((byId("sb-nt-0") as any).opacity).toBe(0);
    anim.stop();
  });
});

// real engine glue: the timeline starts after the frame gate and settles every
// node back to rest (the per-frame writes to freshly built nodes are the part
// a sync test can't cover)
describe("makeSidebarAnim (engine)", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 60, height: 20 });
    await t.renderOnce();
  });
  afterAll(() => t.renderer.destroy());

  const settleUntil = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(5);
      await t.renderOnce();
      if (cond()) return;
    }
    throw new Error("settleUntil timed out");
  };

  test("fade animates the sidebar root to rest", async () => {
    t.renderer.root.add(Box({ id: "sb-fade", width: 20, height: 10 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeSidebarAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", ms: 60 }),
      rootId: () => "sb-fade",
      rowIds: () => [],
      titleId: () => "sb-fade-title",
    });
    anim.play();
    try {
      await settleUntil(() => (byId("sb-fade") as any)?.opacity === 1);
      expect((byId("sb-fade") as any).translateX).toBe(0);
      expect((byId("sb-fade") as any).translateY).toBe(0);
    } finally {
      anim.stop();
    }
  });

  test("slide moves the root on whole cells, then snaps back", async () => {
    t.renderer.root.add(Box({ id: "sb-slide", width: 20, height: 10 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeSidebarAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "slide", ms: 120, slideCells: 10, dir: "left" }),
      rootId: () => "sb-slide",
      rowIds: () => [],
      titleId: () => "sb-slide-title",
    });
    anim.play();
    try {
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(5);
        await t.renderOnce();
        expect(Number.isInteger((byId("sb-slide") as any).translateX)).toBe(true);
        expect((byId("sb-slide") as any).translateY).toBe(0);
      }
      await settleUntil(() => (byId("sb-slide") as any)?.opacity === 1);
      expect((byId("sb-slide") as any).translateX).toBe(0);
    } finally {
      anim.stop();
    }
  });

  test("stagger cascades the rows and never translates them", async () => {
    const ids = ["sb-row-0", "sb-row-1", "sb-row-2", "sb-row-3"];
    const lastId = ids[3]!;
    for (const id of ids) t.renderer.root.add(Box({ id, width: 20, height: 1 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeSidebarAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", ms: 120 }),
      rootId: () => "sb-stagger-root",
      rowIds: () => ids,
      titleId: () => "sb-stagger-title",
    });
    anim.play();
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(5);
        await t.renderOnce();
        seen.add(ids.map((id) => (byId(id) as any).opacity).join(","));
        for (const id of ids) {
          expect((byId(id) as any).translateX).toBe(0);
          expect((byId(id) as any).translateY).toBe(0);
        }
        if ((byId(lastId) as any).opacity === 1) break;
      }
      // cascade: not every frame had all rows at the same opacity
      expect(seen.size).toBeGreaterThan(1);
      for (const id of ids) expect((byId(id) as any).opacity).toBe(1);
    } finally {
      anim.stop();
    }
  });

  test("stagger-slide slides each row home on whole cells while cascading", async () => {
    const ids = ["sb-ss-0", "sb-ss-1", "sb-ss-2", "sb-ss-3"];
    const lastId = ids[3]!;
    for (const id of ids) t.renderer.root.add(Box({ id, width: 20, height: 1 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeSidebarAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger-slide", ms: 120, slideCells: 8, dir: "left" }),
      rootId: () => "sb-ss-root",
      rowIds: () => ids,
      titleId: () => "sb-ss-title",
    });
    anim.play();
    try {
      let diverged = false;
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(5);
        await t.renderOnce();
        const xs = ids.map((id) => (byId(id) as any).translateX);
        for (const x of xs) expect(Number.isInteger(x)).toBe(true);
        for (const id of ids) expect((byId(id) as any).translateY).toBe(0);
        // cascade: the first row is further home (closer to 0) than the last
        if (xs[0]! > xs[3]!) diverged = true;
        if ((byId(lastId) as any).opacity === 1) break;
      }
      expect(diverged).toBe(true);
      await settleUntil(() => (byId(lastId) as any)?.opacity === 1);
      for (const id of ids) {
        expect((byId(id) as any).opacity).toBe(1);
        expect((byId(id) as any).translateX).toBe(0);
      }
    } finally {
      anim.stop();
    }
  });

  test("includeTitle puts the title first in the cascade", async () => {
    const titleId = "sb-ti-title";
    const ids = ["sb-ti-0", "sb-ti-1", "sb-ti-2"];
    const lastId = ids[2]!;
    t.renderer.root.add(Box({ id: titleId, width: 20, height: 5 }));
    for (const id of ids) t.renderer.root.add(Box({ id, width: 20, height: 1 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeSidebarAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", ms: 250, includeTitle: true }),
      rootId: () => "sb-ti-root",
      rowIds: () => ids,
      titleId: () => titleId,
    });
    anim.play();
    try {
      // the title (index 0) finishes while the last row is still cascading in
      let titleFirst = false;
      for (let i = 0; i < 80; i++) {
        await Bun.sleep(5);
        await t.renderOnce();
        if ((byId(titleId) as any).opacity === 1 && (byId(lastId) as any).opacity < 1) {
          titleFirst = true;
          break;
        }
        if ((byId(lastId) as any).opacity === 1) break;
      }
      expect(titleFirst).toBe(true);
      await settleUntil(() => (byId(lastId) as any)?.opacity === 1);
      expect((byId(titleId) as any).opacity).toBe(1);
    } finally {
      anim.stop();
    }
  });
});
