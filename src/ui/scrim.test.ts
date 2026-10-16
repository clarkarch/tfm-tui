import { describe, expect, test } from "bun:test";
import { backgroundClearColor, scrimPlan } from "./scrim";

describe("scrimPlan", () => {
  test("dim fades the content over the theme bg (no dark backdrop)", () => {
    expect(scrimPlan("dim")).toEqual({ contentOpacity: 0.45, darkBackdrop: false, fill: false });
  });

  test("dark fades the content AND requests the near-black backdrop", () => {
    expect(scrimPlan("dark")).toEqual({ contentOpacity: 0.45, darkBackdrop: true, fill: false });
  });

  test("fill uses the classic overlay (no opacity fade, glyph fallback)", () => {
    expect(scrimPlan("fill")).toEqual({ contentOpacity: 1, darkBackdrop: false, fill: true });
  });

  test("none leaves the content fully opaque", () => {
    expect(scrimPlan("none")).toEqual({ contentOpacity: 1, darkBackdrop: false, fill: false });
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
