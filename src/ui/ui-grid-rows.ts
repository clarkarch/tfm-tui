// --- Grid row builders: the tile and list-row constructors, the window-row
// unit, and the thumbnail policy that decides which entries raster. Split out
// of ui-grid so the rebuild state machine stays readable; these builders are
// PURE w.r.t. that state (no gen counter, no signature, no reveal queue) —
// they only need the ctx seam, the selection and the derived id/geometry
// helpers, which is exactly what makeGridBuilders closes over once.
//
// The ctx type is a type-only import: this module and ui-grid import each
// other, and `import type` is erased (verbatimModuleSyntax), so there is no
// runtime cycle. ---

import { Box, Text } from "@opentui/core";
import { statSync } from "node:fs";
import path from "node:path";
import { fileIconFor, fileIsImage, fileIsVideo } from "../fs/filetype";
import type { Entry } from "../fs/listing";
import { fmtBytes, pad2 } from "../fs/propsinfo";
import { FILE_GLYPH, glyph } from "./glyphs";
import { canThumbVideo } from "./icons";
import { sidePadDelta } from "./style";
import type { GridRendererCtx } from "./ui-grid-types";
import type { IconSpec } from "./ui-slots";
import { visibleTileCap } from "./ui-grid-window";

// thumbnail raster cap: files over this keep their icon (thumbPlanFor).
// Module scope so thumbStatsChanged can mirror the same predicate.
const THUMB_MAX_BYTES = 26214400;

// does this entry currently raster a thumbnail (mirrors thumbPlanFor's
// useThumb)? 0-byte / oversize files and videos without ffmpeg never do.
const thumbEligible = (e: Entry): boolean => {
  if (e.isDir) return false;
  const wants = fileIsImage(e.name) || (fileIsVideo(e.name) && canThumbVideo());
  if (!wants) return false;
  const size = e.size;
  return size !== undefined && size > 0 && size <= THUMB_MAX_BYTES;
};

// stats-only fast-path guard: an in-place edit to a thumbnailed image/video
// must still take the full rebuild — its raster cache keys on mtime/size and
// the fast path pushes no thumb jobs (stale photo until the next rebuild).
// Compares eligibility too: a file crossing INTO or OUT OF the rasterizable
// range (truncated to 0, grown past the cap) changed which raster belongs on
// screen, so it must rebuild in BOTH directions. Order/length drift is the
// structural signature's job, not this one's.
export const thumbStatsChanged = (prev: Entry[] | null, next: Entry[]): boolean => {
  if (!prev || prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    const n = next[i];
    const p = prev[i];
    if (n === undefined || p === undefined) continue;
    const nEligible = thumbEligible(n);
    if (nEligible !== thumbEligible(p)) return true;
    if (!nEligible) continue;
    if (p.size !== n.size || p.mtimeMs !== n.mtimeMs) return true;
  }
  return false;
};

// --- thumbnail plan: image/video entries get an empty slot until the
// async raster lands (no icon->photo swap). Videos need ffmpeg for the
// frame extract — without it they keep their icon. Files over the byte
// cap keep their icon too (25 MiB of pixels is never worth the spawn). ---
const thumbPlanFor = (entry: Entry, key: string): { isVideo: boolean; stat: any; useThumb: boolean } => {
  const isVideo = !entry.isDir && fileIsVideo(entry.name);
  const wantsThumb = !entry.isDir && (fileIsImage(entry.name) || (isVideo && canThumbVideo()));
  let stat: any = null;
  if (wantsThumb) {
    // recursive-search entries (and sort-filled listDir rows) already carry
    // size/mtime — reuse them instead of a second stat per thumbnail
    if (entry.size !== undefined && entry.mtimeMs !== undefined) stat = { size: entry.size, mtimeMs: entry.mtimeMs };
    else {
      try {
        stat = statSync(key);
      } catch {}
    }
  }
  const useThumb = wantsThumb && stat && typeof stat.size === "number" && stat.size > 0 && stat.size <= THUMB_MAX_BYTES;
  return { isVideo, stat, useThumb };
};

// short modified-date for the list view's date column (and the stats-only
// in-place repaint in ui-grid, which must format identically)
export const fmtDateShort = (ms?: number): string => {
  if (!ms) return "-";
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear()
    ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export const makeGridBuilders = (ctx: GridRendererCtx) => {
  const { selection } = ctx;
  const tilePrefix = (): string => ctx.tileIdPrefix ?? "tfm-tile-";
  const availW = (): number => (ctx.availW ? ctx.availW() : ctx.termW() - ctx.sw() - ctx.reservedRight());

  // list-view row density, clamped to what the builders can render
  const rowH = (): number => Math.min(3, Math.max(1, ctx.listRowH()));

  const entryKey = (entry: Entry): string => entry.abs ?? path.join(ctx.state.cwd, entry.name);

  // Windowed mode registers a minimal ref for EVERY entry up front: the full
  // tileRefs map is the selection's contract (selectAll/band/status/selPaths
  // iterate it window-blind). setTileVisual no-ops on an id that is not
  // mounted, so off-window refs hold state without costing nodes; building a
  // row overwrites its ref with the live node data (Map.set keeps order).
  const registerRef = (entry: Entry, idx: number): void => {
    const dim = entry.name.startsWith(".");
    const colors = ctx.colors();
    const tileId = `${tilePrefix()}${idx}`;
    // preserve a selection set while the ref existed (window slides re-register
    // WITHOUT the full render's prevSel snapshot — the flag must survive)
    const prevSel = selection.tileRefs.get(entryKey(entry))?.selected ?? false;
    selection.tileRefs.set(entryKey(entry), {
      selected: prevSel,
      baseFg: dim ? colors.sidebarFgMuted : colors.sidebarFg,
      tileId,
      labelId: `${tileId}-label`,
      isDir: entry.isDir,
    });
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
      ...lines.map((content, i) => Text({ content, fg: i === 0 ? ctx.colors().sidebarFgMuted : ctx.colors().divider })),
      Box({ width: slotW, height: 0 }),
    );
    scroller.content.add(pane);
  };

  const buildTile = (aspect: number, entry: Entry, idx: number, inViewport: boolean): any => {
    // --- grid tile: icon/thumbnail slot + name label, regs in tileRefs ---
    const TILE_W = ctx.tileW();
    const TILE_H = ctx.tileH();
    const ICON_CELLS_H = ctx.iconCells();
    const colors = ctx.colors();

    const key = entryKey(entry);
    const tileId = `${tilePrefix()}${idx}`;
    const labelId = `${tileId}-label`;
    const tile = Box({
      id: tileId,
      width: TILE_W,
      height: TILE_H,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      ...ctx.entryMouseHandlers(entry, key, idx),
    });

    const dim = entry.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const slotW = Math.max(1, Math.round(aspect * ICON_CELLS_H));

    const { isVideo, stat, useThumb } = thumbPlanFor(entry, key);

    let slotId: string;
    let iconSpec: IconSpec | undefined;
    let iconSlotEl: ReturnType<typeof Box>;
    if (useThumb) {
      slotId = ctx.nextIconId();
      iconSlotEl = Box({
        id: slotId,
        width: slotW,
        height: ICON_CELLS_H,
        flexDirection: "row",
        justifyContent: "center",
      });
    } else {
      const s = ctx.makeIconSlot(
        entry.isDir ? "folder" : fileIconFor(entry.name),
        selection.tileStates(dim),
        ICON_CELLS_H,
        0,
      );
      slotId = s.slotId;
      iconSpec = s.spec;
      iconSlotEl = s.el;
    }
    const maxLabelLines = Math.max(1, TILE_H - ICON_CELLS_H);
    const wrapOn = ctx.wordWrap() && entry.name.length > TILE_W - 2 && maxLabelLines > 1;
    // Hover lift moves only the hovered tile, by one cell, and only when it
    // has room: up/down need one vertical spare row (a wrapped label consumes
    // them all, so vertical lifts stay off there), left/right need one
    // horizontal spare cell. "Up" reserves one top row at build (the icon
    // starts one row lower, the lift lands exactly on the tile top): image
    // rasters clip at the scroller viewport, so an unreserved up-lift cut off
    // the top-row icons. down/left/right stay inside the tile and reserve
    // nothing; with the feature off the layout is byte-identical.
    const liftOpts = ctx.hoverLiftOpts?.();
    const liftDir = liftOpts?.direction ?? "up";
    const liftSpareV = TILE_H - ICON_CELLS_H - 1;
    const liftSpareH = TILE_W - slotW;
    const hoverLift =
      (liftOpts?.enabled ?? false) &&
      (liftDir === "up" || liftDir === "down" ? !wrapOn && liftSpareV >= 1 : liftSpareH >= 1);
    const tileBox = Box(
      {
        width: slotW,
        height: ICON_CELLS_H,
        flexDirection: "row",
        justifyContent: "center",
        marginTop: hoverLift && liftDir === "up" ? 1 : 0,
      },
      iconSlotEl,
    );
    tile.add(tileBox);

    const label = entry.name.length > TILE_W - 2 ? `${entry.name.slice(0, TILE_W - 5)}…` : entry.name;
    // word wrap [ui] word-wrap: long names flow onto extra tile rows (capped at the
    // space under the icon) via the native char-wrap buffer — filenames are
    // single runs, per-character wrap fills every line edge-to-edge; overflow
    // lines clip, too-long runs ellipsize. Off = today's single cut line.
    const labelText: any = Text({
      id: labelId,
      content: wrapOn ? entry.name : label,
      fg: baseFg,
      ...(wrapOn ? { width: TILE_W - 2, height: maxLabelLines, truncate: true, wrapMode: "char" as const } : {}),
    });
    tile.add(labelText);

    selection.tileRefs.set(key, {
      iconSpec,
      iconSlotId: slotId,
      // survive window slides (the builder re-registers refs on every build;
      // the full render's prevSel restore runs after and is still authoritative)
      selected: selection.tileRefs.get(key)?.selected ?? false,
      baseFg,
      tileId,
      labelId,
      isDir: entry.isDir,
      hoverLift,
    });

    if (useThumb && stat) {
      ctx.pushThumbJob({
        slotId,
        path: key,
        mtimeMs: stat.mtimeMs ?? 0,
        size: stat.size,
        wCells: slotW,
        vector: entry.name.toLowerCase().endsWith(".svg"),
        video: isVideo,
        visible: inViewport,
        fallbackGlyph: glyph[fileIconFor(entry.name)] ?? FILE_GLYPH,
      });
    }

    return tile;
  };

  // --- list view rows: icon | name | size | modified, all sharing tile mouse
  // behavior via entryMouseHandlers; ids reuse the tfm-tile- prefix so
  // setTileVisual / band select / rename-in-place work unchanged ---
  const buildListRow = (entry: Entry, idx: number, inViewport: boolean): any => {
    const colors = ctx.colors();
    // density knob [ui] list-row-height: 1 = compact, icon scales with height
    const h = rowH();
    const { aspect } = ctx.cellMetrics();
    const key = entryKey(entry);
    const rowId = `${tilePrefix()}${idx}`;
    const labelId = `${rowId}-label`;
    const dim = entry.name.startsWith(".");
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
      ...ctx.entryMouseHandlers(entry, key, idx),
    });
    // fixed chrome: 2 padding + gaps + size + date + slack; the icon is
    // `aspect * h` cells wide and eats into the flexible name column
    const iconW = Math.max(1, Math.round(aspect * h));

    // image/video rows get thumbnails like grid tiles (hCells passed
    // explicitly — the drain default is the grid's ICON_CELLS_H, not the
    // list-row-height knob).
    const { isVideo, stat, useThumb } = thumbPlanFor(entry, key);

    let slotId: string;
    let iconSpec: IconSpec | undefined;
    let slotEl: ReturnType<typeof Box>;
    if (useThumb) {
      slotId = ctx.nextIconId();
      slotEl = Box({ id: slotId, width: iconW, height: h, flexDirection: "row", justifyContent: "center" });
    } else {
      const s = ctx.makeIconSlot(entry.isDir ? "folder" : fileIconFor(entry.name), selection.tileStates(dim), h, 0);
      slotId = s.slotId;
      iconSpec = s.spec;
      slotEl = s.el;
    }
    row.add(slotEl);
    const listW = Math.max(20, availW() - sidePadDelta(ctx.uiStyle()));
    const nameMax = Math.max(12, listW - 27 - iconW);
    const label = entry.name.length > nameMax ? `${entry.name.slice(0, nameMax - 1)}…` : entry.name;
    row.add(Text({ id: labelId, content: label, fg: baseFg }));
    row.add(Box({ flexGrow: 1 }));
    // ids live on the TEXT nodes (boxes have no .content): stats-only ticks
    // repaint these two cells in place via ctx.setTextOnId, no row rebuild
    row.add(
      Text({
        id: `${rowId}-size`,
        content: entry.isDir ? "" : fmtBytes(entry.size ?? 0).padStart(9),
        fg: colors.sidebarFgMuted,
      }),
    );
    row.add(Text({ id: `${rowId}-date`, content: fmtDateShort(entry.mtimeMs), fg: colors.sidebarFgMuted }));
    selection.tileRefs.set(key, {
      iconSpec,
      iconSlotId: slotId,
      selected: selection.tileRefs.get(key)?.selected ?? false,
      baseFg,
      tileId: rowId,
      labelId,
      isDir: entry.isDir,
    });
    if (useThumb && stat) {
      ctx.pushThumbJob({
        slotId,
        path: key,
        mtimeMs: stat.mtimeMs ?? 0,
        size: stat.size,
        wCells: iconW,
        hCells: h,
        vector: entry.name.toLowerCase().endsWith(".svg"),
        video: isVideo,
        visible: inViewport,
        fallbackGlyph: glyph[fileIconFor(entry.name)] ?? FILE_GLYPH,
      });
    }
    return row;
  };

  // ONE window-row unit: a grid row Box (holding up to `cols` tiles) or, in
  // list view, the row-tile itself. Indices are ALWAYS absolute so ids,
  // mouse-handler idx and the thumb-ranking viewport stay aligned with the
  // full tileRefs order across slides. A throwing row (adversarial name, bad
  // stat) degrades to an empty placeholder — never a blank grid: buildInner
  // runs AFTER clearGrid, so a throw here used to strand an empty scroller
  // on every tick and every restart for that folder.
  const buildRow = (
    entries: Entry[],
    isList: boolean,
    cols: number,
    rowHgt: number,
    visFirst: number,
    r: number,
  ): any => {
    try {
      return buildRowInner(entries, isList, cols, rowHgt, visFirst, r);
    } catch (err) {
      ctx.log?.(`grid: row ${r} skipped: ${err instanceof Error ? err.message : err}`);
      // same id + height as the real row so the windowed child-index contract
      // ([pad-top, r0..r1, pad-bottom]) and content height stay exact
      return Box({ id: isList ? `${tilePrefix()}${r}` : `${tilePrefix()}row-${r}`, height: rowHgt });
    }
  };
  const buildRowInner = (
    entries: Entry[],
    isList: boolean,
    cols: number,
    rowHgt: number,
    visFirst: number,
    r: number,
  ): any => {
    const { aspect } = ctx.cellMetrics();
    const visWin = visibleTileCap(ctx.termH(), rowHgt, cols);
    const inViewport = (i: number): boolean => i >= visFirst && i < visFirst + visWin;
    if (isList) {
      // missing entry throws so buildRow degrades the row to its placeholder
      // (same outcome as before, without asserting non-null)
      const e = entries[r];
      if (e === undefined) throw new Error(`grid: row ${r} has no entry`);
      return buildListRow(e, r, inViewport(r));
    }
    const row = Box({ id: `${tilePrefix()}row-${r}`, height: rowHgt, flexDirection: "row" });
    for (let i = r * cols; i < Math.min((r + 1) * cols, entries.length); i++) {
      const e = entries[i];
      if (e === undefined) continue;
      row.add(buildTile(aspect, e, i, inViewport(i)));
    }
    return row;
  };

  // rows (and, in windowed mode, the pads) into a fresh `inner` container.
  // Windowed child layout is a FIXED contract the slide relies on:
  // [pad-top, row r0, ..., row r1, pad-bottom] — pads always exist (a height
  // of 0 collapses them), so row r lives at child index 1+(r-r0) and the
  // content height stays EXACT across slides (no scrollTop clamp). The full
  // (non-windowed) build keeps the old pad-less shape.
  const buildInner = (
    entries: Entry[],
    isList: boolean,
    cols: number,
    rowHgt: number,
    rows: number,
    r0: number,
    r1: number,
    visFirst: number,
    pads: boolean,
  ): any => {
    const inner = Box({ id: `${tilePrefix()}inner`, width: "100%", flexDirection: "column" });
    if (pads) inner.add(Box({ id: `${tilePrefix()}pad-top`, height: r0 * rowHgt }));
    for (let r = r0; r <= r1; r++) inner.add(buildRow(entries, isList, cols, rowHgt, visFirst, r));
    if (pads) inner.add(Box({ id: `${tilePrefix()}pad-bottom`, height: (rows - 1 - r1) * rowHgt }));
    return inner;
  };

  return {
    tilePrefix,
    availW,
    rowH,
    entryKey,
    registerRef,
    buildEmptyPane,
    buildTile,
    buildListRow,
    buildRow,
    buildInner,
  };
};
