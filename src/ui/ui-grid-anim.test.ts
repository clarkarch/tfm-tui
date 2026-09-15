import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, engine, Text } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  easeAt,
  fileAnimAt,
  fileAnimStyleFrom,
  hoverLiftDelta,
  makeFileAnim,
  makeTileHoverAnim,
  MAX_PER_NODE_ANIM,
  quantizeDy,
  restTileBg,
  revealStyleMap,
  slideTravel,
} from "./ui-grid-anim";

const CFG = { dist: 6, span: 0.4, ease: "ease-out", dir: "up" } as const;

describe("quantizeDy", () => {
  test("keeps translateY on whole cells (fractional coords crash image draw)", () => {
    expect(quantizeDy(4.5)).toBe(5);
    expect(quantizeDy(-0.6)).toBe(-1);
    expect(quantizeDy(3)).toBe(3);
    expect(quantizeDy(Number.NaN)).toBe(0);
  });
});

describe("easeAt", () => {
  test("endpoints land exactly", () => {
    expect(easeAt("linear", 0)).toBe(0);
    expect(easeAt("linear", 1)).toBe(1);
    expect(easeAt("ease-out", 0)).toBe(0);
    expect(easeAt("ease-out", 1)).toBe(1);
    expect(easeAt("ease-in-out", 0)).toBe(0);
    expect(easeAt("ease-in-out", 1)).toBe(1);
  });

  test("ease-out leads, ease-in-out trails at mid (distinct curves)", () => {
    expect(easeAt("ease-out", 0.5)).toBeCloseTo(0.75, 5);
    expect(easeAt("ease-in-out", 0.5)).toBeCloseTo(0.5, 5);
    expect(easeAt("linear", 0.5)).toBeCloseTo(0.5, 5);
  });
});

describe("fileAnimStyleFrom", () => {
  test("derives the style from the toggles", () => {
    expect(fileAnimStyleFrom({ enabled: false, slide: true, stagger: true })).toBe("off");
    expect(fileAnimStyleFrom({ enabled: true, slide: false, stagger: false })).toBe("fade");
    expect(fileAnimStyleFrom({ enabled: true, slide: true, stagger: false })).toBe("slide");
    expect(fileAnimStyleFrom({ enabled: true, slide: false, stagger: true })).toBe("stagger");
    expect(fileAnimStyleFrom({ enabled: true, slide: true, stagger: true })).toBe("stagger-slide");
  });
});

describe("revealStyleMap", () => {
  test("slide maps to stagger-slide; the entry edge flips up/down; horizontal stays", () => {
    expect(revealStyleMap("slide", "up", "bottom")).toEqual({ style: "stagger-slide", dir: "up" });
    expect(revealStyleMap("slide", "up", "top")).toEqual({ style: "stagger-slide", dir: "down" });
    expect(revealStyleMap("fade", "up", "top")).toEqual({ style: "fade", dir: "down" });
    expect(revealStyleMap("stagger", "left", "bottom")).toEqual({ style: "stagger", dir: "left" });
  });
});

describe("slideTravel / smoothness", () => {
  test("travel scales with the viewport and stays in a sane range", () => {
    expect(slideTravel(51)).toBeGreaterThanOrEqual(20);
    expect(slideTravel(20)).toBeGreaterThanOrEqual(8);
    expect(slideTravel(0)).toBeGreaterThanOrEqual(8);
    expect(slideTravel(Number.NaN)).toBeGreaterThanOrEqual(8);
  });

  test("travel scales with slide-pct; 0 disables motion (fade in place)", () => {
    expect(slideTravel(51, 100)).toBeGreaterThanOrEqual(20);
    expect(slideTravel(51, 20)).toBeLessThan(slideTravel(51, 100));
    expect(slideTravel(51, 0)).toBe(0);
    expect(slideTravel(51, 150)).toBeGreaterThan(slideTravel(51, 100));
  });

  test("a slide produces many distinct integer positions (not ~4 jumps)", () => {
    const seen = new Set<number>();
    for (let p = 0; p <= 1.0001; p += 1 / 60) seen.add(quantizeDy(fileAnimAt("slide", p, 0, 1, { dist: 28 }).dy));
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});

describe("fileAnimAt", () => {
  test("off is fully opaque, no offset, at every progress", () => {
    expect(fileAnimAt("off", 0, 0, 5)).toEqual({ opacity: 1, dx: 0, dy: 0 });
    expect(fileAnimAt("off", 0.5, 3, 5)).toEqual({ opacity: 1, dx: 0, dy: 0 });
    expect(fileAnimAt("off", 1, 4, 5)).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("fade goes 0 → 1 with no vertical motion", () => {
    expect(fileAnimAt("fade", 0, 0, 1)).toEqual({ opacity: 0, dx: 0, dy: 0 });
    expect(fileAnimAt("fade", 1, 0, 1)).toEqual({ opacity: 1, dx: 0, dy: 0 });
    expect(fileAnimAt("fade", 0.5, 0, 1).opacity).toBeCloseTo(0.75, 5);
    expect(fileAnimAt("fade", 0.5, 0, 1).dy).toBe(0);
    expect(fileAnimAt("fade", 0.5, 0, 1).dx).toBe(0);
  });

  test("fade honors ease-in-out (mid is slower than ease-out)", () => {
    expect(fileAnimAt("fade", 0.5, 0, 1, { ease: "ease-in-out" }).opacity).toBeCloseTo(0.5, 5);
  });

  test("stagger lags later tiles behind earlier ones, no offset", () => {
    const n = 4;
    const first = fileAnimAt("stagger", 0.5, 0, n, CFG);
    const last = fileAnimAt("stagger", 0.5, n - 1, n, CFG);
    expect(first.opacity).toBeGreaterThan(last.opacity);
    expect(first.dy).toBe(0);
    expect(fileAnimAt("stagger", 1, n - 1, n, CFG)).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("stagger spread 0 = every tile at the same opacity", () => {
    const n = 4;
    expect(fileAnimAt("stagger", 0.5, 0, n, { span: 0 })).toEqual(fileAnimAt("stagger", 0.5, n - 1, n, { span: 0 }));
  });

  test("slide starts below and rises to rest", () => {
    const start = fileAnimAt("slide", 0, 0, 1, CFG);
    expect(start.opacity).toBe(0);
    expect(start.dy).toBe(6);
    expect(fileAnimAt("slide", 1, 0, 1, CFG)).toEqual({ opacity: 1, dx: 0, dy: 0 });
    // mid-flight the tile is still partway below its final spot
    const mid = fileAnimAt("slide", 0.5, 0, 1, CFG);
    expect(mid.dy).toBeGreaterThan(0);
    expect(mid.dy).toBeLessThan(6);
  });

  test("slide down mirrors the offset (files drop in from above)", () => {
    const start = fileAnimAt("slide", 0, 0, 1, { ...CFG, dir: "down" });
    expect(start.dy).toBe(-6);
    const mid = fileAnimAt("slide", 0.5, 0, 1, { ...CFG, dir: "down" });
    expect(mid.dy).toBeLessThan(0);
    expect(fileAnimAt("slide", 1, 0, 1, { ...CFG, dir: "down" })).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("slide right/left travel on X only, from the corresponding side", () => {
    const right = fileAnimAt("slide", 0, 0, 1, { ...CFG, dir: "right" });
    expect(right.dx).toBe(6);
    expect(right.dy).toBe(0);
    expect(fileAnimAt("slide", 0.5, 0, 1, { ...CFG, dir: "right" }).dx).toBeGreaterThan(0);
    expect(fileAnimAt("slide", 1, 0, 1, { ...CFG, dir: "right" })).toEqual({ opacity: 1, dx: 0, dy: 0 });

    const left = fileAnimAt("slide", 0, 0, 1, { ...CFG, dir: "left" });
    expect(left.dx).toBe(-6);
    expect(left.dy).toBe(0);
    expect(fileAnimAt("slide", 0.5, 0, 1, { ...CFG, dir: "left" }).dx).toBeLessThan(0);
    expect(fileAnimAt("slide", 1, 0, 1, { ...CFG, dir: "left" })).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("stagger-slide staggers each tile's own rise and fade", () => {
    const n = 4;
    const first = fileAnimAt("stagger-slide", 0.5, 0, n, CFG);
    const last = fileAnimAt("stagger-slide", 0.5, n - 1, n, CFG);
    expect(first.opacity).toBeGreaterThan(last.opacity);
    expect(first.dy).toBeLessThan(last.dy);
    expect(fileAnimAt("stagger-slide", 0, 0, n, CFG)).toEqual({ opacity: 0, dx: 0, dy: 6 });
    expect(fileAnimAt("stagger-slide", 1, n - 1, n, CFG)).toEqual({ opacity: 1, dx: 0, dy: 0 });
  });

  test("dist 0 turns slide/stagger-slide into a plain fade", () => {
    expect(fileAnimAt("slide", 0, 0, 1, { dist: 0 })).toEqual({ opacity: 0, dx: 0, dy: 0 });
    expect(fileAnimAt("slide", 0.5, 0, 1, { dist: 0 })).toEqual({ opacity: 0.75, dx: 0, dy: 0 });
    expect(fileAnimAt("stagger-slide", 0.5, 0, 2, { dist: 0, span: 0.4 }).dy).toBe(0);
  });
});

// real engine glue: slide targets ONLY the container, settles to rest, and
// stop() cancels cleanly (the per-frame writes to freshly built nodes are the
// part a pure-curve test can't cover)
describe("makeFileAnim (engine)", () => {
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

  const opts = (over: Partial<Parameters<typeof makeFileAnim>[0] extends { opts(): infer O } ? O : never> = {}) => ({
    style: "fade" as const,
    ms: 150,
    staggerPct: 40,
    slidePct: 70,
    dir: "up" as const,
    ease: "ease-out" as const,
    containerFade: false,
    rowsGranularity: true,
    maxFiles: 0,
    ...over,
  });

  test("slide animates the container only, then snaps it back to rest", async () => {
    t.renderer.root.add(Box({ id: "g-inner", width: 40, height: 8, flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "g-tile", width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({ renderer: t.renderer, byId, opts: () => opts({ style: "slide" }) });
    anim.play({ tiles: ["g-tile"], inner: "g-inner" });
    // the container moves; the individual tile node is NEVER touched by slide
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(5);
      await t.renderOnce();
      expect((byId("g-tile") as any).opacity).toBe(1);
      expect((byId("g-tile") as any).translateY).toBe(0);
      // container translate must stay on whole cells (image child coords)
      expect(Number.isInteger((byId("g-inner") as any).translateY)).toBe(true);
    }
    await settleUntil(() => (byId("g-inner") as any)?.opacity === 1);
    expect((byId("g-inner") as any).translateY).toBe(0);
  });

  test("a reveal play animates the entering rows, never the container", async () => {
    t.renderer.root.add(Box({ id: "rv-inner", width: 40, height: 8, flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "rv-row", width: 40, height: 6 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "slide", ms: 1000 }),
    });
    // bottom entry: plain slide maps to the stagger-slide curve and starts
    // BELOW the resting spot (dir "up") — on the ROW node, not the container
    anim.play({ tiles: ["rv-row"], rows: ["rv-row"], rowsTotal: 1, total: 1, inner: "rv-inner", enterFrom: "bottom" });
    engine.update(1);
    expect((byId("rv-inner") as any).translateY).toBe(0);
    expect((byId("rv-row") as any).translateY).toBeGreaterThan(0);
    anim.stop();
    expect((byId("rv-row") as any).translateY).toBe(0);
    // top entry: files drop in from above (dir "down")
    anim.play({ tiles: ["rv-row"], rows: ["rv-row"], rowsTotal: 1, total: 1, inner: "rv-inner", enterFrom: "top" });
    engine.update(1);
    expect((byId("rv-row") as any).translateY).toBeLessThan(0);
    anim.stop();
    // reveal + containerFade: the entering set fades ITSELF — a per-notch
    // whole-grid container fade would flash the entire viewport
    const cfade = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", containerFade: true, ms: 1000 }),
    });
    cfade.play({ tiles: ["rv-row"], rows: [], total: 1, inner: "rv-inner", enterFrom: "bottom" });
    engine.update(1);
    expect((byId("rv-inner") as any).opacity).toBe(1);
    expect((byId("rv-row") as any).opacity).toBeLessThan(1);
    cfade.stop();
    expect((byId("rv-row") as any).opacity).toBe(1);
    // master off (file-animation = false ⇒ style off): a reveal is a no-op stop
    const off = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "off", ms: 1000 }),
    });
    // master off (file-animation = false ⇒ style off): a reveal is a no-op
    // stop — and it must SAY so (null mode) so the grid releases staged rows
    expect(
      off.play({ tiles: ["rv-row"], rows: ["rv-row"], rowsTotal: 1, total: 1, inner: "rv-inner", enterFrom: "bottom" }),
    ).toBeNull();
    engine.update(1);
    expect((byId("rv-row") as any).opacity).toBe(1);
    expect((byId("rv-row") as any).translateY).toBe(0);
  });

  test("a second reveal play APPENDS to the running wave (no mid-fade snap)", async () => {
    t.renderer.root.add(Box({ id: "ap-a", width: 40, height: 6 }));
    t.renderer.root.add(Box({ id: "ap-b", width: 40, height: 6 }));
    t.renderer.root.add(Box({ id: "ap-c", width: 40, height: 6 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", ms: 1000 }),
    });
    anim.play({ tiles: ["ap-a"], total: 1 });
    engine.update(500);
    const a1 = (byId("ap-a") as any).opacity;
    anim.play({ tiles: ["ap-b"], total: 1, enterFrom: "bottom" });
    engine.update(100);
    const a2 = (byId("ap-a") as any).opacity;
    // the in-flight node PROGRESSION continued (1 would mean the second play
    // snapped it; anything below a1 would mean it rewound)
    expect(a2).toBeGreaterThan(a1);
    expect(a2).toBeLessThan(1);
    // the new node joined at the back of the cascade (and frame 0 was staged
    // synchronically — no first frame at full opacity)
    expect((byId("ap-b") as any).opacity).toBeLessThan(1);
    // a direction flip is irrelevant to a style with no offsets: still one wave
    anim.play({ tiles: ["ap-c"], total: 1, enterFrom: "top" });
    engine.update(50);
    const a3 = (byId("ap-a") as any).opacity;
    expect(a3).toBeGreaterThan(a2);
    expect(a3).toBeLessThan(1);
    engine.update(2000);
    expect([byId("ap-a"), byId("ap-b"), byId("ap-c")].map((n) => (n as any).opacity)).toEqual([1, 1, 1]);
    anim.stop();
  });

  test("a slide-direction reversal settles the old stagger-slide wave before restarting", async () => {
    t.renderer.root.add(Box({ id: "rs-a", width: 40, height: 6 }));
    t.renderer.root.add(Box({ id: "rs-b", width: 40, height: 6 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger-slide", ms: 1000 }),
    });
    anim.play({ tiles: ["rs-a"], total: 1, enterFrom: "bottom" }); // rises up
    engine.update(300);
    expect((byId("rs-a") as any).translateY).toBeGreaterThan(0);
    anim.play({ tiles: ["rs-b"], total: 1, enterFrom: "top" }); // reversal: fresh wave…
    expect((byId("rs-a") as any).translateY).toBe(0); // …old node settled, not stranded mid-slide
    engine.update(2000);
    expect((byId("rs-b") as any).opacity).toBe(1);
    anim.stop();
  });

  test("reveal honors row-granularity: rows on, per-file tiles off; play returns the driven mode", async () => {
    // syncWindow pre-stages ROW nodes at frame-0 opacity for a deferred
    // reveal and reconciles with the mode play() RETURNS: rows-mode keeps
    // the staged rows, anything else releases them (a row at opacity 0
    // hides per-file children regardless). Break the useRows knob gate or
    // the return value and THIS goes red.
    t.renderer.root.add(Box({ id: "sr-row", width: 40, height: 6 }));
    t.renderer.root.add(Box({ id: "sr-tile-a", width: 8, height: 5 }));
    t.renderer.root.add(Box({ id: "sr-tile-b", width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const target = {
      tiles: ["sr-tile-a", "sr-tile-b"],
      rows: ["sr-row"],
      rowsTotal: 1,
      total: 2,
      enterFrom: "bottom" as const,
    };
    const rowsGran = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", rowsGranularity: true, ms: 1000 }),
    });
    expect(rowsGran.play(target)).toBe("rows");
    engine.update(500);
    expect((byId("sr-row") as any).opacity).toBeLessThan(1); // the ROW carries the wave…
    expect((byId("sr-tile-a") as any).opacity).toBe(1); // …tiles untouched
    rowsGran.stop();
    expect((byId("sr-row") as any).opacity).toBe(1);
    // knob OFF: the cascade runs per FILE across the entering tiles
    const perFile = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", rowsGranularity: false, ms: 1000 }),
    });
    expect(perFile.play(target)).toBe("tiles");
    engine.update(500);
    const oa = (byId("sr-tile-a") as any).opacity;
    const ob = (byId("sr-tile-b") as any).opacity;
    expect((byId("sr-row") as any).opacity).toBe(1); // row NEVER animates here
    expect(oa).toBeLessThan(1);
    expect(ob).toBeLessThan(1);
    expect(oa).toBeGreaterThan(ob); // own cascade slots, in order
    perFile.stop();
    expect([byId("sr-tile-a"), byId("sr-tile-b")].map((n) => (n as any).opacity)).toEqual([1, 1]);
  });

  test("containerFade fades the container and never touches the tiles", async () => {
    t.renderer.root.add(Box({ id: "gcf-inner", width: 40, height: 8, flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "gcf-tile", width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", containerFade: true, ms: 1000 }),
    });
    anim.play({ tiles: ["gcf-tile"], inner: "gcf-inner" });
    // deterministic progress: no awaited frame between play and the tick
    engine.update(500);
    // the tile is untouched; the container carries the whole fade
    expect((byId("gcf-tile") as any).opacity).toBe(1);
    expect((byId("gcf-inner") as any).opacity).toBeCloseTo(fileAnimAt("fade", 0.5, 0, 1).opacity, 2);
    anim.stop();
    expect((byId("gcf-inner") as any).opacity).toBe(1);
  });

  test("without containerFade each tile fades itself and the container stays at rest", async () => {
    t.renderer.root.add(Box({ id: "gpf-inner", width: 40, height: 8, flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "gpf-tile", width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", containerFade: false, ms: 1000 }),
    });
    anim.play({ tiles: ["gpf-tile"], inner: "gpf-inner" });
    engine.update(500);
    expect((byId("gpf-tile") as any).opacity).toBeCloseTo(fileAnimAt("fade", 0.5, 0, 1).opacity, 2);
    expect((byId("gpf-inner") as any).opacity).toBe(1);
    anim.stop();
  });

  test("a capped (visible-only) node list keeps the FULL count's cascade timing", async () => {
    t.renderer.root.add(Box({ id: "gt-tile-a", width: 8, height: 5 }));
    t.renderer.root.add(Box({ id: "gt-tile-b", width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const mk = (total?: number) => {
      const anim = makeFileAnim({
        renderer: t.renderer,
        byId,
        opts: () => opts({ style: "stagger", ms: 1000, staggerPct: 40 }),
      });
      anim.play({ tiles: ["gt-tile-a", "gt-tile-b"], total });
      return anim;
    };
    // without total the animator assumes 2 files: the second node lags hard
    const a = mk();
    engine.update(500);
    const withoutTotal = (byId("gt-tile-b") as any).opacity;
    a.stop();
    // with total=10 the second node is near the front of a 10-file cascade
    const b = mk(10);
    engine.update(500);
    const withTotal = (byId("gt-tile-b") as any).opacity;
    const expected = fileAnimAt("stagger", 0.5, 1, 10, { span: 0.4, ease: "ease-out" }).opacity;
    b.stop();
    expect(withTotal).toBeGreaterThan(withoutTotal);
    expect(withTotal).toBeCloseTo(expected, 2);
  });

  // over the per-node ceiling with a container available, the animation
  // DEGRADES to the container fade instead of skipping (the old stop() made
  // huge folders "either lag or skip" — a one-node fade still animates and
  // costs one push per frame). Without a container there is nothing cheap to
  // degrade to, so it still snaps to rest (defensive guard).
  test("per-node style over MAX_PER_NODE_ANIM degrades to the container fade, never skips", () => {
    const fakes = Array.from({ length: MAX_PER_NODE_ANIM + 1 }, () => ({
      opacity: 1,
      translateX: 0,
      translateY: 0,
    }));
    const inner = { opacity: 1, translateX: 0, translateY: 0 };
    const byId = (id: string) => (id === "bigd-inner" ? inner : (fakes[Number(id.slice(1))] ?? null));
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", ms: 1000 }),
    });
    anim.play({ tiles: fakes.map((_, i) => `x${i}`), inner: "bigd-inner" });
    engine.update(500);
    // tiles untouched (at rest), the container carries the fade
    expect(fakes.every((n) => n.opacity === 1 && n.translateX === 0 && n.translateY === 0)).toBe(true);
    expect(inner.opacity).toBeLessThan(1);
    anim.stop();
    expect(inner.opacity).toBe(1);
  });

  test("over MAX_PER_NODE_ANIM with NO container still snaps to rest (nothing to degrade to)", () => {
    const fakes = Array.from({ length: MAX_PER_NODE_ANIM + 1 }, () => ({
      opacity: 1,
      translateX: 0,
      translateY: 0,
    }));
    const byId = (id: string) => fakes[Number(id.slice(1))] ?? null;
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", ms: 1000 }),
    });
    anim.play({ tiles: fakes.map((_, i) => `x${i}`) });
    engine.update(500);
    expect(fakes.every((n) => n.opacity === 1 && n.translateX === 0 && n.translateY === 0)).toBe(true);
    anim.stop();
  });

  // max-files: above the knob even the container fade is skipped — the
  // whole-grid render-list rewalk per animation frame scales with TOTAL
  // files, so a huge folder janks through ANY animation. Appear instantly.
  test("over file-animation-max-files the animation is skipped entirely", () => {
    const inner = { opacity: 1, translateX: 0, translateY: 0 };
    const tiles = Array.from({ length: 30 }, () => ({ opacity: 1, translateX: 0, translateY: 0 }));
    const byId = (id: string) => (id === "maxf-inner" ? inner : (tiles[Number(id.slice(1))] ?? null));
    let maxFiles = 25;
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", containerFade: true, ms: 1000, maxFiles }),
    });
    // total (30) over the knob (25): nothing animates, not even the container
    anim.play({ tiles: tiles.map((_, i) => `x${i}`), inner: "maxf-inner", total: 30 });
    engine.update(500);
    expect(inner.opacity).toBe(1);
    expect(tiles.every((n) => n.opacity === 1)).toBe(true);
    // at/below the knob the same play animates normally (tiles is the
    // viewport-capped subset in real handoffs, so its length ≤ total)
    anim.play({ tiles: tiles.slice(0, 25).map((_, i) => `x${i}`), inner: "maxf-inner", total: 25 });
    engine.update(500);
    expect(inner.opacity).toBeLessThan(1);
    anim.stop();
    expect(inner.opacity).toBe(1);
    // 0 = the knob is off: a huge total still animates
    maxFiles = 0;
    anim.play({ tiles: tiles.slice(0, 25).map((_, i) => `x${i}`), inner: "maxf-inner", total: 50000 });
    engine.update(500);
    expect(inner.opacity).toBeLessThan(1);
    anim.stop();
  });

  // grid rows: a row-major cascade on the ROW boxes is visually identical to a
  // per-tile one (tiles in one row are adjacent cascade indices) but animates
  // cols-times fewer nodes — this is the huge-folder lag fix.
  test("rows list animates the row nodes, tiles untouched, timing keyed to rowsTotal", () => {
    const inner = { opacity: 1, translateX: 0, translateY: 0 };
    const rows = Array.from({ length: 5 }, () => ({ opacity: 1, translateX: 0, translateY: 0 }));
    const tiles = Array.from({ length: 25 }, () => ({ opacity: 1, translateX: 0, translateY: 0 }));
    const byId = (id: string) =>
      id === "rows-inner" ? inner : id.startsWith("r") ? rows[Number(id.slice(1))] : tiles[Number(id.slice(1))];
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger-slide", ms: 1000, staggerPct: 40 }),
    });
    anim.play({
      tiles: tiles.map((_, i) => `x${i}`),
      rows: rows.map((_, i) => `r${i}`),
      inner: "rows-inner",
      total: 25,
      rowsTotal: 5,
    });
    engine.update(500);
    // tiles never touched; row cascade keyed to rowsTotal (row 4 of 5 lags row 0)
    expect(tiles.every((n) => n.opacity === 1 && n.translateY === 0)).toBe(true);
    expect(rows[0]!.opacity).toBeGreaterThan(rows[4]!.opacity);
    expect(rows[4]!.translateY).toBeGreaterThan(0);
    anim.stop();
    expect(rows.every((n) => n.opacity === 1 && n.translateY === 0)).toBe(true);
  });

  test("at-cap per-node list still animates", () => {
    const fakes = Array.from({ length: MAX_PER_NODE_ANIM }, () => ({ opacity: 1, translateX: 0, translateY: 0 }));
    const byId = (id: string) => fakes[Number(id.slice(1))] ?? null;
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "stagger", ms: 1000 }),
    });
    anim.play({ tiles: fakes.map((_, i) => `x${i}`) });
    engine.update(500);
    expect(fakes[0]!.opacity).toBeLessThan(1);
    anim.stop();
    expect(fakes[0]!.opacity).toBe(1);
  });

  test("the container path is exempt from the per-node ceiling", () => {
    const inner = { opacity: 1, translateX: 0, translateY: 0 };
    const byId = (id: string) => (id === "big-inner" ? inner : { opacity: 1 });
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "fade", containerFade: true, ms: 1000 }),
    });
    anim.play({ tiles: Array.from({ length: MAX_PER_NODE_ANIM + 1 }, (_, i) => `t${i}`), inner: "big-inner" });
    engine.update(500);
    expect(inner.opacity).toBeLessThan(1);
    anim.stop();
    expect(inner.opacity).toBe(1);
  });

  test("stop() cancels a running animation and rests its nodes", async () => {
    t.renderer.root.add(Box({ id: "g-inner2", width: 40, height: 8, flexDirection: "column" }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({ renderer: t.renderer, byId, opts: () => opts({ style: "slide", ms: 500 }) });
    anim.play({ tiles: [], inner: "g-inner2" });
    await t.renderOnce();
    anim.stop();
    expect((byId("g-inner2") as any).translateY).toBe(0);
  });

  test("horizontal slide moves translateX (whole cells), never translateY", async () => {
    t.renderer.root.add(Box({ id: "g4-inner", width: 40, height: 8, flexDirection: "column" }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({
      renderer: t.renderer,
      byId,
      opts: () => opts({ style: "slide", dir: "right", ms: 300 }),
    });
    anim.play({ tiles: [], inner: "g4-inner" });
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(5);
      await t.renderOnce();
      expect((byId("g4-inner") as any).translateY).toBe(0);
      expect(Number.isInteger((byId("g4-inner") as any).translateX)).toBe(true);
    }
    anim.stop();
    expect((byId("g4-inner") as any).translateX).toBe(0);
  });

  test("stagger-slide staggers per-tile rises; each tile fades as it moves", async () => {
    t.renderer.root.add(Box({ id: "g3-inner", width: 40, height: 8, flexDirection: "column" }));
    for (let i = 0; i < 4; i++) t.renderer.root.add(Box({ id: `g3-tile-${i}`, width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({ renderer: t.renderer, byId, opts: () => opts({ style: "stagger-slide", ms: 300 }) });
    anim.play({ tiles: ["g3-tile-0", "g3-tile-1", "g3-tile-2", "g3-tile-3"], inner: "g3-inner" });
    const samples: number[][] = [];
    let t0Rest = -1;
    for (let i = 0; i < 120 && t0Rest < 0; i++) {
      await Bun.sleep(5);
      await t.renderOnce();
      const row = [0, 1, 2, 3].map((k) => (byId(`g3-tile-${k}`) as any).translateY);
      samples.push(row);
      // per-tile translate must stay on whole cells (image child coords)
      for (let k = 0; k < 4; k++) expect(Number.isInteger(row[k]!)).toBe(true);
      if (row[0] === 0) t0Rest = samples.length - 1;
    }
    anim.stop();
    // cascade: later tiles rise LATER, so mid-flight there is a sample where
    // tile 3 still lags (bigger dy, still lowered) while tile 0 has risen, and
    // tile 0 reaches rest (dy 0) strictly before tile 3 does
    const firstDiverged = samples.findIndex((s) => s[3]! !== s[0]!);
    expect(firstDiverged).toBeGreaterThanOrEqual(0);
    expect(samples[firstDiverged]![3]!).toBeGreaterThan(samples[firstDiverged]![0]!);
    expect(t0Rest).toBeGreaterThanOrEqual(0);
    expect(samples[t0Rest]![3]!).toBeGreaterThan(0);
    expect((byId("g3-inner") as any).translateY).toBe(0);
    for (let k = 0; k < 4; k++) expect((byId(`g3-tile-${k}`) as any).opacity).toBe(1);
  });
});

describe("hoverLiftDelta", () => {
  test("maps the four directions to exactly one cell (the terminal minimum)", () => {
    expect(hoverLiftDelta("up")).toEqual({ dx: 0, dy: -1 });
    expect(hoverLiftDelta("down")).toEqual({ dx: 0, dy: 1 });
    expect(hoverLiftDelta("left")).toEqual({ dx: -1, dy: 0 });
    expect(hoverLiftDelta("right")).toEqual({ dx: 1, dy: 0 });
  });

  test("an unknown direction never moves", () => {
    expect(hoverLiftDelta("sideways")).toEqual({ dx: 0, dy: 0 });
  });
});
describe("restTileBg", () => {
  test("solid fills with colors.bg, outline variants sit bare", () => {
    const colors = { bg: "#1a1b26" } as any;
    expect(restTileBg("solid", colors)).toBe("#1a1b26");
    expect(restTileBg("outline", colors)).toBe("transparent");
    expect(restTileBg("outline-partial", colors)).toBe("transparent");
  });
});

// real renderer glue: the hover highlight repaints instantly, lifts a reserved
// icon up by one whole cell, yields to selection, and never strands the
// previous tile when the pointer sweeps on
describe("makeTileHoverAnim (engine)", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 60, height: 20 });
    await t.renderOnce();
  });
  afterAll(() => t.renderer.destroy());

  const REST = [26, 27, 38, 255] as const;
  const HOVER = [59, 66, 97, 255] as const;

  // unique node ids per test: the shared renderer's root is never cleared
  // between tests, so a reused id (like "tile-a") would resolve to a LEFTOVER
  // node from an earlier test and silently fake the assertions green.
  const makeRefs = (tag: string, isCutKey?: (k: string) => boolean, lift = false) => {
    const refs = new Map<string, any>();
    refs.set(`/w/a-${tag}`, {
      selected: false,
      iconSpec: { slotId: `slot-a-${tag}` },
      iconSlotId: `slot-a-${tag}`,
      tileId: `tile-a-${tag}`,
      labelId: `lab-a-${tag}`,
      baseFg: "#c0caf5",
      isDir: false,
      hoverLift: lift,
    });
    refs.set(`/w/b-${tag}`, {
      selected: false,
      iconSpec: { slotId: `slot-b-${tag}` },
      iconSlotId: `slot-b-${tag}`,
      tileId: `tile-b-${tag}`,
      labelId: `lab-b-${tag}`,
      baseFg: "#c0caf5",
      isDir: false,
      hoverLift: lift,
    });
    if (isCutKey)
      refs.set(`/w/cut-${tag}`, {
        selected: false,
        iconSpec: { slotId: `slot-cut-${tag}` },
        iconSlotId: `slot-cut-${tag}`,
        tileId: `tile-cut-${tag}`,
        labelId: `lab-cut-${tag}`,
        baseFg: "#c0caf5",
        isDir: false,
        hoverLift: lift,
      });
    return refs;
  };

  const setup = async (
    tag: string,
    enabled = true,
    isCutKey?: (k: string) => boolean,
    lift = enabled,
    vector: { direction?: string; includeLabel?: boolean } = {},
  ) => {
    const refs = makeRefs(tag, isCutKey, lift);
    const iconCalls: number[] = [];
    for (const [, r] of refs) {
      t.renderer.root.add(Box({ id: r.tileId, width: 8, height: 5, backgroundColor: "#1a1b26" }));
      t.renderer.root.add(Box({ id: r.iconSlotId, width: 4, height: 3 }));
      t.renderer.root.add(Text({ id: r.labelId, content: "x", fg: r.baseFg }));
    }
    await t.renderOnce();
    const anim = makeTileHoverAnim({
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      tileRefs: () => refs,
      colors: () => ({ hoverBg: "#3b4261", bg: "#1a1b26", sidebarFgMuted: "#565f89" }) as any,
      uiStyle: () => "solid" as const,
      setIconState: (_spec, idx) => void iconCalls.push(idx),
      isCutKey,
      hoverLiftOpts: () => ({
        enabled,
        direction: (vector.direction ?? "up") as any,
        includeLabel: vector.includeLabel ?? false,
      }),
    });
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    return { refs, iconCalls, anim, byId };
  };

  test("up lift overpaints the row above's empty spare (rest layout untouched)", async () => {
    const key = "/w/lift";
    const tileId = "tile-lift";
    const slotId = "slot-lift";
    const labelId = "lab-lift";
    const refs = new Map<string, any>();
    refs.set(key, {
      selected: false,
      iconSpec: { slotId },
      iconSlotId: slotId,
      tileId,
      labelId,
      baseFg: "#c0caf5",
      isDir: false,
      hoverLift: true,
    });
    const tile = Box({
      id: tileId,
      width: 8,
      height: 5,
      backgroundColor: "#1a1b26",
      flexDirection: "column",
      alignItems: "center",
    });
    // no reserved headroom: the icon starts at the tile's top edge, exactly
    // like a production tile at rest
    const iconBox = Box({
      width: 4,
      height: 3,
      flexDirection: "row",
      justifyContent: "center",
    });
    iconBox.add(Box({ id: slotId, width: 4, height: 3 }));
    tile.add(iconBox);
    tile.add(Text({ id: labelId, content: "x", fg: "#c0caf5" }));
    t.renderer.root.add(tile);
    await t.renderOnce();
    const anim = makeTileHoverAnim({
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      tileRefs: () => refs,
      colors: () => ({ hoverBg: "#3b4261", bg: "#1a1b26", sidebarFgMuted: "#565f89" }) as any,
      uiStyle: () => "solid" as const,
      setIconState: () => {},
      hoverLiftOpts: () => ({ enabled: true, direction: "up", includeLabel: false }),
    });
    anim.playHover(key, true);
    await t.renderOnce();

    const tileNode = t.renderer.root.findDescendantById(tileId) as any;
    const slotNode = t.renderer.root.findDescendantById(slotId) as any;
    const labelNode = t.renderer.root.findDescendantById(labelId) as any;
    const tileTop = tileNode.screenY;
    // the motion lands one cell above the tile top — into the row above's
    // empty bottom spare, which is why the grid never lifts first-row tiles
    expect(slotNode.translateY).toBe(-1);
    expect(labelNode.translateY).toBe(0);
    expect(slotNode.screenY).toBe(tileTop - 1);
    expect(slotNode.screenY + slotNode.height).toBeLessThanOrEqual(tileTop + tileNode.height);
    expect(labelNode.screenY).toBeGreaterThanOrEqual(tileTop);
    expect(labelNode.screenY + labelNode.height).toBeLessThanOrEqual(tileTop + tileNode.height);
  });

  test("tiles without spare room keep the highlight but do not lift", async () => {
    const { anim, iconCalls, byId } = await setup("tight", true, undefined, false);
    anim.playHover("/w/a-tight", true);
    expect(iconCalls).toEqual([1]);
    expect((byId("slot-a-tight") as any).translateY).toBe(0);
    expect((byId("lab-a-tight") as any).translateY).toBe(0);
    expect((byId("tile-a-tight") as any).backgroundColor.toInts()).toEqual([...HOVER] as any);
  });

  test("hover-in lifts a reserved icon one cell and swaps the icon raster to Hover", async () => {
    const { anim, iconCalls, byId } = await setup("in");
    anim.playHover("/w/a-in", true);
    expect(iconCalls).toEqual([1]);
    expect((byId("slot-a-in") as any).translateY).toBe(-1);
    expect((byId("lab-a-in") as any).translateY).toBe(0);
    expect((byId("tile-a-in") as any).backgroundColor.toInts()).toEqual([...HOVER] as any);
  });

  test("the lift is always exactly one cell (no distance knob)", async () => {
    const { anim, byId } = await setup("one", true, undefined, true);
    anim.playHover("/w/a-one", true);
    expect((byId("slot-a-one") as any).translateY).toBe(-1);
    expect((byId("slot-a-one") as any).translateX).toBe(0);
    expect((byId("lab-a-one") as any).translateY).toBe(0);
  });

  test("include filename moves the label with the icon", async () => {
    const { anim, byId } = await setup("nam", true, undefined, true, { includeLabel: true });
    anim.playHover("/w/a-nam", true);
    expect((byId("slot-a-nam") as any).translateY).toBe(-1);
    expect((byId("lab-a-nam") as any).translateY).toBe(-1);
    anim.playHover("/w/a-nam", false);
    expect((byId("slot-a-nam") as any).translateY).toBe(0);
    expect((byId("lab-a-nam") as any).translateY).toBe(0);
  });

  test("left direction moves the icon horizontally, never vertically", async () => {
    const { anim, byId } = await setup("left", true, undefined, true, { direction: "left" });
    anim.playHover("/w/a-left", true);
    expect((byId("slot-a-left") as any).translateX).toBe(-1);
    expect((byId("slot-a-left") as any).translateY).toBe(0);
    expect((byId("lab-a-left") as any).translateX).toBe(0);
    anim.playHover("/w/a-left", false);
    expect((byId("slot-a-left") as any).translateX).toBe(0);
  });

  test("hover-out restores the icon and settles the lift", async () => {
    const { anim, iconCalls, byId } = await setup("out");
    anim.playHover("/w/a-out", true);
    anim.playHover("/w/a-out", false);
    expect(iconCalls).toEqual([1, 0]);
    expect((byId("slot-a-out") as any).translateY).toBe(0);
    expect((byId("lab-a-out") as any).translateY).toBe(0);
    expect((byId("tile-a-out") as any).backgroundColor.toInts()).toEqual([...REST] as any);
  });

  test("a selected tile still settles the lifted icon on mouse-out", async () => {
    const { anim, refs, iconCalls, byId } = await setup("sel");
    anim.playHover("/w/a-sel", true);
    expect(iconCalls).toEqual([1]);
    refs.get("/w/a-sel")!.selected = true;
    const calls = iconCalls.length;
    anim.playHover("/w/a-sel", false);
    expect((byId("slot-a-sel") as any).translateY).toBe(0);
    expect((byId("lab-a-sel") as any).translateY).toBe(0);
    // icon and bg stay selection-owned
    expect(iconCalls.length).toBe(calls);
  });

  test("a tile selected under a stationary cursor settles its lift on the re-fire OVER", async () => {
    // the real stuck-on-select: click a hovered tile → it becomes selected, but
    // the pointer never moves so NO out fires. The selection repaint changes the
    // hit grid and the terminal re-fires a SYNTHETIC over on the stationary
    // cursor; playHover's selected branch must release its OWNED lift, or the
    // selected tile stays nudged until the mouse leaves.
    const { anim, refs, byId } = await setup("resel");
    anim.playHover("/w/a-resel", true);
    expect((byId("slot-a-resel") as any).translateY).toBe(-1);
    refs.get("/w/a-resel")!.selected = true;
    anim.playHover("/w/a-resel", true); // synthetic re-over, no out in between
    expect((byId("slot-a-resel") as any).translateY).toBe(0);
    expect((byId("lab-a-resel") as any).translateY).toBe(0);
  });

  test("sweeping on to a second tile settles the first to rest instantly", async () => {
    const { anim, byId } = await setup("sweep");
    anim.playHover("/w/a-sweep", true);
    expect((byId("tile-a-sweep") as any).backgroundColor.toInts()).toEqual([...HOVER] as any);
    expect((byId("slot-a-sweep") as any).translateY).toBe(-1);
    expect((byId("lab-a-sweep") as any).translateY).toBe(0);
    anim.playHover("/w/b-sweep", true);
    const aBg = (byId("tile-a-sweep") as any).backgroundColor.toInts();
    expect(aBg).toEqual([...REST] as any); // snapped to rest by the replacement
    expect((byId("slot-a-sweep") as any).translateY).toBe(0);
    expect((byId("lab-a-sweep") as any).translateY).toBe(0);
    expect((byId("tile-b-sweep") as any).backgroundColor.toInts()).toEqual([...HOVER] as any);
    expect((byId("slot-b-sweep") as any).translateY).toBe(-1);
    expect((byId("lab-b-sweep") as any).translateY).toBe(0);
  });

  test("a rebuild replaces the hovered node; the synthetic re-over presses the new tile", async () => {
    const { anim, byId } = await setup("rebuild");
    anim.playHover("/w/a-rebuild", true);
    const old = byId("tile-a-rebuild");
    (t.renderer.root as any).remove?.(old);
    t.renderer.root.add(Box({ id: "tile-a-rebuild", width: 8, height: 5, backgroundColor: "#1a1b26" }));
    t.renderer.root.add(Box({ id: "slot-rebuild", width: 4, height: 3 }));
    await t.renderOnce();
    anim.playHover("/w/a-rebuild", true);
    expect((byId("tile-a-rebuild") as any).backgroundColor.toInts()).toEqual([...HOVER] as any);
  });

  test("a cut (clipboard) tile keeps its dim after a hover cycle", async () => {
    const { anim, iconCalls, byId } = await setup("cut", true, (k) => k.endsWith("cut-cut"));
    anim.playHover("/w/cut-cut", true);
    expect(iconCalls.at(-1)).toBe(1); // hover shows the bright raster
    anim.playHover("/w/cut-cut", false);
    // the icon returns to the CUT raster (not plain Rest), the label re-dims
    expect(iconCalls.at(-1)).toBe(3); // IconStateIdx.Cut
    expect((byId("lab-cut-cut") as any).fg.toInts()).toEqual([86, 95, 137, 255]); // #565f89
    expect((byId("tile-cut-cut") as any).backgroundColor.toInts()).toEqual([...REST] as any);
  });

  test("disabled keeps today's instant snap (no lift)", async () => {
    const { anim, iconCalls, byId } = await setup("off", false);
    anim.playHover("/w/a-off", true);
    expect(iconCalls).toEqual([1]);
    expect((byId("tile-a-off") as any).backgroundColor.toInts()).toEqual([...HOVER] as any);
    anim.playHover("/w/a-off", false);
    expect(iconCalls).toEqual([1, 0]);
    expect((byId("tile-a-off") as any).backgroundColor.toInts()).toEqual([...REST] as any);
    expect((byId("slot-a-off") as any).translateY).toBe(0);
    expect((byId("lab-a-off") as any).translateY).toBe(0);
  });

  test("tiles lift their reserved icon without changing tile overflow", async () => {
    const { anim, byId } = await setup("clip");
    anim.playHover("/w/a-clip", true);
    expect((byId("tile-a-clip") as any).overflow).toBe("visible");
    expect((byId("slot-a-clip") as any).translateY).toBe(-1);
    expect((byId("lab-a-clip") as any).translateY).toBe(0);
    anim.playHover("/w/a-clip", false);
    expect((byId("tile-a-clip") as any).overflow).toBe("visible");
    expect((byId("slot-a-clip") as any).translateY).toBe(0);
    expect((byId("lab-a-clip") as any).translateY).toBe(0);
  });

  test("thumbnail tiles also lift without changing tile overflow", async () => {
    const refs = makeRefs("thumb", undefined, true);
    const thumb = refs.get("/w/a-thumb")!;
    delete thumb.iconSpec; // an image/video slot — flattened raster
    for (const [, r] of refs) {
      t.renderer.root.add(Box({ id: r.tileId, width: 8, height: 5, backgroundColor: "#1a1b26" }));
      t.renderer.root.add(Box({ id: r.iconSlotId, width: 4, height: 3 }));
      t.renderer.root.add(Text({ id: r.labelId, content: "x", fg: r.baseFg }));
    }
    await t.renderOnce();
    const anim = makeTileHoverAnim({
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      tileRefs: () => refs,
      colors: () => ({ hoverBg: "#3b4261", bg: "#1a1b26", sidebarFgMuted: "#565f89" }) as any,
      uiStyle: () => "solid" as const,
      setIconState: () => {},
      hoverLiftOpts: () => ({ enabled: true, direction: "up", includeLabel: false }),
    });
    anim.playHover("/w/a-thumb", true);
    expect((t.renderer.root.findDescendantById("tile-a-thumb") as any).overflow).toBe("visible");
    expect((t.renderer.root.findDescendantById("slot-a-thumb") as any).translateY).toBe(-1);
    expect((t.renderer.root.findDescendantById("lab-a-thumb") as any).translateY).toBe(0);
  });
});
