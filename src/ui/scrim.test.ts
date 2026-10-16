import { describe, expect, test } from "bun:test";
import { backgroundClearColor, scrimPlan } from "./scrim";

describe("scrimPlan", () => {
  test("dim fades the content by the configured amount (opacity = 1 - dim%)", () => {
    expect(scrimPlan("dim", 35)).toEqual({ contentOpacity: 0.65 });
    expect(scrimPlan("dim", 50)).toEqual({ contentOpacity: 0.5 });
    expect(scrimPlan("dim", 0)).toEqual({ contentOpacity: 1 });
  });

  test("fill is the classic darker backdrop, now a fixed content fade", () => {
    // The RGBA(0,0,0,150) overlay is gone: a full-screen fill made OpenTUI
    // delete every raster it covered (the "black box" icons). The old overlay's
    // cell darkening is reproduced as a content fade instead.
    expect(scrimPlan("fill", 35)).toEqual({ contentOpacity: 1 - 150 / 255 });
    expect(scrimPlan("fill", 0)).toEqual({ contentOpacity: 1 - 150 / 255 });
  });

  test("none leaves the content fully opaque", () => {
    expect(scrimPlan("none", 35)).toEqual({ contentOpacity: 1 });
  });
});

describe("backgroundClearColor", () => {
  test("transparent-bg on/force clears transparent on a capable terminal", () => {
    expect(backgroundClearColor("on", "#1a1b26", false)).toBe("transparent");
    expect(backgroundClearColor("force", "#1a1b26", false)).toBe("transparent");
  });

  test("off, or the console, clears to the theme bg (opaque)", () => {
    expect(backgroundClearColor("off", "#1a1b26", false)).toBe("#1a1b26");
    expect(backgroundClearColor("on", "#1a1b26", true)).toBe("#1a1b26");
  });
});
