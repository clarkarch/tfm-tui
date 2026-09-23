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
import type { HoverLiftOpts } from "../config/config-schema";
import { fsErrText, isTrashFilesDir } from "../fs/fsutil";
import { fileIsImage, fileIsVideo, fileIconFor } from "../fs/filetype";
import { canThumbVideo } from "./icons";
import { sidePadDelta, type UiStyle } from "./style";
import { fmtBytes, pad2 } from "../fs/propsinfo";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { clearChildren } from "../lib/uiutil";
import type { FileAnimMode } from "./ui-grid-anim";
import type { Scheduler } from "../lib/uiutil";
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
  // hover lift headroom at build time: flags tiles with one spare cell for
  // the lift direction so the hovered tile can nudge without landing on
  // chrome or a wrapped label.
  hoverLiftOpts?(): HoverLiftOpts;
  listRowH(): number;
  uiStyle(): UiStyle;
  colors(): Theme;
  previewEnabled(): boolean;
  previewWidth(): number;
  viewMode(): "grid" | "list";
  // raster-affecting state ([ui] icons + compat + force-glyph): tiles paint a
  // raster or a bare glyph without the listing changing, so without this the
  // rebuild early-outs and a graphics-mode toggle visibly does nothing until
  // restart. Deliberately OUT of contentSigOf: a mode flip rebuilds silently
  // instead of replaying the intro cascade. Optional so test fakes keep working.
  rasterSig?(): string;
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
  // in-place stat-cell repaint for stats-only ticks (list view size/date Text
  // nodes carry `${rowId}-size` / `${rowId}-date` ids); absent in old fakes, so
  // the fast path stays off there and behavior is unchanged
  setTextOnId?(id: string, s: string): void;
  // row-build failure sink (a throwing row degrades to a placeholder, never a
  // blank grid); optional so test fakes keep working, wiring passes dlog
  log?(msg: string): void;
  // clock for the play-cooldown gate (tests drive a virtual one); production
  // reads wall time. Optional so existing fakes keep working.
  now?(): number;
  // animate the freshly built tiles/rows in ([ui] file-animation); no-op on
  // "off". `inner` is the single container node slide animates; passing an
  // empty target stops any in-flight animation (called before clearGrid).
  // `total` is the full file count when `tiles` is capped (visible-only);
  // `rows`/`rowsTotal` are the grid-view row boxes for the row-granularity
  // cascade (empty in list view — its rows ARE the tiles).
  fileAnim(target: {
    tiles: string[];
    rows?: string[];
    rowsTotal?: number;
    inner?: string | null;
    total?: number;
    enterFrom?: "top" | "bottom";
  }): FileAnimMode;
  // [ui] file-animation-visible-only: hand only the tiles on screen to the
  // animator (off-screen ones would cost a native opacity push each per frame)
  fileAnimVisibleOnly(): boolean;
  // scroll-reveal: animate the rows a window slide just mounted (rides the
  // file-animation master; no-op while that is off). Always on while the
  // grid is windowed — syncWindow only runs on windowed builds.
  // [ui] file-animation-scroll-reveal-delay-ms: settle window before the
  // reveal plays (0 = play every notch, like before). Virtual-clock seam:
  // tests drive `sched`, production uses real timers.
  fileAnimScrollRevealDelayMs?(): number;
  sched?: Scheduler;
  // [ui] windowed-grid: build only the visible row window (± overscan) and
  // slide it on scroll. Optional so existing test fakes keep the full-build
  // contract; the real default lives in config-schema (on).
  windowedGrid?(): boolean;
  // an inline rename/create edit is live on a tile node — a window slide must
  // never destroy it (the watcher/hover-drawer skip rebuilds the same way;
  // commit/cancel rebuilds or the next scroll notch lands the slide)
  isRenaming?(): boolean;
  // [ui] listings-cache: reuse the folder's raw entry list across repaints
  // (src/fs/listing.ts); optional so test ctxs keep working, default = on
  listingsCache?(): boolean;
  // [ui] listings-cache-stats / listings-cache-ttl (ms; config stores seconds)
  listingsCacheStats?(): boolean;
  listingsCacheTtlMs?(): number;
  // selection module + mouse handlers
  selection: Selection;
  entryMouseHandlers(entry: Entry, key: string, idx: number): any;
  isCutKey(key: string): boolean;
  // misc hooks
  waitForResolution(): Promise<void>;
  clearRenameEdit(): void;
};

// ONE viewport window for both the thumbnail drain ranking and the file
// animation cap — they must agree, or a tile the animator skipped is also
// (worse) not the one the thumb worker treats as urgent. `+1` row of slack
// covers the partially visible one at the bottom. Pure, so both call sites
// (and the test) read the same math.
export const visibleTileCap = (termH: number, rowH: number, cols: number): number =>
  cols * (Math.floor(termH / rowH) + 1);

// the bottom VISIBLE row for a scroll offset — overlap-based, not full-row
// math: a row counts the moment its TOP cell enters the viewport.
// firstRow + floor(visH/rowH) waits until the row fits whole, delaying the
// bottom scroll-reveal by up to rowH-1 cells. The -1 keeps exact alignment
// from counting the next row (scrollTop=0, visH=10, rh=5 → rows 0..1, not 2).
export const visibleBottomRow = (scrollTop: number, visH: number, rowHgt: number, rows: number): number => {
  if (rows <= 0) return -1;
  if (!(rowHgt > 0)) return rows - 1;
  if (!(visH > 0)) return Math.max(0, Math.min(rows - 1, Math.floor(Math.max(0, scrollTop) / rowHgt)));
  return Math.max(0, Math.min(rows - 1, Math.floor((Math.max(0, scrollTop) + visH - 1) / rowHgt)));
};

// minimum gap between two entry-animation waves in the SAME listing context;
// a faster rebuild still repaints, it just doesn't restart the wave (see
// lastPlayAt). Keyed on cwd/query/sort/view — navigating to a different folder
// is a new intro, not a storm, and must animate immediately.
export const PLAY_COOLDOWN_MS = 500;

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
    const n = next[i]!;
    const p = prev[i]!;
    const nEligible = thumbEligible(n);
    if (nEligible !== thumbEligible(p)) return true;
    if (!nEligible) continue;
    if (p.size !== n.size || p.mtimeMs !== n.mtimeMs) return true;
  }
  return false;
};

// rows of built-but-unseen slack above/below the viewport in windowed mode —
// the scroll hook fires on EVERY integer row scroll, so this only absorbs
// partial-row wheels; a fling past it just slides the window (incremental —
// visible rows are never destroyed)
const WINDOW_OVERSCAN = 1;

// the windowed row range for a scroll offset — pure, used by BOTH the initial
// windowed build and every slide so the two can never drift. firstRow is
// CLAMPED to the row count: a listing that shrinks while scrolled deep
// (mass-delete, watcher rebuild) renders against the still-stale scrollTop
// before the next layout pass re-clamps it — an unclamped window (r0 > r1)
// would build a pads-only pane (a blank flash + a wasted rebuild).
const windowRange = (
  scrollTop: number,
  rowHgt: number,
  rows: number,
  termH: number,
): { firstRow: number; r0: number; r1: number } => {
  const firstRow = Math.max(0, Math.min(Math.floor(scrollTop / rowHgt), rows - 1));
  return {
    firstRow,
    r0: Math.max(0, firstRow - WINDOW_OVERSCAN),
    r1: Math.min(rows - 1, firstRow + Math.floor(termH / rowHgt) + WINDOW_OVERSCAN),
  };
};

// wrap a scroller's `scrollTop` accessor AND its vertical scrollbar's onChange
// so every scroll path notifies the windowed grid. The setter covers wheel
// (ScrollBox does `scrollTop += n`), drag auto-scroll and programmatic
// scrollTo, but a THUMB DRAG bypasses it entirely (ScrollBar's slider writes
// its `_scrollPosition` field raw, then calls the bar's `_onChange` closure
// — ScrollBox.ts wires that to content.translateY only). By `_onChange` run
// time the scrollTop GETTER already reads the new position, so the chained
// callback sees the same value every path does. ScrollBox exposes no scroll
// event; this beats per-frame polling. A single notch can fire onScroll 2-3x
// (setter + the slider re-entrancy in updateSliderFromScrollState + the
// slide's own offset-restore write) — the callback MUST be idempotent;
// syncWindow's range-equality guard makes the repeats free.
export const hookScrollerScroll = (scroller: any, onScroll: () => void): boolean => {
  let hooked = false;
  try {
    const proto = Object.getPrototypeOf(scroller);
    const d = proto && Object.getOwnPropertyDescriptor(proto, "scrollTop");
    if (d && typeof d.set === "function" && !Object.getOwnPropertyDescriptor(scroller, "scrollTop")) {
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: d.get,
        set(value: number) {
          d.set!.call(this, value);
          try {
            onScroll();
          } catch {}
        },
      });
      hooked = true;
    }
  } catch {}
  try {
    const bar = scroller?.verticalScrollBar;
    if (bar && typeof bar._onChange === "function") {
      const orig = bar._onChange.bind(bar);
      bar._onChange = (position: number) => {
        orig(position);
        try {
          onScroll();
        } catch {}
      };
      hooked = true;
    }
  } catch {}
  return hooked;
};

export const makeGridRenderer = (ctx: GridRendererCtx) => {
  let gridGen = 0;
  // signature of the last painted tile set — an unchanged pane skips the
  // clear+rebuild (renderAll repaints both panes on any navigation)
  let lastSig = "";
  // Animation gate: rebuilds also fire for pure layout/geometry changes (hover
  // drawer collapse, dual-pane toggle, resize, theme flip) which must NOT replay
  // the entry animation — the tiles rebuilt for the same files, they didn't
  // appear. Only a content change (cwd/list/query/sort/view) animates.
  let lastContentSig: string | null = null;
  // Stats-only fast path (busy-log dirs): membership+order without size/mtime,
  // plus a stats snapshot for the thumb guard. A tick that moves only stats
  // repaints the list stat cells in place — no clear+rebuild, no anim replay.
  let lastStructuralSig: string | null = null;
  let lastEntries: Entry[] | null = null;
  // storm coalescing: a rebuild storm (rotation bursts on a slow VT) must not
  // restart the entry wave per rebuild — a wave that never completes reads as
  // invisible files. Plays inside the cooldown after the previous play are
  // skipped (the grid still rebuilds; only the animation is dropped). Keyed on
  // the listing CONTEXT (cwd/query/sort/view): navigating within the cooldown
  // is a new folder intro, not a storm, and must animate.
  let lastPlayAt: number | null = null;
  let lastPlayKey: string | null = null;
  // in-flight recursive search; a newer render aborts it so stale keystroke
  // walks don't keep eating disk while a fresh query runs
  let searchAbort: AbortController | null = null;
  // last windowed build (null = full build / nothing painted): the cached
  // entry list + row range syncWindow() slides against — a slide NEVER
  // re-lists, it rebuilds rows from this snapshot
  let win: {
    entries: Entry[];
    isList: boolean;
    cols: number;
    rowH: number;
    rows: number;
    r0: number;
    r1: number;
    // last synced VISIBLE row range (the build window leads it by the
    // overscan row) — the scroll-reveal fires on rows crossing THIS, not the
    // build edge, or every reveal would animate off-screen and arrive settled
    vis: { top: number; bottom: number };
  } | null = null;
  // [ui] file-animation-scroll-reveal-delay-ms: deferred reveal state. A fast
  // fling crosses a row per notch; playing every notch retriggers the wave
  // mid-flight (nothing completes visibly) and pays native pushes per frame.
  // Each slide MERGES its crossing into a pending set and re-arms a trailing
  // timer — one play per pause, over the union. The timer is DROPPED (never
  // flushed) on clearGrid/fallback, so a stale play can never stop() the new
  // folder's intro wave after a navigate or a fling landing.
  let revealTimer: unknown = null;
  let pendingReveal: { rows: string[]; tiles: string[]; from: "top" | "bottom"; staged: any[] } | null = null;
  const cancelPendingReveal = (): void => {
    const sched: Scheduler = ctx.sched ?? globalThis;
    if (revealTimer) {
      try {
        sched.clearTimeout(revealTimer);
      } catch {}
      revealTimer = null;
    }
    // staged rows sit at frame-0 opacity waiting for a wave that will now
    // never come — put them back to rest, or they stay invisible until the
    // next rebuild. On fallback/clearGrid the nodes are already dead or
    // dying; the try/catch makes that a harmless no-op.
    const staged = pendingReveal?.staged ?? [];
    pendingReveal = null;
    for (const n of staged) {
      try {
        n.opacity = 1;
      } catch {}
    }
  };
  const flushReveal = (): void => {
    revealTimer = null;
    const p = pendingReveal;
    pendingReveal = null;
    if (!p || (p.rows.length === 0 && p.tiles.length === 0)) return;
    let mode: FileAnimMode = null;
    try {
      mode = ctx.fileAnim({
        tiles: p.tiles,
        rows: p.rows,
        rowsTotal: p.rows.length,
        total: p.tiles.length,
        enterFrom: p.from,
      });
    } catch {}
    // Reconcile the mount-time ROW staging with the set the animator
    // actually drives: "rows" keeps the staged rows (the wave fades
    // exactly them in — releasing here would blink them to rest).
    // Anything else releases: "tiles" rides the row-granularity knob off
    // (a row at opacity 0 would hide per-file children — the tiles
    // self-stage via play's frame-0 pass, same as the delay-0 path),
    // null = no wave at all (master off / maxFiles skip — without this
    // the rows would strand invisible until the next rebuild).
    if (mode !== "rows") {
      for (const n of p.staged) {
        try {
          n.opacity = 1;
        } catch {}
      }
    }
  };
  const { selection } = ctx;
  const tilePrefix = (): string => ctx.tileIdPrefix ?? "tfm-tile-";
  const availW = (): number => (ctx.availW ? ctx.availW() : ctx.termW() - ctx.sw() - ctx.reservedRight());

  // list-view row density, clamped to what the builders can render
  const rowH = (): number => Math.min(3, Math.max(1, ctx.listRowH()));

  const clearGrid = (): void => {
    // a pending deferred reveal belongs to the OLD listing — drop it before
    // anything else, or its late fire stops the new folder's intro wave
    cancelPendingReveal();
    const scroller = ctx.scroller();
    if (!scroller) return;
    win = null;
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
        fallbackGlyph: glyph[fileIconFor(entry.name)] ?? glyph.file!,
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
    if (isList) return buildListRow(entries[r]!, r, inViewport(r));
    const row = Box({ id: `${tilePrefix()}row-${r}`, height: rowHgt, flexDirection: "row" });
    for (let i = r * cols; i < Math.min((r + 1) * cols, entries.length); i++) {
      row.add(buildTile(aspect, entries[i]!, i, inViewport(i)));
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

  // the scroller's LIVE viewport in cell rows — NOT ctx.termH(): chrome
  // (toolbar/tabs/status) eats several terminal rows, so the full height
  // overstates how many grid rows are on screen (the bottom reveal fired a
  // row early, off-screen — the "only the top animates" bug). The ScrollBox
  // clamps scroll against this same number (updateStickyState).
  const visH = (scroller: any): number => {
    const vh = scroller?.viewport?.height;
    return typeof vh === "number" && vh > 0 ? vh : ctx.termH();
  };

  // empty-pane icon follows the place: virtual places and the trash show
  // their sidebar icon (clock/star/trash-can) instead of the generic folder,
  // and a fruitless search shows the search icon
  const emptyPaneIcon = (cwd: string, hasQuery: boolean): string =>
    hasQuery
      ? "search"
      : cwd === RECENT_URI
        ? "clock"
        : cwd === STARRED_URI
          ? "star"
          : isTrashFilesDir(cwd)
            ? "trash-can"
            : "folder";

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
    const baseSigParts = (): unknown[] => [
      state.cwd,
      state.showHidden,
      state.sortBy,
      state.sortAsc,
      ctx.viewMode(),
      ctx.wordWrap(),
      ctx.tileW(),
      ctx.tileH(),
      ctx.iconCells(),
      (() => {
        const o = ctx.hoverLiftOpts?.();
        // includeLabel rides live in the animator — no rebuild needed
        return JSON.stringify([o?.enabled ?? false, o?.direction ?? "up"]);
      })(),
      ctx.termW(),
      ctx.termH(),
      ctx.availW?.() ?? 0,
      q,
      recursive,
      ctx.pathEditMode(),
      ctx.tileIdPrefix ?? "",
      state.pendingSelect ?? "",
      // a windowed-grid flip changes which nodes exist — must rebuild; so
      // does list-row-height (the list builders read rowH() live, and the
      // win cache/anim window math must not lag it)
      ctx.windowedGrid?.() ?? false,
      ctx.listRowH(),
      ctx.colors(),
      ctx.rasterSig?.() ?? "",
    ];
    const sigOf = (list: Entry[] | string): string =>
      JSON.stringify([
        ...baseSigParts(),
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.size ?? ""}\u0000${e.mtimeMs ?? ""}`),
      ]);
    // membership + order WITHOUT size/mtime — and WITH isDir, which the full
    // signature never carried (a symlink retarget dir↔file with identical
    // stats wrongly skipped the rebuild before). A tick that moves this
    // rebuilds; one that moves only stats takes the in-place fast path.
    const structOf = (list: Entry[] | string): string =>
      JSON.stringify([
        ...baseSigParts(),
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.isDir ? 1 : 0}`),
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
        allEntries = await listDir(state.cwd, state.showHidden, state.sortBy, state.sortAsc, {
          cache: ctx.listingsCache?.() ?? true,
          cacheStats: ctx.listingsCacheStats?.() ?? true,
          ttlMs: ctx.listingsCacheTtlMs?.(),
        });
      }
    } catch (err) {
      // restricted dir (/root, foreign 000 dirs): say why instead of a blank pane
      if (gen !== gridGen) return;
      const sig = sigOf(`err:${fsErrText(err)}`);
      if (!force && sig === lastSig) return;
      lastSig = sig;
      lastStructuralSig = structOf(`err:${fsErrText(err)}`);
      lastEntries = null;
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
      lastStructuralSig = structOf("empty");
      lastEntries = null;
      ctx.clearRenameEdit();
      clearGrid();
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      buildEmptyPane(emptyPaneIcon(state.cwd, q.length > 0), [
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
    // stats-only tick (busy-log dirs): same membership + order, only size/mtime
    // moved — repaint the list stat cells in place instead of clear+rebuild
    // (the TTY full-flash loop). No animation: nothing appeared. Skipped when
    // the seam is absent (old fakes keep the rebuild), when a thumbnailed
    // image/video changed stats (its raster keys on them — rebuild re-queues),
    // and under force (cut-clipboard dimming needs the rebuild).
    if (!force && ctx.setTextOnId && lastStructuralSig !== null) {
      const structural = structOf(entries);
      if (structural === lastStructuralSig && !thumbStatsChanged(lastEntries, entries)) {
        lastSig = sig;
        lastContentSig = contentSigOf(entries);
        lastEntries = entries.map((e) => ({ ...e }));
        // later window slides build rows from this snapshot — carry the stats
        if (win) {
          for (let i = 0; i < win.entries.length && i < entries.length; i++) {
            win.entries[i]!.size = entries[i]!.size;
            win.entries[i]!.mtimeMs = entries[i]!.mtimeMs;
          }
        }
        if (isList) {
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i]!;
            ctx.setTextOnId(`${tilePrefix()}${i}-size`, e.isDir ? "" : fmtBytes(e.size ?? 0).padStart(9));
            ctx.setTextOnId(`${tilePrefix()}${i}-date`, fmtDateShort(e.mtimeMs));
          }
        }
        return;
      }
    }
    lastSig = sig;
    lastStructuralSig = structOf(entries);
    lastEntries = entries.map((e) => ({ ...e }));
    ctx.clearRenameEdit();
    clearGrid();
    await ctx.waitForResolution();
    if (gen !== gridGen) return;
    const TILE_H = ctx.tileH();
    const cols = isList ? 1 : Math.max(1, Math.floor((availW() - 3) / ctx.tileW()));
    const rowHgt = isList ? rowH() : TILE_H;
    const totalRows = isList ? entries.length : Math.ceil(entries.length / cols);

    // [ui] windowed-grid: build only the visible row window (+overscan); the
    // scroller scroll hook slides it. A windowed build costs O(screen) nodes
    // no matter the folder size; a plain build stays byte-identical to before.
    const windowed = ctx.windowedGrid?.() ?? false;
    const scrollTop = Math.max(0, scroller.scrollTop ?? 0);
    const { firstRow, r0: wr0, r1: wr1 } = windowRange(scrollTop, rowHgt, totalRows, ctx.termH());
    const r0 = windowed ? wr0 : 0;
    const r1 = windowed ? wr1 : totalRows - 1;
    // viewport window for thumb-job ranking: `visibleTileCap` tiles starting
    // wherever the scroller sits (a hover-drawer settle rebuilds mid-scroll;
    // a folder change always starts at 0) — visible thumbs raster FIRST,
    // off-screen backlog last, so the first screenful lands before the tail
    const visFirst = isList ? firstRow : firstRow * cols;
    // register EVERY entry first — the full tileRefs/focusKeys list is the
    // selection's contract; built rows overwrite their minimal ref in place.
    for (let i = 0; i < entries.length; i++) registerRef(entries[i]!, i);

    // the container `slide` animates (and holds the row window + pads) — its
    // id is absolute so it resolves across slides
    const innerId = `${tilePrefix()}inner`;
    scroller.content.add(buildInner(entries, isList, cols, rowHgt, totalRows, r0, r1, visFirst, windowed));
    win = windowed
      ? {
          entries,
          isList,
          cols,
          rowH: rowHgt,
          rows: totalRows,
          r0,
          r1,
          vis: { top: firstRow, bottom: visibleBottomRow(scrollTop, visH(scroller), rowHgt, totalRows) },
        }
      : null;
    // grid-view ROW ids for the row-granularity cascade (see the handoff
    // below): the FULL absolute list — un-built windowed rows resolve to
    // nothing in the animator but keep the cascade timing aligned by index.
    const rowIds: string[] = isList ? [] : Array.from({ length: totalRows }, (_, r) => `${tilePrefix()}row-${r}`);

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
    // not replay it. The very first build (lastContentSig null) IS content
    // appearing, so it animates — that's the boot intro.
    if (gen === gridGen) {
      const contentSig = contentSigOf(entries);
      const contentChanged = lastContentSig === null || contentSig !== lastContentSig;
      lastContentSig = contentSig;
      if (contentChanged) {
        // storm gate: a rebuild inside the cooldown after the previous wave
        // repaints but doesn't restart it — overlapping waves on a slow VT
        // never complete and read as invisible files. The stop call in
        // clearGrid above already ran, so nothing in-flight is stranded.
        // A DIFFERENT listing context (navigation/query/sort/view) is a new
        // intro, not a storm: it plays regardless of the cooldown.
        const playKey = `${state.cwd}\u0000${q}\u0000${state.sortBy}\u0000${state.sortAsc}\u0000${state.showHidden ? 1 : 0}\u0000${ctx.viewMode()}\u0000${recursive ? 1 : 0}`;
        const t = ctx.now ? ctx.now() : Date.now();
        if (playKey === lastPlayKey && lastPlayAt !== null && t - lastPlayAt < PLAY_COOLDOWN_MS) return;
        lastPlayAt = t;
        lastPlayKey = playKey;
        try {
          const ids = [...selection.tileRefs.values()].map((r) => r.tileId);
          // visible-only: off-screen tiles are never seen animating but each
          // per-frame opacity change costs a native push — cap the list to the
          // viewport (same window math as the thumb ranking) and keep the full
          // count for the cascade timing (the animator normalizes by `total`).
          // The slice starts at the SCROLL position (visFirst), not 0 — the old
          // head-slice animated off-screen top tiles while the visible ones
          // (scrolled deep into a big folder) never animated at all. With the
          // knob off, everything animates (both tiles and rows) — a mid-scroll
          // content change then animates the whole grid.
          const visibleOnly = ctx.fileAnimVisibleOnly();
          const cap = visibleOnly ? visibleTileCap(ctx.termH(), isList ? rowH() : TILE_H, cols) : ids.length;
          // list view: rows ARE tiles, hand none (the animator uses tiles);
          // grid view: slice rows with the same scroll-aligned window
          const rows = isList
            ? []
            : visibleOnly
              ? rowIds.slice(Math.floor(visFirst / cols), Math.floor(visFirst / cols) + Math.ceil(cap / cols))
              : rowIds;
          ctx.fileAnim({
            tiles: ids.slice(visibleOnly ? visFirst : 0, (visibleOnly ? visFirst : 0) + cap),
            rows,
            rowsTotal: rowIds.length,
            inner: innerId,
            total: ids.length,
          });
        } catch {}
      }
    }
  };

  // [ui] windowed-grid slide: the wiring's scroller hook calls this after
  // EVERY scrollTop write (wheel, drag auto-scroll, scrollbar thumb drag,
  // keyboard scrollTo). INCREMENTAL is the whole point: rows that merely left
  // or entered the window are removed/added and the pads absorb the shift, so
  // a visible row's node NEVER dies mid-scroll — a full clear+rebuild here
  // would re-queue every icon slot through its fallback glyph on each notch
  // (the flicker this replaced). Only a fling PAST the built window rebuilds
  // it whole. Refs/focus/keys are untouched either way — the selection's
  // full-list contract holds across slides. No-op while the last build was a
  // full one (nothing to slide).
  const syncWindow = (): void => {
    if (!win) return;
    if (ctx.isRenaming?.()) return;
    const scroller = ctx.scroller();
    if (!scroller) return;
    const { entries, isList, cols, rowH: rh, rows } = win;
    const old = { r0: win.r0, r1: win.r1 };
    const scrollTop = Math.max(0, scroller.scrollTop ?? 0);
    const { firstRow, r0, r1 } = windowRange(scrollTop, rh, rows, ctx.termH());
    const visFirst = isList ? firstRow : firstRow * cols;
    // operate on the MOUNTED nodes (VNode proxies no-op post-mount): content
    // holds exactly [inner], inner exactly [pad-top, old.r0..old.r1, pad-bottom]
    const inner: any = scroller.content.getChildren()[0];
    const kids: any[] | null = inner && r0 <= old.r1 + 1 && r1 >= old.r0 - 1 ? inner.getChildren() : null;
    const slideable = !!kids && kids.length === old.r1 - old.r0 + 3;
    const paint = (a: number, b: number): void => {
      if (a > b) return;
      const lo = isList ? a : a * cols;
      const hi = Math.min(entries.length - 1, isList ? b : (b + 1) * cols - 1);
      for (let i = lo; i <= hi; i++) {
        const key = entryKey(entries[i]!);
        const ref = selection.tileRefs.get(key);
        if (ref?.selected) selection.setTileVisual(key, TileVisual.Selected);
        else if (ctx.isCutKey(key)) selection.setTileVisual(key, TileVisual.Rest);
      }
    };
    // a sub-row notch leaves the built window in place but can still push a
    // partially visible row's TOP cell into view — the reveal below must run
    // for those too, not just for slides (the range-equality repeats stay
    // free: identical vis ranges cross nothing, so the animator is untouched)
    const windowMoved = r0 !== old.r0 || r1 !== old.r1;
    if (!slideable) {
      if (windowMoved) {
        // the nodes a running animation targets ALL die here — stop it BEFORE
        // destroying them (same use-after-destroy path as clearGrid); a fling
        // shows its landing spot instantly, unrevealed — and any deferred
        // reveal for the jumped-over rows is dropped, never flushed late
        cancelPendingReveal();
        try {
          ctx.fileAnim({ tiles: [], inner: null });
        } catch {}
        clearChildren(scroller.content);
        scroller.content.add(buildInner(entries, isList, cols, rh, rows, r0, r1, visFirst, true));
        paint(r0, r1);
      }
    } else {
      if (windowMoved) {
        const kidAt = (r: number): any => kids[1 + r - old.r0];
        for (let r = old.r0; r < r0; r++) inner.remove(kidAt(r));
        for (let r = old.r1; r > r1; r--) inner.remove(kidAt(r));
        for (let r = r0; r < old.r0; r++) inner.add(buildRow(entries, isList, cols, rh, visFirst, r), 1 + (r - r0));
        for (let r = Math.max(r0, old.r1 + 1); r <= r1; r++)
          inner.add(buildRow(entries, isList, cols, rh, visFirst, r), inner.getChildren().length - 1);
        // pads absorb the shift so the total content height never moves (the
        // offsets above come from the pre-mutation snapshot — node identity,
        // stable across the adds/removes)
        kids[0].height = r0 * rh;
        kids[kids.length - 1].height = (rows - 1 - r1) * rh;
        paint(r0, Math.min(old.r0 - 1, r1));
        paint(Math.max(old.r1 + 1, r0), r1);
      }
    }
    // scroll-reveal: keyed to the VIEWPORT edge, not the build — the window
    // leads visibility by the overscan row, so revealing at build time faded
    // rows off-screen that then arrived already settled (the "reveal doesn't
    // work" bug). Rows crossing into view THIS notch animate now; a fling
    // (fallback rebuild) lands instantly, unrevealed. Always on while the
    // grid is windowed (syncWindow only runs on windowed builds) and gated
    // by the file-animation master inside play().
    // NO stop call around the slide: the animator appends to a still-running
    // wave, and detached-but-alive rows leave it safely (remove() only
    // detaches; writes are try/catch'd until the GC finalizer reclaims them).
    const visTop = firstRow;
    const visBottom = visibleBottomRow(scrollTop, visH(scroller), rh, rows);
    const oldVis = win.vis;
    if (slideable) {
      const crossing: number[] = [];
      let from: "top" | "bottom" | null = null;
      if (visBottom > oldVis.bottom) {
        for (let r = Math.max(oldVis.bottom + 1, r0); r <= Math.min(visBottom, r1); r++) crossing.push(r);
        from = "bottom";
      } else if (visTop < oldVis.top) {
        for (let r = Math.max(visTop, r0); r < Math.min(oldVis.top, r1 + 1); r++) crossing.push(r);
        from = "top";
      }
      if (from && crossing.length > 0) {
        const rvRows: string[] = [];
        const rvTiles: string[] = [];
        for (const r of crossing) {
          if (isList) rvTiles.push(`${tilePrefix()}${r}`);
          else {
            rvRows.push(`${tilePrefix()}row-${r}`);
            for (let i = r * cols; i < Math.min((r + 1) * cols, entries.length); i++)
              rvTiles.push(`${tilePrefix()}${i}`);
          }
        }
        const delay = ctx.fileAnimScrollRevealDelayMs?.() ?? 0;
        if (delay <= 0) {
          try {
            ctx.fileAnim({
              tiles: rvTiles,
              rows: rvRows,
              rowsTotal: rvRows.length,
              total: rvTiles.length,
              enterFrom: from,
            });
          } catch {}
        } else {
          // defer: merge into the pending union (a row can cross, leave and
          // re-cross inside one settle window on zigzag) and re-arm the
          // trailing timer — latest edge wins
          if (!pendingReveal) pendingReveal = { rows: [], tiles: [], from, staged: [] };
          const rowSet = new Set(pendingReveal.rows);
          const tileSet = new Set(pendingReveal.tiles);
          for (const id of rvRows) {
            if (!rowSet.has(id)) {
              rowSet.add(id);
              pendingReveal.rows.push(id);
            }
          }
          for (const id of rvTiles) {
            if (!tileSet.has(id)) {
              tileSet.add(id);
              pendingReveal.tiles.push(id);
            }
          }
          pendingReveal.from = from;
          // pre-stage the crossing rows at frame-0 opacity NOW: the wave
          // plays ~delay ms after they mount, and sitting at rest until
          // then snaps 1→0 on the first tick (visible → invisible →
          // fading = the flicker). Children of inner are [pad-top, rows
          // r0..r1, pad-bottom], so row r lives at index 1+(r-r0) — same
          // contract the slide itself relies on. try/catch: a row missing
          // here simply joins the wave unstaged (one-frame pop, not stuck).
          try {
            const kidsNow: any[] = inner.getChildren();
            for (const r of crossing) {
              const node = kidsNow[1 + (r - r0)];
              if (!node || pendingReveal.staged.includes(node)) continue;
              try {
                node.opacity = 0;
              } catch {
                continue;
              }
              pendingReveal.staged.push(node);
            }
          } catch {}
          const sched: Scheduler = ctx.sched ?? globalThis;
          if (revealTimer) {
            try {
              sched.clearTimeout(revealTimer);
            } catch {}
            revealTimer = null;
          }
          try {
            revealTimer = sched.setTimeout(flushReveal, delay);
          } catch {}
        }
      }
    }
    win = { ...win, r0, r1, vis: { top: visTop, bottom: visBottom } };
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
    // pads keep the content height exact, so the offset survives untouched —
    // restore only after a slide moved the window (matches the io
    // drawer-settle pattern; the nested hook call range-checks equal and
    // returns). An unconditional write would recurse: the hook re-fires
    // syncWindow, which no longer early-returns on equal windows.
    try {
      if (windowMoved) scroller.scrollTop = scrollTop;
    } catch {}
  };

  return { renderGrid, syncWindow };
};
