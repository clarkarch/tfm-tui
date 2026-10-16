import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../config/config-schema";
import { buildAppContainer, buildBootLayout, buildTitle, scrollbarTrackColors } from "./ui-boot-layout";
import { BAND_ID } from "../input/grid-input";

// the grid scrollers' bars must wear the theme (not the upstream gray
// defaults), and rethemeChrome must be able to recompute the same mapping
// for the live bars without rebuilding the scrollers.

let t: TestRendererSetup;
beforeAll(async () => {
  t = await createTestRenderer({ width: 100, height: 40 });
});
afterAll(() => t.dispose()); // 0.6.0: destroy + await closed

const hexInts = (h: string): [number, number, number, number] => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
  255,
];

const noop = () => {};

describe("tab strip containers", () => {
  test("both pane tabbars clip instead of bleeding over the grid", async () => {
    const theme = defaultConfig.theme;
    t.renderer.root.add(
      buildAppContainer({
        sw: 26,
        sideInnerW: 24,
        colors: theme,
        uiStyle: "solid",
        tabBarVisible: true,
        previewWidth: 40,
        previewEnabled: false,
        dualPane: false,
        title: buildTitle({ width: 24, colors: theme }),
        toolbarShells: [Box({}), Box({})] as any,
      }),
    );
    await t.renderOnce();
    for (const id of ["tfm-p0-tabbar", "tfm-p1-tabbar"]) {
      const bar: any = t.renderer.root.findDescendantById(id);
      expect(bar).toBeTruthy();
      expect(bar.overflow).toBe("hidden"); // shrunk chips clip here past the minimum
    }
  });
});

describe("sidebar title block", () => {
  const theme = defaultConfig.theme;

  const mountTitle = async (mode: "tfm" | "files" | "none") => {
    // one title block per assertion: the ids are fixed, so a previously
    // mounted block would win findDescendantById
    node("tfm-title-box")?.destroy?.();
    t.renderer.root.add(buildTitle({ width: 24, colors: theme, mode }));
    await t.renderOnce();
  };
  const node = (id: string): any => t.renderer.root.findDescendantById(id);

  test("tfm mode keeps the original title: accent wordmark + tagline", async () => {
    await mountTitle("tfm");
    expect(node("tfm-title-font").text).toBe("tfm");
    // 0.6.0 parses colors to RGBA at set — compare ints, not the hex echo
    expect([...node("tfm-title-font").color.toInts()]).toEqual(hexInts(theme.accent));
    expect(node("tfm-title-sub").visible).toBe(true);
    // wordmark (2 rows) + tagline (1) need the full 5-row box
    expect(node("tfm-title-box").height).toBe(5);
    expect(t.captureCharFrame()).toContain("terminal file manager");
  });

  test("files mode spells Files in the sidebar white, no tagline", async () => {
    await mountTitle("files");
    expect(node("tfm-title-font").text).toBe("Files");
    expect([...node("tfm-title-font").color.toInts()]).toEqual(hexInts(theme.white));
    expect(node("tfm-title-sub").visible).toBe(false);
    // single 2-row wordmark only: one row shorter, so the centered glyph
    // keeps tfm's 1-above/1-below breathing room instead of a second dead row.
    // (the frame pin: the remount lands at the root tail in this harness, so
    // locate the glyph rows instead of assuming rows 0-1.)
    expect(node("tfm-title-box").height).toBe(4);
    const rows = t.captureCharFrame().split("\n");
    const glyph = rows.map((r, i) => (r.includes("█") ? i : -1)).filter((i) => i >= 0);
    expect(glyph).toHaveLength(2);
    expect(glyph[1]).toBe(glyph[0]! + 1);
    // blank row above + below the wordmark, same as tfm mode
    expect(rows[glyph[0]! - 1]!.trim()).toBe("");
    expect(rows[glyph[1]! + 1]!.trim()).toBe("");
  });

  test("none mode hides the block but keeps it in the layout", async () => {
    await mountTitle("none");
    expect(node("tfm-title-box").visible).toBe(false);
  });
});

describe("grid scrollbar theming", () => {
  test("scrollbarTrackColors maps the quiet thumb + invisible bed roles", () => {
    const m = scrollbarTrackColors(defaultConfig.theme);
    expect(m.foregroundColor).toBe(defaultConfig.theme.sidebarFgMuted);
    expect(m.backgroundColor).toBe(defaultConfig.theme.bg);
  });

  test("both boot scrollers build their bars in theme colors", async () => {
    const theme = { ...defaultConfig.theme };
    t.renderer.root.add(Box({ id: "tfm-pane-0", flexGrow: 1, width: "100%", flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "tfm-pane-1", flexGrow: 1, width: "100%", flexDirection: "column" }));
    const [s0, s1] = buildBootLayout({
      renderer: t.renderer,
      byId: (id: string) => t.renderer.root.findDescendantById(id) as any,
      colors: theme,
      bandCtx: {} as any,
      focusPane: noop,
      dropIntoPane: noop,
      closeFileMenu: noop,
      clearSearch: noop,
      blurTerminal: noop,
      pathEditMode: () => false,
      exitPathEdit: noop,
      isRenaming: () => false,
      finishInlineRename: noop,
      clearTileSelection: noop,
      openContextMenu: () => {},
      emptyAreaEntries: () => [],
    });
    await t.renderOnce();
    for (const s of [s0, s1]) {
      const slider = (s as any).verticalScrollBar?.slider as any;
      expect(slider).toBeTruthy();
      expect([...slider.backgroundColor.toInts()]).toEqual(hexInts(theme.bg));
      expect([...slider.foregroundColor.toInts()]).toEqual(hexInts(theme.sidebarFgMuted));
    }
  });
});

describe("rubber-band selection node", () => {
  // Border-only marquee: Box defaults `shouldFill:true`, and OpenTUI's
  // transparent fillRect unreserves EVERY image cell in the covered rect
  // (the renderer clips rasters under any drawn fill) — so a default band
  // deleted a thumbnail dragged over instead of drawing a border around it.
  // shouldFill:false skips the fill so only the border glyphs clip.
  test("band is border-only (shouldFill:false) so a marquee can't wipe thumbnails", async () => {
    const theme = { ...defaultConfig.theme };
    t.renderer.root.add(Box({ id: "tfm-pane-0", flexGrow: 1, width: "100%", flexDirection: "column" }));
    t.renderer.root.add(Box({ id: "tfm-pane-1", flexGrow: 1, width: "100%", flexDirection: "column" }));
    buildBootLayout({
      renderer: t.renderer,
      byId: (id: string) => t.renderer.root.findDescendantById(id) as any,
      colors: theme,
      bandCtx: {} as any,
      focusPane: noop,
      dropIntoPane: noop,
      closeFileMenu: noop,
      clearSearch: noop,
      blurTerminal: noop,
      pathEditMode: () => false,
      exitPathEdit: noop,
      isRenaming: () => false,
      finishInlineRename: noop,
      clearTileSelection: noop,
      openContextMenu: () => {},
      emptyAreaEntries: () => [],
    });
    await t.renderOnce();
    const band: any = t.renderer.root.findDescendantById(BAND_ID);
    expect(band).toBeTruthy();
    expect(band.border).toBe(true);
    expect(band.shouldFill).toBe(false);
  });
});
