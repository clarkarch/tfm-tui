import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { fileAnimAt, makeFileAnim, quantizeDy, slideTravel } from "./ui-grid-anim";

const DIST = 6;

describe("quantizeDy", () => {
  test("keeps translateY on whole cells (fractional coords crash image draw)", () => {
    expect(quantizeDy(4.5)).toBe(5);
    expect(quantizeDy(-0.6)).toBe(-1);
    expect(quantizeDy(3)).toBe(3);
    expect(quantizeDy(Number.NaN)).toBe(0);
  });
});

describe("slideTravel / smoothness", () => {
  test("travel scales with the viewport and stays in a sane range", () => {
    expect(slideTravel(51)).toBeGreaterThanOrEqual(20);
    expect(slideTravel(20)).toBeGreaterThanOrEqual(8);
    expect(slideTravel(0)).toBeGreaterThanOrEqual(8);
    expect(slideTravel(Number.NaN)).toBeGreaterThanOrEqual(8);
  });

  test("a slide produces many distinct integer positions (not ~4 jumps)", () => {
    const dist = slideTravel(51);
    const seen = new Set<number>();
    for (let p = 0; p <= 1.0001; p += 1 / 60) seen.add(quantizeDy(fileAnimAt("slide", p, 0, 1, dist).dy));
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});

describe("fileAnimAt", () => {
  test("off is fully opaque, no offset, at every progress", () => {
    expect(fileAnimAt("off", 0, 0, 5)).toEqual({ opacity: 1, dy: 0 });
    expect(fileAnimAt("off", 0.5, 3, 5)).toEqual({ opacity: 1, dy: 0 });
    expect(fileAnimAt("off", 1, 4, 5)).toEqual({ opacity: 1, dy: 0 });
  });

  test("fade goes 0 → 1 with no vertical motion", () => {
    expect(fileAnimAt("fade", 0, 0, 1)).toEqual({ opacity: 0, dy: 0 });
    expect(fileAnimAt("fade", 1, 0, 1)).toEqual({ opacity: 1, dy: 0 });
    expect(fileAnimAt("fade", 0.5, 0, 1).opacity).toBeCloseTo(0.75, 5);
    expect(fileAnimAt("fade", 0.5, 0, 1).dy).toBe(0);
  });

  test("stagger lags later tiles behind earlier ones, no offset", () => {
    const n = 4;
    const first = fileAnimAt("stagger", 0.5, 0, n, DIST);
    const last = fileAnimAt("stagger", 0.5, n - 1, n, DIST);
    expect(first.opacity).toBeGreaterThan(last.opacity);
    expect(first.dy).toBe(0);
    expect(fileAnimAt("stagger", 1, n - 1, n, DIST)).toEqual({ opacity: 1, dy: 0 });
  });

  test("slide starts below and rises to rest", () => {
    const start = fileAnimAt("slide", 0, 0, 1, DIST);
    expect(start.opacity).toBe(0);
    expect(start.dy).toBe(DIST);
    expect(fileAnimAt("slide", 1, 0, 1, DIST)).toEqual({ opacity: 1, dy: 0 });
    // mid-flight the tile is still partway below its final spot
    const mid = fileAnimAt("slide", 0.5, 0, 1, DIST);
    expect(mid.dy).toBeGreaterThan(0);
    expect(mid.dy).toBeLessThan(DIST);
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

  test("slide animates the container only, then snaps it back to rest", async () => {
    t.renderer.root.add(Box({ id: "g-inner", width: 40, height: 8, flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "g-tile", width: 8, height: 5 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const anim = makeFileAnim({ renderer: t.renderer, byId, style: () => "slide", ms: () => 150 });
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
    const anim = makeFileAnim({ renderer: t.renderer, byId, style: () => "slide", ms: () => 500 });
    anim.play({ tiles: [], inner: "g-inner2" });
    await t.renderOnce();
    anim.stop();
    expect((byId("g-inner2") as any).translateY).toBe(0);
  });
});
