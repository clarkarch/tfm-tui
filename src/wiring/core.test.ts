// --- Wiring-level pin for core.ts's CONSTRUCTION ORDER.
//
// The modal dim (applyModalDim) shades the icon rasters through
// `slots.setRasterDim`, and the floats layer calls it on every modal
// open/close. If the slot factory were built AFTER the floats layer, that
// call would sit in the TDZ — and the dim's try/catch swallows the
// ReferenceError, so the failure is a SILENT "the rasters stay bright behind
// the modal", not a crash. The order is invisible in the types (both are
// plain consts), so it is pinned structurally: the slot factory must be
// built first.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireCore } from "./core";
import { SCRIM_FILL_ID } from "../ui/scrim";

describe("core wiring construction order", () => {
  test("the slot factory is built BEFORE the floats layer", async () => {
    const src = (await Bun.file(`${import.meta.dir}/core.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const slots = src.indexOf("makeSlots(");
    const floats = src.indexOf("makeFloats(");
    expect(slots).toBeGreaterThan(-1);
    expect(floats).toBeGreaterThan(-1);
    expect(slots).toBeLessThan(floats);
  });
});

// --- The app content's PRESENTATION: one state, one applier.
//
// The boot hide (the "burst" startup — the app is invisible until its first
// frame is complete) and the modal dim (a modal fades the app behind it)
// were TWO owners of the same screen: each wrote its own PART of the
// presentation (the boot wrote the content's opacity, the modal wrote the
// opacity AND the scrim fill AND the icon rasters' shade). In the overlap
// they disagreed — a modal opened while the boot still hid the app left the
// scrim FILL painting over an INVISIBLE app, so the boot's intermediate
// frame showed a tfm-colored screen instead of the terminal's background
// (the one thing the boot hide exists for).
//
// The harness builds the real core wiring against fake nodes: the content
// node, the scrim fill node and a spy on the raster-dim sink.
type CoreHarness = {
  core: ReturnType<typeof wireCore>;
  content: { opacity: number };
  fill: { visible: boolean };
  raster: Array<{ opacity: number | null; shade: number; bgShade: number }>;
  restore: () => void;
};

const coreHarness = (scrim: "fill" | "dim" | "none"): CoreHarness => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-core-"));
  const cfg = path.join(dir, "config.toml");
  writeFileSync(cfg, `[ui]\nscrim = "${scrim}"\nscrim-dim = 35\n`);
  const prevConfig = process.env.TFM_CONFIG;
  process.env.TFM_CONFIG = cfg;
  const content = { opacity: 0 };
  const fill = { visible: false };
  const nodes: Record<string, unknown> = { "tfm-content": content, [SCRIM_FILL_ID]: fill };
  const renderer = { root: { findDescendantById: (id: string) => nodes[id] ?? null } };
  const core = wireCore({ renderer: () => renderer as never, clipboard: () => null });
  const raster: CoreHarness["raster"] = [];
  const realSetRasterDim = core.slots.setRasterDim;
  core.slots.setRasterDim = (opacity: number | null, shade: number, bgShade = 1): void => {
    raster.push({ opacity, shade, bgShade });
  };
  return {
    core,
    content,
    fill,
    raster,
    restore: () => {
      core.slots.setRasterDim = realSetRasterDim;
      if (prevConfig === undefined) delete process.env.TFM_CONFIG;
      else process.env.TFM_CONFIG = prevConfig;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe("the app content's presentation", () => {
  test("a modal opened during the boot does not paint the scrim — the boot's invisible presentation wins as a WHOLE", () => {
    const h = coreHarness("fill");
    try {
      // the boot hides the app (the burst startup): the content is invisible
      expect(h.content.opacity).toBe(0);
      expect(h.fill.visible).toBe(false);
      // a modal opens while the boot still hides the app
      h.core.floats.open("escmenu", () => {});
      // the app is still invisible — and NOTHING of it paints: the scrim
      // fill must stay hidden too, or the boot's intermediate frame shows a
      // tfm-colored screen instead of the terminal's background
      expect(h.content.opacity).toBe(0);
      expect(h.fill.visible).toBe(false);
      // the icon rasters are not shaded either (the app is not on screen, so
      // re-rastering them for a shade nobody can see is pure churn)
      expect(h.raster.every((r) => r.shade === 1 && r.opacity === null)).toBe(true);
    } finally {
      h.restore();
    }
  });

  test("the boot reveal applies the WHOLE presentation — an open modal's dim lands", () => {
    const h = coreHarness("dim");
    try {
      h.core.floats.open("escmenu", () => {});
      expect(h.content.opacity).toBe(0); // the boot hide wins
      // the boot reveals: the modal is still open, so the app comes back
      // DIMMED (not fully visible)
      h.core.setBootHidden(false);
      expect(h.content.opacity).toBe(0.65); // 1 - 35/100
      // the icon rasters are shaded with it
      expect(h.raster.at(-1)?.shade).toBe(0.65);
      // closing the modal restores the visible presentation
      h.core.floats.close("escmenu");
      expect(h.content.opacity).toBe(1);
      expect(h.raster.at(-1)?.shade).toBe(1);
    } finally {
      h.restore();
    }
  });

  test("a modal opened after the boot dims the app and its close restores it", () => {
    const h = coreHarness("fill");
    try {
      h.core.setBootHidden(false);
      expect(h.content.opacity).toBe(1);
      expect(h.fill.visible).toBe(false);
      h.core.floats.open("props", () => {});
      expect(h.fill.visible).toBe(true); // the classic overlay paints
      expect(h.content.opacity).toBe(1); // "fill" dims with the overlay, not the opacity
      h.core.floats.close("props");
      expect(h.fill.visible).toBe(false);
      expect(h.content.opacity).toBe(1);
    } finally {
      h.restore();
    }
  });
});

// --- The grid scrollers' MOUNT.
//
// The scrollers are built by the boot layout — BOTH panes in one step
// (buildBootLayout returns the pair) — and the grid renders INTO the active
// pane's scroller. The old shape was two mutable `{current}` boxes: a
// PARTIAL mount (pane 0 set, pane 1 not) was representable, and `null` meant
// "the boot layout has not run yet" / "this pane is not mounted" / "torn
// down", depending on the reader. The mount is now ONE record with two
// phases — unmounted | mounted — so a partial mount is unrepresentable and
// the active pane ALWAYS has a scroller once the mount happened.
describe("the grid scrollers' mount", () => {
  test("both panes' scrollers mount together, and the active pane always has one", () => {
    const h = coreHarness("fill");
    try {
      // before the boot layout: NO pane has a scroller (the grid's render is
      // a no-op — it has nothing to draw into)
      expect(h.core.scrollersMounted()).toBe(false);
      expect(h.core.scrollerFor(0)).toBeNull();
      expect(h.core.scrollerFor(1)).toBeNull();
      expect(h.core.activeScroller()).toBeNull();
      // the boot layout mounts BOTH panes' scrollers in one step
      const first = { id: "tfm-scroll" } as never;
      const second = { id: "tfm-scroll-2" } as never;
      h.core.mountScrollers([first, second]);
      expect(h.core.scrollersMounted()).toBe(true);
      expect(h.core.scrollerFor(0)).toBe(first);
      expect(h.core.scrollerFor(1)).toBe(second);
      // the ACTIVE pane always has one — the grid renders into it
      expect(h.core.activeScroller()).toBe(first);
      h.core.setActivePane(1);
      expect(h.core.activeScroller()).toBe(second);
    } finally {
      h.restore();
    }
  });
});
