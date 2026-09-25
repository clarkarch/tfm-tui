// --- Shared grid contract: the pane state the grid paints and the ctx seam it
// receives. A LEAF on purpose (types only, no value imports): ui-grid, its row
// builders and its window math all need this shape, and keeping it here means
// those three can import it without a cycle back into ui-grid. ---

import type { Theme } from "../config/config";
import type { ScrollerLike } from "../lib/node-like";
import type { HoverLiftOpts } from "../config/config-schema";
import type { Entry } from "../fs/listing";
import type { TileMouseHandlers } from "../input/grid-input";
import type { Selection } from "../input/selection";
import type { SortMode } from "../lib/sort";
import type { Scheduler } from "../lib/uiutil";
import type { FileAnimMode } from "./ui-grid-anim";
import type { IconSlotHandle, IconState, ThumbJob } from "./ui-slots";
import type { UiStyle } from "./style";

export type GridState = {
  cwd: string;
  showHidden: boolean;
  sortBy: SortMode;
  sortAsc: boolean;
  // one-shot: a launch FILE path to highlight after the first build (set by
  // the CLI, consumed + cleared here)
  pendingSelect?: string | null;
};

export type GridRendererCtx = {
  termW(): number;
  termH(): number;
  scroller(): ScrollerLike | null;
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
  // raster-affecting state ([ui] icons + tty mode + force-glyph): tiles paint a
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
  makeIconSlot(name: string, states: IconState[], heightCells?: number, initialState?: number): IconSlotHandle;
  pushThumbJob(job: ThumbJob): void;
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
  // [ui] loading-delay-ms: how long a listing may take before the pane swaps
  // to a "loading…" placeholder instead of keeping the PREVIOUS folder's tiles
  // on screen (0 = swap immediately, large = never). Absent = feature off, so
  // existing test fakes keep the old "old tiles stay until the new listing
  // lands" behavior.
  loadingDelayMs?(): number;
  // linux console: ASCII spinner frames instead of braille (the console font
  // has no braille block). Optional so test fakes keep working.
  isTtyMode?(): boolean;
  // selection module + mouse handlers
  selection: Selection;
  entryMouseHandlers(entry: Entry, key: string, idx: number): TileMouseHandlers;
  isCutKey(key: string): boolean;
  // misc hooks
  waitForResolution(): Promise<void>;
  clearRenameEdit(): void;
};
