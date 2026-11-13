import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { Theme } from "../config/config";
import type { Entry } from "../fs/listing";
import { makeSelection } from "../input/selection";
import { makeGridBuilders, thumbPlanFor } from "./ui-grid-rows";
import type { GridRendererCtx } from "./ui-grid-types";
import { makeSlots, type ThumbJob } from "./ui-slots";

// The listings cache hands out stats that may LAG a live edit (an in-place
// edit moves no dir mtime → the cache's signature cannot see it). The raster
// key is built from size+mtime, so a stale stat would hit the OLD thumbnail
// in the disk cache → a stale picture. The plan must not trust a stat that
// says it is stale.
describe("thumbPlanFor", () => {
  test("a STALE stat never keys the raster (the file is re-stat'ed instead)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-thumbplan-"));
    try {
      const f = path.join(dir, "a.jpg");
      writeFileSync(f, "x".repeat(900));
      const stale: Entry = { name: "a.jpg", isDir: false, size: 500, mtimeMs: 1, statsState: "stale-stats" };
      const plan = thumbPlanFor(stale, f);
      expect(plan.useThumb).toBe(true);
      expect(plan.stat?.size).toBe(900); // the LIVE size, not the cached one
      const fresh: Entry = { ...stale, statsState: "fresh" };
      expect(thumbPlanFor(fresh, f).stat?.size).toBe(500); // a fresh stat is reused
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The grid thumbnail's fit target is the tile's REAL rectangular content
// area. The old square physical-pixel icon box made `fit` contain the source
// inside an invented 1:1 frame, so wide/portrait images looked tiny.
describe("grid thumbnail target geometry", () => {
  test("a thumbnail targets the tile's real rectangular content area", async () => {
    const t = await createTestRenderer({ width: 60, height: 8 });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-grid-thumb-geometry-"));
    try {
      const file = path.join(dir, "photo.png");
      writeFileSync(file, "x");
      const jobs: ThumbJob[] = [];
      const colors = {
        bg: "#1a1b26",
        sidebarFg: "#c0caf5",
        sidebarFgMuted: "#6f7086",
        sidebarBg: "#1a1b26",
        hoverBg: "#292e42",
        white: "#ffffff",
        accent: "#7aa2f7",
        accentBg: "#33467c",
      } as unknown as Theme;
      const selection = makeSelection({
        colors: () => colors,
        byId: (id) => t.renderer.root.findDescendantById(id),
        setText: () => {},
        setIconState: () => true,
        isCutKey: () => false,
        scroller: () => null,
        viewH: () => 8,
        rowHInit: () => 2,
        renderPreview: () => {},
        paintTile: () => {},
      });
      const ctx: GridRendererCtx = {
        termW: () => 60,
        termH: () => 8,
        scroller: () => null,
        state: { cwd: dir, showHidden: false, sortBy: "name", sortAsc: true },
        searchQuery: () => "",
        recursiveSearch: () => false,
        pathEditMode: () => false,
        sw: () => 0,
        tileW: () => 20,
        tileH: () => 5,
        iconCells: () => 2,
        listRowH: () => 2,
        uiStyle: () => "solid",
        colors: () => colors,
        previewEnabled: () => false,
        previewWidth: () => 0,
        viewMode: () => "grid",
        wrapMode: () => "none",
        reservedRight: () => 0,
        cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 2 }),
        makeIconSlot: () => {
          throw new Error("an image tile must not build an icon slot");
        },
        pushThumbJob: (job) => jobs.push(job),
        nextIconId: () => "grid-thumb-rect",
        drainIconQueue: () => {},
        drainThumbs: () => {},
        stripSelectable: () => {},
        fileAnim: () => null,
        fileAnimVisibleOnly: () => false,
        selection,
        entryMouseHandlers: () => ({
          onMouseDown: () => {},
          onMouseUp: () => {},
          onMouseDragEnd: () => {},
          onMouseDrag: () => {},
          onMouseDrop: () => {},
        }),
        isCutKey: () => false,
        waitForResolution: async () => {},
        clearRenameEdit: () => {},
      };
      const builders = makeGridBuilders(ctx);
      const entry: Entry = { name: "photo.png", isDir: false, size: 1, mtimeMs: 1_700_000_000_000 };
      t.renderer.root.add(builders.buildTile(2, entry, 0, true));
      await t.renderOnce();

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.wCells).toBe(18); // tile width 20 minus the 1-cell inset on each side
      expect(jobs[0]?.hCells).toBe(2); // the configured thumbnail height
      const slot = t.renderer.root.findDescendantById(jobs[0]!.slotId) as any;
      expect(slot.width).toBe(18);
      expect(slot.height).toBe(2);
    } finally {
      await t.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The list row's icon and its name must SHARE a row. The name is centred by
// the ROW (alignItems: center), while the icon is a SLOT whose fallback glyph
// was top-aligned — so a zoomed-in list row (height 2..3) put the glyph on
// the row ABOVE the name and the file looked misaligned with its name.
//
// This test drives the PRODUCTION row builder AND the PRODUCTION icon slot
// (not a hand-rolled row), so a change to either half of the alignment is
// caught: the row's centring and the slot's centring must agree.
describe("list row icon/name alignment", () => {
  const FG = "#c0caf5";
  const BG = "#1a1b26";
  const colors = {
    bg: BG,
    sidebarFg: FG,
    sidebarFgMuted: FG,
    sidebarBg: BG,
    hoverBg: BG,
    white: "#ffffff",
    accent: "#7aa2f7",
    accentBg: "#33467c",
  } as unknown as Theme;

  let thumbSeq = 0;

  const mountListRow = async (rowHeight: number): Promise<string[]> => {
    const t = await createTestRenderer({ width: 60, height: 8 });
    try {
      const slots = makeSlots({
        renderer: () => t.renderer,
        byId: (id) => t.renderer.root.findDescendantById(id),
        colors: () => colors,
        uiStyle: () => "solid",
        iconsMode: () => "opaque",
        thumbnailFit: () => "fit",
        iconCells: () => rowHeight,
        glyphFor: () => "F",
        isTtyMode: () => false,
        forceGlyph: () => false,
      });
      const selection = makeSelection({
        colors: () => colors,
        byId: (id) => t.renderer.root.findDescendantById(id),
        setText: () => {},
        setIconState: () => true,
        isCutKey: () => false,
        scroller: () => null,
        viewH: () => 8,
        rowHInit: () => rowHeight,
        renderPreview: () => {},
        paintTile: () => {},
      });
      const ctx: GridRendererCtx = {
        termW: () => 60,
        termH: () => 8,
        scroller: () => null,
        state: { cwd: "/tmp", showHidden: false, sortBy: "name", sortAsc: true },
        searchQuery: () => "",
        recursiveSearch: () => false,
        pathEditMode: () => false,
        sw: () => 0,
        tileW: () => 20,
        tileH: () => 5,
        iconCells: () => rowHeight,
        listRowH: () => rowHeight,
        uiStyle: () => "solid",
        colors: () => colors,
        previewEnabled: () => false,
        previewWidth: () => 0,
        viewMode: () => "list",
        wrapMode: () => "none",
        reservedRight: () => 0,
        cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 2 }),
        makeIconSlot: slots.makeIconSlot,
        pushThumbJob: () => {},
        nextIconId: () => `thumb-${thumbSeq++}`,
        drainIconQueue: () => {},
        drainThumbs: () => {},
        stripSelectable: () => {},
        fileAnim: () => null,
        fileAnimVisibleOnly: () => false,
        selection,
        entryMouseHandlers: () => ({
          onMouseDown: () => {},
          onMouseUp: () => {},
          onMouseDragEnd: () => {},
          onMouseDrag: () => {},
          onMouseDrop: () => {},
        }),
        isCutKey: () => false,
        waitForResolution: async () => {},
        clearRenameEdit: () => {},
      };
      const builders = makeGridBuilders(ctx);
      const entry: Entry = { name: "file.txt", isDir: false, size: 5, mtimeMs: 1_700_000_000_000 };
      const row = builders.buildListRow(entry, 0, true);
      t.renderer.root.add(row);
      await t.renderOnce();
      return t.captureCharFrame().split("\n");
    } finally {
      await t.dispose();
    }
  };

  const rowsOf = (lines: string[], needle: string): number => lines.findIndex((l) => l.includes(needle));

  test("a 3-row list row puts the glyph on the name's (middle) row", async () => {
    const lines = await mountListRow(3);
    const glyphRow = rowsOf(lines, "F");
    const nameRow = rowsOf(lines, "file.txt");
    expect(glyphRow).toBe(nameRow);
    expect(glyphRow).toBe(1); // the middle row of a 3-row list row
  });

  test("a 2-row list row puts the glyph on the name's row", async () => {
    const lines = await mountListRow(2);
    expect(rowsOf(lines, "F")).toBe(rowsOf(lines, "file.txt"));
  });

  test("a 1-row list row is unchanged (one row holds both)", async () => {
    const lines = await mountListRow(1);
    expect(rowsOf(lines, "F")).toBe(rowsOf(lines, "file.txt"));
    expect(rowsOf(lines, "F")).toBe(0);
  });
});
