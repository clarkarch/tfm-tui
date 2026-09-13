import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { easeAt, fileAnimAt, fileAnimStyleFrom, makeFileAnim, quantizeDy, slideTravel } from "./ui-grid-anim";

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
