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
import { fileIsImage, fileIsVideo, fileIconFor } from "./filetype";
import { canThumbVideo } from "./icons";
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
  listRowH(): number;
  uiStyle(): string;
  colors(): Record<string, any>;
  previewEnabled(): boolean;
  previewWidth(): number;
  viewMode(): "grid" | "list";
  wordWrap(): boolean;
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

    // image/video tiles: empty slot until the thumbnail lands (no icon->photo
    // swap); everything else queues its category raster as usual. Videos need
    // ffmpeg for the frame extract — without it they keep their icon.
    const isVideo = !e.isDir && fileIsVideo(e.name);
    const wantsThumb = !e.isDir && (fileIsImage(e.name) || (isVideo && canThumbVideo()));
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
    // word wrap [ui] word-wrap: long names flow onto extra rows (capped at the
    // space under the icon) via the native char-wrap buffer — filenames are
    // single runs, per-character wrap fills every line edge-to-edge; overflow
    // lines clip, too-long runs ellipsize. Off = today's single cut line.
    const maxLabelLines = Math.max(1, TILE_H - ICON_CELLS_H);
    const wrapOn = ctx.wordWrap() && e.name.length > TILE_W - 2 && maxLabelLines > 1;
    const labelText: any = Text({
      id: labelId,
      content: wrapOn ? e.name : label,
      fg: baseFg,
      ...(wrapOn ? { width: TILE_W - 2, height: maxLabelLines, truncate: true, wrapMode: "char" as const } : {}),
    });
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
        video: isVideo,
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
    // density knob [ui] list-row-height: 1 = compact, icon scales with height
    const h = Math.min(3, Math.max(1, ctx.listRowH()));
    const { aspect } = ctx.cellMetrics();
    const key = e.abs ?? path.join(cwd, e.name);
    const rowId = `tfm-tile-${tileSeq++}`;
    const labelId = `${rowId}-label`;
    const dim = e.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const row = Box({
      id: rowId,
      width: "100%",
      height: h,
      flexDirection: "row",
      alignItems: "center",
      columnGap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      ...ctx.entryMouseHandlers(e, key, idx),
    });
    // fixed chrome: 2 padding + gaps + size + date + slack; the icon is
    // `aspect * h` cells wide and eats into the flexible name column
    const iconW = Math.max(1, Math.round(aspect * h));

    // image/video rows get thumbnails like grid tiles: empty slot until the
    // async raster lands, then drainThumbs swaps the image in. hCells must be
    // passed explicitly — the drain default is the grid's ICON_CELLS_H, not
    // the list-row-height knob.
    const isVideo = !e.isDir && fileIsVideo(e.name);
    const wantsThumb = !e.isDir && (fileIsImage(e.name) || (isVideo && canThumbVideo()));
    let st: any = null;
    if (wantsThumb) { try { st = statSync(key); } catch {} }
    const useThumb = wantsThumb && st && typeof st.size === "number" && st.size > 0 && st.size <= 26214400;

    let slotId: string;
    let iconSpec: IconSpec | undefined;
    let slotEl: ReturnType<typeof Box>;
    if (useThumb) {
      slotId = ctx.nextIconId();
      slotEl = Box({ id: slotId, width: iconW, height: h, flexDirection: "row", justifyContent: "center" });
    } else {
      const s = ctx.makeIconSlot(e.isDir ? "folder" : fileIconFor(e.name), selection.tileStates(dim), h, 0);
      slotId = s.slotId;
      iconSpec = s.spec;
      slotEl = s.el;
    }
    row.add(slotEl);
    const listW = Math.max(40, ctx.termW() - sw - ctx.reservedRight() - (ctx.uiStyle() === "outline" ? 6 : 3));
    const nameMax = Math.max(12, listW - 27 - iconW);
    const label = e.name.length > nameMax ? e.name.slice(0, nameMax - 1) + "…" : e.name;
    row.add(Text({ id: labelId, content: label, fg: baseFg }));
    row.add(Box({ flexGrow: 1 }));
    row.add(Text({ content: e.isDir ? "" : fmtBytes(e.size ?? 0).padStart(9), fg: colors.sidebarFgMuted }));
    row.add(Text({ content: fmtDateShort(e.mtimeMs), fg: colors.sidebarFgMuted }));
    selection.tileRefs.set(key, { iconSpec, iconSlotId: slotId, selected: false, baseFg, tileId: rowId, labelId, isDir: e.isDir });
    if (useThumb && st) {
      ctx.pushThumbJob({
        slotId,
        path: key,
        mtimeMs: st.mtimeMs ?? 0,
        size: st.size,
        wCells: iconW,
        hCells: h,
        vector: e.name.toLowerCase().endsWith(".svg"),
        video: isVideo,
        fallbackGlyph: glyph[fileIconFor(e.name)] ?? glyph.file!,
      });
    }
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
    selection.setRowH(isList ? Math.min(3, Math.max(1, ctx.listRowH())) : TILE_H);
    selection.updateSelectionStatusReal();
  };

  return { renderGrid };
};
