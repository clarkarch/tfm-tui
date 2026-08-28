// --- Grid renderer: the async clear-and-rebuild of the file area (grid tiles
// OR list rows), the tile/list-row builders, empty/restricted states and the
// thumbnail handoff. Gen-counter guards stale async rebuilds; selection state
// lives in ./selection and is reset at every rebuild tail. No module-level
// renderer imports — everything arrives via ctx (live getters for geometry). ---
import { Box, Text } from "@opentui/core";
import { statSync } from "node:fs";
import path from "node:path";
import { listDir, type Entry } from "./listing";
import { fsErrText } from "./fsutil";
import { fileIsImage, fileIconFor } from "./filetype";
import { fmtBytes } from "./propsinfo";
import { RECENT_URI, STARRED_URI } from "./uri";
import { clearChildren } from "./uiutil";
import type { SortMode } from "./menu-entries";
import { glyph } from "./glyphs";
import type { Selection } from "./selection";
import type { IconSpec } from "./ui-slots";

export type GridState = { cwd: string; showHidden: boolean; sortBy: SortMode; sortAsc: boolean };

export type GridRendererCtx = {
  termW(): number;
  termH(): number;
  scroller(): any | null;
  state: GridState;
  searchQuery(): string;
  pathEditMode(): boolean;
  // geometry — live getters, rewritten by applyConfig
  sw(): number;
  tileW(): number;
  tileH(): number;
  iconCells(): number;
  uiStyle(): string;
  colors(): Record<string, any>;
  previewEnabled(): boolean;
  previewWidth(): number;
  viewMode(): "grid" | "list";
  reservedRight(): number;
  // ui-slots
  cellMetrics(): { cellW: number; cellH: number; aspect: number };
  makeIconSlot(name: string, states: any[], heightCells?: number, initialState?: number): { el: any; slotId: string; spec: any };
  pushThumbJob(job: any): void;
  nextIconId(): string;
  drainIconQueue(): void | Promise<void>;
  drainThumbs(): void | Promise<void>;
  stripSelectable(): void;
  // selection module + mouse handlers
  selection: Selection;
  entryMouseHandlers(e: Entry, key: string, idx: number): any;
  isCutKey(key: string): boolean;
  // misc hooks
  waitForResolution(): Promise<void>;
  clearRenameEdit(): void;
};

export const makeGridRenderer = (ctx: GridRendererCtx) => {
  let gridGen = 0;
  let tileSeq = 0;
  const { selection } = ctx;

  const clearGrid = (): void => {
    const scroller = ctx.scroller();
    if (!scroller) return;
    clearChildren(scroller.content as any);
    selection.tileRefs.clear();
  };

  const buildEmptyPane = (icon: string, lines: string[]): any => {
    const { aspect } = ctx.cellMetrics();
    const iconCells = 8;
    const slotW = Math.max(1, Math.round(aspect * iconCells));
    const paneH = Math.max(8, ctx.termH() - 3);
    const scroller = ctx.scroller();
    const pane = Box(
      {
        width: "100%",
        height: paneH,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: ctx.colors().bg,
      },
      ctx.makeIconSlot(icon, [{ fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg }], iconCells).el,
      Box({ height: 1 }),
      ...lines.map((content, i) =>
        Text({ content, fg: i === 0 ? ctx.colors().sidebarFgMuted : ctx.colors().divider }),
      ),
      Box({ width: slotW, height: 0 }),
    );
    scroller.content.add(pane);
  };

  const buildTile = (aspect: number, e: Entry, idx: number): any => {
    const cwd = ctx.state.cwd;
    const TILE_W = ctx.tileW();
    const TILE_H = ctx.tileH();
    const ICON_CELLS_H = ctx.iconCells();
    const colors = ctx.colors();
    const key = e.abs ?? path.join(cwd, e.name);
    const tileId = `tfm-tile-${tileSeq++}`;
    const labelId = `${tileId}-label`;
    const tile = Box({
      id: tileId,
      width: TILE_W,
      height: TILE_H,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      ...ctx.entryMouseHandlers(e, key, idx),
    });

    const dim = e.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const slotW = Math.max(1, Math.round(aspect * ICON_CELLS_H));

    // image tiles: empty slot until the thumbnail lands (no icon->photo swap);
    // everything else queues its category raster as usual
    const wantsThumb = !e.isDir && fileIsImage(e.name);
    let st: any = null;
    if (wantsThumb) { try { st = statSync(key); } catch {} }
    const useThumb = wantsThumb && st && typeof st.size === "number" && st.size > 0 && st.size <= 26214400;

    let slotId: string;
    let iconSpec: IconSpec | undefined;
    let iconSlotEl: ReturnType<typeof Box>;
    if (useThumb) {
      slotId = ctx.nextIconId();
      iconSlotEl = Box({ id: slotId, width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" });
    } else {
      const s = ctx.makeIconSlot(e.isDir ? "folder" : fileIconFor(e.name), selection.tileStates(dim), ICON_CELLS_H, 0);
      slotId = s.slotId;
      iconSpec = s.spec;
      iconSlotEl = s.el;
    }
    const tileBox = Box({ width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" }, iconSlotEl);
    tile.add(tileBox);

    const label = e.name.length > TILE_W - 2 ? e.name.slice(0, TILE_W - 5) + "…" : e.name;
    const labelText: any = Text({ id: labelId, content: label, fg: baseFg });
    tile.add(labelText);

    selection.tileRefs.set(key, { iconSpec, iconSlotId: slotId, selected: false, baseFg, tileId, labelId, isDir: e.isDir });

    if (useThumb && st) {
      ctx.pushThumbJob({
        slotId,
        path: key,
        mtimeMs: st.mtimeMs ?? 0,
        size: st.size,
        wCells: slotW,
        vector: e.name.toLowerCase().endsWith(".svg"),
        fallbackGlyph: glyph[fileIconFor(e.name)] ?? glyph.file!,
      });
    }

    return tile;
  };

  // --- list view rows: icon | name | size | modified, all sharing tile mouse
  // behavior via entryMouseHandlers; ids reuse the tfm-tile- prefix so
  // setTileVisual / band select / rename-in-place work unchanged ---
  const fmtDateShort = (ms?: number): string => {
    if (!ms) return "-";
    const d = new Date(ms);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return d.getFullYear() === new Date().getFullYear()
      ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
      : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };

  const buildListRow = (e: Entry, idx: number): any => {
    const cwd = ctx.state.cwd;
    const sw = ctx.sw();
    const colors = ctx.colors();
    const key = e.abs ?? path.join(cwd, e.name);
    const rowId = `tfm-tile-${tileSeq++}`;
    const labelId = `${rowId}-label`;
    const dim = e.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const row = Box({
      id: rowId,
      width: "100%",
      height: 1,
      flexDirection: "row",
      alignItems: "center",
      columnGap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      ...ctx.entryMouseHandlers(e, key, idx),
    });
    const iconSlot = ctx.makeIconSlot(e.isDir ? "folder" : fileIconFor(e.name), selection.tileStates(dim), 1, 0);
    row.add(iconSlot.el);
    // rough inner width of the file pane; only used to truncate names, rows
    // themselves are 100%-width and flex
    // 28 cells of fixed chrome: 2 padding + 1 icon + 4 gaps + 9 size + 11 date + 1 slack
    const listW = Math.max(40, ctx.termW() - sw - ctx.reservedRight() - (ctx.uiStyle() === "outline" ? 6 : 3));
    const nameMax = Math.max(12, listW - 28);
    const label = e.name.length > nameMax ? e.name.slice(0, nameMax - 1) + "…" : e.name;
    row.add(Text({ id: labelId, content: label, fg: baseFg }));
    row.add(Box({ flexGrow: 1 }));
    row.add(Text({ content: e.isDir ? "" : fmtBytes(e.size ?? 0).padStart(9), fg: colors.sidebarFgMuted }));
    row.add(Text({ content: fmtDateShort(e.mtimeMs), fg: colors.sidebarFgMuted }));
    selection.tileRefs.set(key, { iconSpec: iconSlot.spec, iconSlotId: iconSlot.slotId, selected: false, baseFg, tileId: rowId, labelId, isDir: e.isDir });
    return row;
  };

  const renderGrid = async (): Promise<void> => {
    const scroller = ctx.scroller();
    if (!scroller) return;
    const gen = ++gridGen;
    const colors = ctx.colors();
    const state = ctx.state;
    // a rebuild destroys the edit input; drop the state with it
    ctx.clearRenameEdit();
    clearGrid();
    const q = ctx.searchQuery().trim().toLowerCase();
    let allEntries: Entry[];
    try {
      allEntries = await listDir(state.cwd, state.showHidden || q.length > 0, state.sortBy, state.sortAsc);
    } catch (err) {
      // restricted dir (/root, foreign 000 dirs): say why instead of a blank pane
      if (gen !== gridGen) return;
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      buildEmptyPane("close", [
        `can't open this folder (${fsErrText(err)})`,
        ctx.pathEditMode() ? "" : "edit the path above to go elsewhere",
      ]);
      ctx.stripSelectable();
      void ctx.drainIconQueue();
      return;
    }
    const entries = q ? allEntries.filter((e) => e.name.toLowerCase().includes(q)) : allEntries;
    if (gen !== gridGen) return;

    if (entries.length === 0) {
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      buildEmptyPane("folder", [
        q ? "no matches"
          : state.cwd === RECENT_URI ? "no recent files"
          : state.cwd === STARRED_URI ? "nothing starred yet"
          : "this folder is empty",
      ]);
      void ctx.drainIconQueue();
      return;
    }

    await ctx.waitForResolution();
    if (gen !== gridGen) return;
    const { aspect } = ctx.cellMetrics();
    const isList = ctx.viewMode() === "list";
    const TILE_H = ctx.tileH();
    const cols = isList ? 1 : Math.max(1, Math.floor((ctx.termW() - ctx.sw() - ctx.reservedRight() - 3) / ctx.tileW()));

    // list view always shows size + modified columns, so fetch whatever stats
    // the active sort mode didn't already populate
    if (isList) {
      for (const en of entries) {
        if (en.size !== undefined && en.mtimeMs !== undefined) continue;
        try {
          const st = statSync(en.abs ?? path.join(state.cwd, en.name));
          en.size = st.size;
          en.mtimeMs = st.mtimeMs ?? 0;
        } catch {}
      }
    }

    let tileIdx = 0;
    if (isList) {
      for (const e of entries) scroller.content.add(buildListRow(e, tileIdx++));
    } else {
      for (let i = 0; i < entries.length; i += cols) {
        const row = Box({ height: TILE_H, flexDirection: "row" });
        for (const e of entries.slice(i, i + cols)) row.add(buildTile(aspect, e, tileIdx++));
        scroller.content.add(row);
      }
    }

    // cut (pending-move) tiles render dimmed; apply after mount so id lookups work
    selection.tileRefs.forEach((_: any, key: string) => { if (ctx.isCutKey(key)) selection.setTileVisual(key, 0); });

    // fresh Text nodes default selectable=true; strip AFTER the async rebuild or
    // the renderer's text-selection drag hijacks file-drag events
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
    selection.setFocusKeys([...selection.tileRefs.keys()]);
    selection.setFocusIdx(-1);
    selection.setSelAnchor(null);
    selection.setCols(cols);
    selection.setRowH(isList ? 1 : TILE_H);
    selection.updateSelectionStatusReal();
  };

  return { renderGrid };
};
