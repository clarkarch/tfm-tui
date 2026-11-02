import { describe, expect, test } from "bun:test";
import { appContentOpacity, backgroundClearColor, bootClearColor, rasterDimPlan, scrimPlan } from "./scrim";

describe("bootClearColor", () => {
  test("the hidden boot paints the TERMINAL's bg (the intermediate frame is invisible)", () => {
    // The renderer presents one frame while the app is still hidden (the boot
    // is async). With tfm's own bg that frame is a visible color fill — the
    // user saw "bg first, then the app". The terminal's default bg makes it
    // invisible: the alt screen already looks like that.
    expect(bootClearColor(true, "off", "#0b0b10", false)).toBe("transparent");
  });

  test("the revealed app paints tfm's own bg", () => {
    expect(bootClearColor(false, "off", "#0b0b10", false)).toBe("#0b0b10");
    // transparent-bg modes keep the terminal showing through, as before
    expect(bootClearColor(false, "on", "#0b0b10", false)).toBe("transparent");
    expect(bootClearColor(false, "off", "#0b0b10", true)).toBe("#0b0b10");
  });
});

describe("scrimPlan", () => {
  test("dim fades the content by the configured amount (opacity = 1 - dim%)", () => {
    expect(scrimPlan("dim", 35)).toEqual({ contentOpacity: 0.65, fill: false });
    expect(scrimPlan("dim", 50)).toEqual({ contentOpacity: 0.5, fill: false });
    expect(scrimPlan("dim", 0)).toEqual({ contentOpacity: 1, fill: false });
  });

  test("fill is the classic dark overlay (content stays opaque)", () => {
    // the overlay box opts into the fork's fillDimsImages so the rasters it
    // covers are dimmed in place instead of deleted
    expect(scrimPlan("fill", 35)).toEqual({ contentOpacity: 1, fill: true });
    expect(scrimPlan("fill", 0)).toEqual({ contentOpacity: 1, fill: true });
  });

  test("none leaves the content fully opaque", () => {
    expect(scrimPlan("none", 35)).toEqual({ contentOpacity: 1, fill: false });
  });
});

describe("appContentOpacity", () => {
  const plan = { contentOpacity: 0.65, fill: false };

  test("the boot-hidden app is fully transparent (the burst startup)", () => {
    // The boot hides the app until the first frame is COMPLETE — the user
    // must not watch a half-built app assemble itself (title, then sidebar,
    // then the grid). Opacity is the only hide that keeps the layout alive.
    expect(appContentOpacity({ bootHidden: true, modalOpen: false, plan })).toBe(0);
  });

  test("a modal never un-hides the booting app", () => {
    expect(appContentOpacity({ bootHidden: true, modalOpen: true, plan })).toBe(0);
  });

  test("a revealed app is opaque, or dimmed while a modal is up", () => {
    expect(appContentOpacity({ bootHidden: false, modalOpen: false, plan })).toBe(1);
    expect(appContentOpacity({ bootHidden: false, modalOpen: true, plan })).toBe(0.65);
  });
});

describe("rasterDimPlan", () => {
  test("dim keeps icons opaque and shades them by the content fade", () => {
    // shading the baked pixels instead of alpha-fading the placement is what
    // stops a dimmed icon from looking like [ui] icons = "transparent"
    expect(rasterDimPlan("dim", 0.65)).toEqual({ opacity: 1, shade: 0.65, bgShade: 1 });
    expect(rasterDimPlan("dim", 1)).toEqual({ opacity: 1, shade: 1, bgShade: 1 });
  });

  test("fill shades fg and the square by the overlay's darkening", () => {
    // the overlay darkens the covered cells, so the flattened square must
    // darken by the same amount or it pops
    expect(rasterDimPlan("fill", 1)).toEqual({ opacity: 1, shade: 1 - 150 / 255, bgShade: 1 - 150 / 255 });
  });

  test("none restores the inherited placement opacity and no shade", () => {
    expect(rasterDimPlan("none", 0.5)).toEqual({ opacity: null, shade: 1, bgShade: 1 });
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
