// --- Grid renderer: the async clear-and-rebuild of the file area (grid tiles
// OR list rows), the tile/list-row builders, empty/restricted states and the
// thumbnail handoff. Gen-counter guards stale async rebuilds; selection lives
// in ./selection and is preserved by path across rebuilds (vanished files
// drop, surviving keys keep their state). No module-level renderer imports —
// everything arrives via ctx (live getters for geometry). ---
import { Box, Text } from "@opentui/core";
import { statSync } from "node:fs";
import path from "node:path";
import { compareEntries, listDir, type Entry } from "../fs/listing";
import { searchTree } from "../fs/search";
import type { Theme } from "../config/config";
import { fsErrText } from "../fs/fsutil";
import { fileIsImage, fileIsVideo, fileIconFor } from "../fs/filetype";
import { canThumbVideo } from "./icons";
import { sidePadDelta, type UiStyle } from "./style";
import { fmtBytes, pad2 } from "../fs/propsinfo";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { clearChildren } from "../lib/uiutil";
import type { SortMode } from "../lib/sort";
import { glyph } from "./glyphs";
import type { Selection } from "../input/selection";
import { TileVisual } from "../input/grid-input";
import type { IconSpec } from "./ui-slots";

export type GridState = {
  cwd: string;
  showHidden: boolean;
  sortBy: SortMode;
  sortAsc: boolean;
  // one-shot: a launch FILE path to highlight after the first build (set by
  // the CLI, consumed + cleared here)
  pendingSelect?: string | null;
};

type GridRendererCtx = {
  termW(): number;
  termH(): number;
  scroller(): any | null;
  state: GridState;
  searchQuery(): string;
  // [ui] recursive-search: type-to-search walks the subtree (fd/walk) instead
  // of filtering the open dir; test seam injects a fake backend
  recursiveSearch(): boolean;
  searchTree?(root: string, query: string, opts?: { hidden?: boolean; signal?: AbortSignal }): Promise<Entry[]>;
  pathEditMode(): boolean;
  // geometry — live getters, rewritten by applyConfig
  sw(): number;
  tileW(): number;
  tileH(): number;
  iconCells(): number;
  listRowH(): number;
  uiStyle(): UiStyle;
  colors(): Theme;
  previewEnabled(): boolean;
  previewWidth(): number;
  viewMode(): "grid" | "list";
  wordWrap(): boolean;
  reservedRight(): number;
  // per-pane content width; when absent falls back to termW - sw - reservedRight
  // (single-pane callers / tests)
  availW?(): number;
  // unique tile id prefix per pane (dual pane) so both panes' tile ids can't
  // collide in the global renderable registry; default "tfm-tile-"
  tileIdPrefix?: string;
  // ui-slots
  cellMetrics(): { cellW: number; cellH: number; aspect: number };
  makeIconSlot(
    name: string,
    states: any[],
    heightCells?: number,
    initialState?: number,
  ): { el: any; slotId: string; spec: any };
  pushThumbJob(job: any): void;
  nextIconId(): string;
  drainIconQueue(): void | Promise<void>;
  drainThumbs(): void | Promise<void>;
  stripSelectable(): void;
  // animate the freshly built tiles/rows in ([ui] file-animation); no-op on
  // "off". `inner` is the single container node slide animates; passing an
  // empty target stops any in-flight animation (called before clearGrid)
  fileAnim(target: { tiles: string[]; inner?: string | null }): void;
  // selection module + mouse handlers
  selection: Selection;
  entryMouseHandlers(entry: Entry, key: string, idx: number): any;
  isCutKey(key: string): boolean;
  // misc hooks
  waitForResolution(): Promise<void>;
  clearRenameEdit(): void;
};

export const makeGridRenderer = (ctx: GridRendererCtx) => {
  let gridGen = 0;
  let tileSeq = 0;
  // signature of the last painted tile set — an unchanged pane skips the
  // clear+rebuild (renderAll repaints both panes on any navigation)
  let lastSig = "";
  // Animation gate: rebuilds also fire for pure layout/geometry changes (hover
  // drawer collapse, dual-pane toggle, resize, theme flip) which must NOT replay
  // the entry animation — the tiles rebuilt for the same files, they didn't
  // appear. Only a content change (cwd/list/query/sort/view) animates.
  let lastContentSig: string | null = null;
  // in-flight recursive search; a newer render aborts it so stale keystroke
  // walks don't keep eating disk while a fresh query runs
  let searchAbort: AbortController | null = null;
  const { selection } = ctx;
  const tilePrefix = (): string => ctx.tileIdPrefix ?? "tfm-tile-";
  const availW = (): number => (ctx.availW ? ctx.availW() : ctx.termW() - ctx.sw() - ctx.reservedRight());

  // list-view row density, clamped to what the builders can render
  const rowH = (): number => Math.min(3, Math.max(1, ctx.listRowH()));

  const clearGrid = (): void => {
    const scroller = ctx.scroller();
    if (!scroller) return;
    // stop any in-flight file animation BEFORE the nodes it targets are
    // destroyed — a frame callback writing opacity/translateY to a just-removed
    // renderable is the use-after-destroy path
    try {
      ctx.fileAnim({ tiles: [], inner: null });
    } catch {}
    clearChildren(scroller.content);
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
      ...lines.map((content, i) => Text({ content, fg: i === 0 ? ctx.colors().sidebarFgMuted : ctx.colors().divider })),
      Box({ width: slotW, height: 0 }),
    );
    scroller.content.add(pane);
  };

  // --- thumbnail plan: image/video entries get an empty slot until the
  // async raster lands (no icon->photo swap). Videos need ffmpeg for the
  // frame extract — without it they keep their icon. Files over the byte
  // cap keep their icon too (25 MiB of pixels is never worth the spawn). ---
  const THUMB_MAX_BYTES = 26214400;
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
    const useThumb =
      wantsThumb && stat && typeof stat.size === "number" && stat.size > 0 && stat.size <= THUMB_MAX_BYTES;
    return { isVideo, stat, useThumb };
  };

  const buildTile = (aspect: number, entry: Entry, idx: number): any => {
    // --- grid tile: icon/thumbnail slot + name label, regs in tileRefs ---
    const cwd = ctx.state.cwd;
    const TILE_W = ctx.tileW();
    const TILE_H = ctx.tileH();
    const ICON_CELLS_H = ctx.iconCells();
    const colors = ctx.colors();
    const key = entry.abs ?? path.join(cwd, entry.name);
    const tileId = `${tilePrefix()}${tileSeq++}`;
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
    const tileBox = Box(
      { width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" },
      iconSlotEl,
    );
    tile.add(tileBox);

    const label = entry.name.length > TILE_W - 2 ? `${entry.name.slice(0, TILE_W - 5)}…` : entry.name;
    // word wrap [ui] word-wrap: long names flow onto extra rows (capped at the
    // space under the icon) via the native char-wrap buffer — filenames are
    // single runs, per-character wrap fills every line edge-to-edge; overflow
    // lines clip, too-long runs ellipsize. Off = today's single cut line.
    const maxLabelLines = Math.max(1, TILE_H - ICON_CELLS_H);
    const wrapOn = ctx.wordWrap() && entry.name.length > TILE_W - 2 && maxLabelLines > 1;
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
      selected: false,
      baseFg,
      tileId,
      labelId,
      isDir: entry.isDir,
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
        fallbackGlyph: glyph[fileIconFor(entry.name)] ?? glyph.file!,
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
    return d.getFullYear() === new Date().getFullYear()
      ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const buildListRow = (entry: Entry, idx: number): any => {
    const cwd = ctx.state.cwd;
    const colors = ctx.colors();
    // density knob [ui] list-row-height: 1 = compact, icon scales with height
    const h = rowH();
    const { aspect } = ctx.cellMetrics();
    const key = entry.abs ?? path.join(cwd, entry.name);
    const rowId = `${tilePrefix()}${tileSeq++}`;
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
    row.add(Text({ content: entry.isDir ? "" : fmtBytes(entry.size ?? 0).padStart(9), fg: colors.sidebarFgMuted }));
    row.add(Text({ content: fmtDateShort(entry.mtimeMs), fg: colors.sidebarFgMuted }));
    selection.tileRefs.set(key, {
      iconSpec,
      iconSlotId: slotId,
      selected: false,
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
        fallbackGlyph: glyph[fileIconFor(entry.name)] ?? glyph.file!,
      });
    }
    return row;
  };

  // --- grid rebuild: clear, list, lay out tiles/rows, repaint cut dims.
  // `force` skips the unchanged-signature fast path (out-of-band state changes
  // like the cut clipboard; navigation does not force). ---
  const renderGrid = async (force = false): Promise<void> => {
    const scroller = ctx.scroller();
    if (!scroller) return;
    const gen = ++gridGen;
    // cancel any in-flight recursive search: the previous query's fd walk must
    // not keep running behind this render (navigate/clear/retype all land here)
    searchAbort?.abort();
    searchAbort = null;
    const state = ctx.state;
    // selection must survive rebuilds by path — a busy cwd (and /tmp on this
    // box, which contains our own dnd log) re-renders constantly; wiping it
    // made selection vanish mid-interaction. Vanished files drop naturally:
    // restore only touches keys still present in the new tile set.
    const prevSel = new Set<string>();
    selection.tileRefs.forEach((r, k) => {
      if (r.selected) prevSel.add(k);
    });
    const prevFocusKey = selection.focusKeys()[selection.focusIdx()] ?? null;
    const anchorIdx = selection.selAnchor();
    const prevAnchorKey = anchorIdx === null ? null : (selection.focusKeys()[anchorIdx] ?? null);
    // a rebuild destroys the edit input; dropped once we actually rebuild (a
    // skipped render leaves an in-progress rename/edit alone)
    const q = ctx.searchQuery().trim().toLowerCase();
    // recursive search replaces the listing with subtree matches; virtual
    // places have no fs root to walk, so they keep the in-dir filter
    const recursive = q.length > 0 && ctx.recursiveSearch() && state.cwd !== RECENT_URI && state.cwd !== STARRED_URI;
    // Signature of everything that affects the painted tiles. renderAll repaints
    // BOTH panes on any navigation, so without this a move in one pane visibly
    // rebuilds the other (and churns native buffers). Empty/error states sign
    // separately; theme/geometry/search changes move the signature too.
    const sigOf = (list: Entry[] | string): string =>
      JSON.stringify([
        state.cwd,
        state.showHidden,
        state.sortBy,
        state.sortAsc,
        ctx.viewMode(),
        ctx.wordWrap(),
        ctx.tileW(),
        ctx.tileH(),
        ctx.iconCells(),
        ctx.termW(),
        ctx.termH(),
        ctx.availW?.() ?? 0,
        q,
        recursive,
        ctx.pathEditMode(),
        ctx.tileIdPrefix ?? "",
        state.pendingSelect ?? "",
        ctx.colors(),
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.size ?? ""}\u0000${e.mtimeMs ?? ""}`),
      ]);
    // content-only signature: what the animation keys off (the listed files +
    // how they're shown), WITHOUT geometry/theme — layout-only rebuilds keep it
    const contentSigOf = (list: Entry[] | string): string =>
      JSON.stringify([
        state.cwd,
        state.showHidden,
        state.sortBy,
        state.sortAsc,
        ctx.viewMode(),
        ctx.wordWrap(),
        q,
        recursive,
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.size ?? ""}\u0000${e.mtimeMs ?? ""}`),
      ]);
    let allEntries: Entry[];
    try {
      if (recursive) {
        const ac = new AbortController();
        searchAbort = ac;
        // honor the show-hidden toggle: skipping hidden dirs keeps fd out of
        // .git/.cache, which dominate the walk on large trees
        allEntries = await (ctx.searchTree ?? searchTree)(state.cwd, q, {
          hidden: state.showHidden,
          signal: ac.signal,
        });
        // release the slot only if a newer render didn't already replace it
        if (searchAbort === ac) searchAbort = null;
        // stable display: name order, dirs first
        allEntries.sort(compareEntries("name", true));
      } else {
        allEntries = await listDir(state.cwd, state.showHidden, state.sortBy, state.sortAsc);
      }
    } catch (err) {
      // restricted dir (/root, foreign 000 dirs): say why instead of a blank pane
      if (gen !== gridGen) return;
      const sig = sigOf(`err:${fsErrText(err)}`);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      ctx.clearRenameEdit();
      clearGrid();
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      buildEmptyPane("close", [
        `can't open this folder (${fsErrText(err)})`,
        ctx.pathEditMode() ? "" : "edit the path above to go elsewhere",
      ]);
      lastContentSig = contentSigOf(`err:${fsErrText(err)}`);
      ctx.stripSelectable();
      // no tiles to navigate: clear the old listing's nav geometry or arrows
      // consume keys against a phantom list (focusKeys still holds the previous
      // folder's paths with emptied tileRefs)
      selection.setFocusKeys([]);
      selection.setCols(1);
      selection.setRowH(ctx.viewMode() === "list" ? rowH() : ctx.tileH());
      void ctx.drainIconQueue();
      return;
    }
    const isList = ctx.viewMode() === "list";
    const entries = q && !recursive ? allEntries.filter((e) => e.name.toLowerCase().includes(q)) : allEntries;
    if (gen !== gridGen) return;

    if (entries.length === 0) {
      const sig = sigOf("empty");
      if (!force && sig === lastSig) return;
      lastSig = sig;
      ctx.clearRenameEdit();
      clearGrid();
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      buildEmptyPane("folder", [
        q
          ? "no matches"
          : state.cwd === RECENT_URI
            ? "no recent files"
            : state.cwd === STARRED_URI
              ? "nothing starred yet"
              : "this folder is empty",
      ]);
      lastContentSig = contentSigOf("empty");
      // no tiles to navigate: drop the previous listing's focusKeys/cols/rowH
      selection.setFocusKeys([]);
      selection.setCols(1);
      selection.setRowH(isList ? rowH() : ctx.tileH());
      void ctx.drainIconQueue();
      return;
    }

    // list view always shows size + modified columns, so fetch whatever stats
    // the active sort mode didn't already populate BEFORE signing (a size/mtime
    // change must move the signature)
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

    const sig = sigOf(entries);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    ctx.clearRenameEdit();
    clearGrid();
    await ctx.waitForResolution();
    if (gen !== gridGen) return;
    const { aspect } = ctx.cellMetrics();
    const TILE_H = ctx.tileH();
    const cols = isList ? 1 : Math.max(1, Math.floor((availW() - 3) / ctx.tileW()));

    // one container wraps every row so `slide` can shift the whole grid with a
    // single render-only translateY instead of touching each image tile
    const innerId = `${tilePrefix()}inner`;
    const inner = Box({ id: innerId, width: "100%", flexDirection: "column" });

    let tileIdx = 0;
    if (isList) {
      for (const e of entries) inner.add(buildListRow(e, tileIdx++));
    } else {
      for (let i = 0; i < entries.length; i += cols) {
        const row = Box({ height: TILE_H, flexDirection: "row" });
        for (const e of entries.slice(i, i + cols)) row.add(buildTile(aspect, e, tileIdx++));
        inner.add(row);
      }
    }
    scroller.content.add(inner);

    // cut (pending-move) tiles render dimmed; apply after mount so id lookups work
    selection.tileRefs.forEach((_: any, key: string) => {
      if (ctx.isCutKey(key)) selection.setTileVisual(key, TileVisual.Rest);
    });

    // fresh Text nodes default selectable=true; strip AFTER the async rebuild or
    // the renderer's text-selection drag hijacks file-drag events
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
    selection.setFocusKeys([...selection.tileRefs.keys()]);
    // restore the pre-rebuild selection/focus by path (stale gen = newer
    // render owns the refs — never restore into it)
    if (gen !== gridGen) return;
    selection.tileRefs.forEach((ref, key) => {
      if (prevSel.has(key)) {
        ref.selected = true;
        selection.setTileVisual(key, TileVisual.Selected);
      }
    });
    const focusKeyIdx = prevFocusKey ? selection.focusKeys().indexOf(prevFocusKey) : -1;
    selection.setFocusIdx(focusKeyIdx);
    const anchorNewIdx = prevAnchorKey === null ? -1 : selection.focusKeys().indexOf(prevAnchorKey);
    selection.setSelAnchor(anchorNewIdx < 0 ? null : anchorNewIdx);
    selection.setCols(cols);
    selection.setRowH(isList ? rowH() : TILE_H);
    // one-shot launch-file highlight (`tfm some/file.txt`): after the first
    // build, select the tile whose key is that path, then clear the request
    if (state.pendingSelect) {
      const pending = state.pendingSelect;
      state.pendingSelect = null;
      const idx = selection.focusKeys().indexOf(pending);
      if (idx >= 0) selection.selectTileAt(idx);
    }
    selection.updateSelectionStatusReal();
    // animate the new tiles in (tileRefs is in display order); the animator
    // reads [ui] file-animation live and snaps everything to rest when off.
    // Only a CONTENT change animates — a layout-only rebuild (hover drawer,
    // dual-pane toggle, resize, theme flip) rebuilt the same files and must
    // not replay it.
    if (gen === gridGen) {
      const contentSig = contentSigOf(entries);
      const contentChanged = lastContentSig !== null && contentSig !== lastContentSig;
      lastContentSig = contentSig;
      if (contentChanged) {
        try {
          ctx.fileAnim({ tiles: [...selection.tileRefs.values()].map((r) => r.tileId), inner: innerId });
        } catch {}
      }
    }
  };

  return { renderGrid };
};
