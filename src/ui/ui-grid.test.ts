import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, type Renderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeGridRenderer, hookScrollerScroll, type GridState } from "./ui-grid";
import { makeSelection } from "../input/selection";
import type { Entry } from "../fs/listing";
import { defaultConfig } from "../config/config-schema";
import type { HoverLiftOpts } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { SortMode } from "../lib/sort";
import type { Scheduler } from "../lib/uiutil";

// Shared virtual clock for the reveal-defer tests (Bun has no fake timers):
// reset() drops strays so timer state never leaks between tests.
let revealClock: { sched: Scheduler; flush: () => void; reset: () => void };
const mkRevealClock = () => {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    sched: {
      setTimeout: (cb: () => void) => {
        const id = ++seq;
        timers.set(id, cb);
        return id;
      },
      clearTimeout: (h: unknown) => {
        timers.delete(h as number);
      },
    } as Scheduler,
    flush: () => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    },
    reset: () => {
      timers.clear();
    },
  };
};

// Headless widget test (createTestRenderer pilot: ui-menu.test.ts). Pins the
// grid renderer's observable contract: painted frames per view mode, the
// tileRefs/focusKeys registration, geometry-driven column math, empty/error
// panes, search filtering, hidden-file gating, thumbnail handoff and cut
// dimming. selection is the REAL module (fake-guard rule: mirror the
// collaborator), grid-input's handler factory is a recorder.

const colors = defaultConfig.theme as Theme & Record<string, any>;
const TERM_W = 80;
const TERM_H = 24;
const SW = 20; // sidebar width
const TILE_W = 10;
const TILE_H = 6;
const ICON_CELLS = 2;
const ASPECT = 0.5;

let t: TestRendererSetup;
let tmp: string;
let content: Renderable;
let scroller: { content: Renderable; scrollTop: number; viewport?: { height: number } };
let gridState: GridState;
let cutKeys: Set<string>;
let iconStateCalls: Array<{ spec: any; idx: number }>;
let thumbJobs: any[];
let iconSlots: Array<{ name: string; heightCells: number; initialState: number }>;
let mouseHandlers: Array<{ name: string; key: string; idx: number }>;
let searchQuery: string;
let wordWrap: boolean;
let recursiveSearch: boolean;
let searchCalls: string[];
let searchSignals: AbortSignal[];
let searchGate: Promise<void> | null;
let searchEntries: Entry[];
let viewMode: "grid" | "list";
let selection: ReturnType<typeof makeSelection>;
let renderGrid: (force?: boolean) => Promise<void>;
let syncWindow: () => void;
let windowedGridOn: boolean;
let renamingOn: boolean;
let availWSet: number | null;
let hoverLiftOpts: HoverLiftOpts;
let tilePrefix: string;
let visibleOnly: boolean;
let revealOn: boolean;
let revealDelayMs: number;
let fileAnimMode: "rows" | "tiles" | "container" | null;
let fileAnimCalls: Array<{
  tiles: string[];
  rows: string[] | null;
  rowsTotal: number | null;
  inner: string | null;
  total: number;
  enterFrom: string | null;
}>;

beforeAll(async () => {
  t = await createTestRenderer({ width: TERM_W, height: TERM_H });
  tmp = mkdtempSync(path.join(os.tmpdir(), "tfm-grid-test-"));
  gridState = { cwd: tmp, showHidden: false, sortBy: "name" as SortMode, sortAsc: true };
  cutKeys = new Set();
  iconStateCalls = [];
  thumbJobs = [];
  iconSlots = [];
  mouseHandlers = [];
  searchQuery = "";
  wordWrap = false;
  recursiveSearch = false;
  searchCalls = [];
  searchSignals = [];
  searchGate = null;
  searchEntries = [];
  viewMode = "grid";
  availWSet = null;
  hoverLiftOpts = { enabled: false, direction: "up", includeLabel: false };
  tilePrefix = "tfm-tile-";
  visibleOnly = false;
  windowedGridOn = false;
  renamingOn = false;
  revealOn = false;
  revealDelayMs = 0;
  fileAnimMode = "rows";
  revealClock = mkRevealClock();
  fileAnimCalls = [];
  let iconSeq = 0;

  t.renderer.root.add(Box({ id: "tfm-scroll-test", flexDirection: "column", flexGrow: 1 }));
  await t.renderOnce();
  content = t.renderer.root.findDescendantById("tfm-scroll-test") as Renderable;

  selection = makeSelection({
    colors: () => colors,
    uiStyle: () => "solid",
    byId: (id) => t.renderer.root.findDescendantById(id),
    setText: () => {},
    setIconState: (spec, idx) => {
      iconStateCalls.push({ spec, idx });
    },
    isCutKey: (key) => cutKeys.has(key),
    scroller: () => null,
    viewH: () => TERM_H - 3,
    rowHInit: () => TILE_H,
    renderPreview: () => {},
  });

  // the grid reads scroller.scrollTop to place its viewport window; a fresh
  // literal per call lets a test dial the scroll offset in
  scroller = { content, scrollTop: 0 };
  const { renderGrid: rg, syncWindow: sw } = makeGridRenderer({
    termW: () => TERM_W,
    termH: () => TERM_H,
    scroller: () => scroller,
    state: gridState,
    searchQuery: () => searchQuery,
    recursiveSearch: () => recursiveSearch,
    searchTree: async (root, q, opts) => {
      searchCalls.push(`${root}|${q}|hidden=${opts?.hidden ?? false}`);
      if (opts?.signal) searchSignals.push(opts.signal);
      if (searchGate) await searchGate;
      return searchEntries;
    },
    pathEditMode: () => false,
    sw: () => SW,
    tileW: () => TILE_W,
    tileH: () => TILE_H,
    iconCells: () => ICON_CELLS,
    hoverLiftOpts: () => hoverLiftOpts,
    listRowH: () => 2,
    uiStyle: () => "solid",
    colors: () => colors,
    previewEnabled: () => false,
    previewWidth: () => 0,
    viewMode: () => viewMode,
    wordWrap: () => wordWrap,
    reservedRight: () => 0,
    // per-pane width: null falls back to termW - sw - reservedRight
    availW: () => availWSet ?? TERM_W - SW,
    get tileIdPrefix() {
      return tilePrefix;
    },
    cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: ASPECT }),
    makeIconSlot: (name: string, states: any, heightCells: number, initialState: number) => {
      iconSlots.push({ name, heightCells, initialState });
      const slotId = `fake-slot-${iconSeq++}`;
      return { el: null, slotId, spec: { slotId, name, heightCells, states, initialState } };
    },
    pushThumbJob: (job: any) => {
      thumbJobs.push(job);
    },
    nextIconId: () => `fake-icon-${iconSeq++}`,
    drainIconQueue: () => {},
    drainThumbs: () => {},
    stripSelectable: () => {},
    fileAnim: (target: {
      tiles: string[];
      rows?: string[];
      rowsTotal?: number;
      inner?: string | null;
      total?: number;
      enterFrom?: "top" | "bottom";
    }) => {
      fileAnimCalls.push({
        tiles: [...target.tiles],
        rows: target.rows ? [...target.rows] : null,
        rowsTotal: target.rowsTotal ?? null,
        inner: target.inner ?? null,
        total: target.total ?? target.tiles.length,
        enterFrom: target.enterFrom ?? null,
      });
      return fileAnimMode;
    },
    fileAnimVisibleOnly: () => visibleOnly,
    fileAnimScrollReveal: () => revealOn,
    fileAnimScrollRevealDelayMs: () => revealDelayMs,
    sched: revealClock.sched,
    windowedGrid: () => windowedGridOn,
    isRenaming: () => renamingOn,
    selection,
    entryMouseHandlers: (e: any, key: string, idx: number) => {
      mouseHandlers.push({ name: e.name, key, idx });
      return {};
    },
    isCutKey: (key) => cutKeys.has(key),
    waitForResolution: () => Promise.resolve(),
    clearRenameEdit: () => {},
  });
  renderGrid = rg;
  syncWindow = sw;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  t.renderer.destroy();
});

describe("renderGrid (grid tiles)", () => {
  test("paints tiles, registers refs/focusKeys/cols, wires mouse handlers", async () => {
    mkdirSync(path.join(tmp, "subdir"));
    writeFileSync(path.join(tmp, "a.txt"), "hello");
    writeFileSync(path.join(tmp, "b.md"), "world");
    await renderGrid();
    await t.renderOnce();

    const frame = t.captureCharFrame();
    expect(frame).toContain("a.txt");
    expect(frame).toContain("b.md");
    expect(frame).toContain("subdir");

    // every entry registered in tileRefs AND focusKeys, same order, abs paths
    expect(selection.tileRefs.size).toBe(3);
    const keys = [...selection.tileRefs.keys()];
    expect(selection.focusKeys()).toEqual(keys);
    expect(keys.every((k) => k.startsWith(tmp))).toBe(true);

    // col math: floor((80 - 20 - 0 - 3) / 10) = 5; row height = TILE_H
    expect(selection.colsAtBuild()).toBe(5);
    expect(selection.rowHAtBuild()).toBe(TILE_H);
    // keyboard state reset at rebuild tail
    expect(selection.focusIdx()).toBe(-1);
    expect(selection.selAnchor()).toBeNull();

    // dirs get the folder icon, files their classifier icon; render order is
    // listDir's (dirs first, then files — compareEntries)
    expect(iconSlots.some((s) => s.name === "folder")).toBe(true);
    expect(mouseHandlers.map((m) => m.name)).toEqual(["subdir", "a.txt", "b.md"]);
    expect(mouseHandlers[0]!.key).toBe(path.join(tmp, "subdir"));
    expect(mouseHandlers[0]!.idx).toBe(0);
  });

  test("per-pane availW drives column math (dual pane halves the width)", async () => {
    availWSet = 30; // floor((30 - 3) / 10) = 2
    await renderGrid();
    expect(selection.colsAtBuild()).toBe(2);
    availWSet = null;
    await renderGrid();
    expect(selection.colsAtBuild()).toBe(5);
  });

  test("tileIdPrefix namespaces generated ids per pane", async () => {
    tilePrefix = "tfm-tile-p1-";
    await renderGrid();
    const ids = [...selection.tileRefs.values()].map((r) => r.tileId);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("tfm-tile-p1-"))).toBe(true);
    tilePrefix = "tfm-tile-";
  });

  test("up lift reserves one top row so the icon never leaves the tile", async () => {
    hoverLiftOpts = { enabled: true, direction: "up", includeLabel: false };
    await renderGrid();
    await t.renderOnce();
    // the icon starts one row lower: the up motion lands exactly on the tile
    // top instead of clipping above it (image rasters clip at the scroller —
    // the reported top-row cutoff)
    for (const ref of selection.tileRefs.values()) {
      if (!ref.hoverLift) continue;
      const tile = t.renderer.root.findDescendantById(ref.tileId) as any;
      expect(tile.getChildren()[0].marginTop || 0).toBe(1);
    }
    expect([...selection.tileRefs.values()].some((r) => r.hoverLift)).toBe(true);

    hoverLiftOpts = { enabled: false, direction: "up", includeLabel: false };
    await renderGrid();
    await t.renderOnce();
    for (const ref of selection.tileRefs.values()) {
      const tile = t.renderer.root.findDescendantById(ref.tileId) as any;
      expect(tile.getChildren()[0].marginTop || 0).toBe(0);
    }
  });

  test("up lift works on the first row too (overpaints nothing — headroom)", async () => {
    availWSet = 30; // 2 cols: idx 0,1 first row, idx 2 second row
    hoverLiftOpts = { enabled: true, direction: "up", includeLabel: false };
    try {
      await renderGrid();
      await t.renderOnce();
      const refs = [...selection.tileRefs.values()];
      expect(refs.length).toBe(3);
      // every tile with spare room lifts — hover works on the top row exactly
      // like every row below it (the headroom keeps the motion inside the tile)
      for (const ref of refs) expect(ref.hoverLift).toBe(true);
    } finally {
      availWSet = null;
      hoverLiftOpts = { enabled: false, direction: "up", includeLabel: false };
      await renderGrid();
    }
  });

  test("hover lift down uses the spare bottom row without a top margin", async () => {
    hoverLiftOpts = { enabled: true, direction: "down", includeLabel: false };
    await renderGrid();
    await t.renderOnce();
    const ref = [...selection.tileRefs.values()][0]!;
    expect(ref.hoverLift).toBe(true);
    const tile = t.renderer.root.findDescendantById(ref.tileId) as any;
    expect(tile.getChildren()[0].marginTop || 0).toBe(0);
    hoverLiftOpts = { enabled: false, direction: "up", includeLabel: false };
    await renderGrid();
  });

  test("a wrapped label consumes the vertical spare: no lift, no headroom", async () => {
    writeFileSync(path.join(tmp, "a-very-long-file-name-that-wraps.txt"), "x");
    wordWrap = true;
    hoverLiftOpts = { enabled: true, direction: "up", includeLabel: false };
    try {
      await renderGrid();
      await t.renderOnce();
      // the wrapped tile keeps the highlight but never lifts (no room) and
      // takes no headroom; single-line tiles still lift with headroom
      let wrapped = 0;
      let lifted = 0;
      for (const [key, ref] of selection.tileRefs) {
        const tile = t.renderer.root.findDescendantById(ref.tileId) as any;
        const margin = tile.getChildren()[0].marginTop || 0;
        if (key.endsWith("a-very-long-file-name-that-wraps.txt")) {
          wrapped++;
          expect(ref.hoverLift).toBe(false);
          expect(margin).toBe(0);
        } else if (ref.hoverLift) {
          lifted++;
          expect(margin).toBe(1);
        }
      }
      expect(wrapped).toBe(1);
      expect(lifted).toBeGreaterThan(0);
    } finally {
      // a red run must not leak the long file / wordWrap flag into the next
      // test (stale grid contents break unrelated counts)
      rmSync(path.join(tmp, "a-very-long-file-name-that-wraps.txt"), { force: true });
      wordWrap = false;
      hoverLiftOpts = { enabled: false, direction: "up", includeLabel: false };
      await renderGrid();
    }
  });

  test("changing the hover lift direction rebuilds the tiles", async () => {
    // tile ids are absolute now (the windowed grid needs them stable across
    // slides), so "it actually rebuilt" is pinned on the layout the direction
    // bakes: an up lift reserves a marginTop row, down/none never do.
    const margins = (): number[] =>
      [...selection.tileRefs.values()].map((r) => {
        const tile = t.renderer.root.findDescendantById(r.tileId) as any;
        return tile?.getChildren()[0]?.marginTop || 0;
      });
    hoverLiftOpts = { enabled: true, direction: "up", includeLabel: false };
    await renderGrid();
    expect(margins()).toContain(1);
    hoverLiftOpts = { enabled: true, direction: "down", includeLabel: false };
    await renderGrid();
    expect(margins()).not.toContain(1);
    hoverLiftOpts = { enabled: false, direction: "up", includeLabel: false };
    await renderGrid();
  });

  test("the first build plays the file animation (boot)", async () => {
    // boot: the very first grid build is content appearing, so it animates —
    // the content-sig gate must not swallow it (regression: lastContentSig
    // started null and null never counted as "changed")
    const bootContent = Box({ flexDirection: "column", flexGrow: 1 });
    const bootAnim: Array<{ tiles: string[]; inner: string | null; total: number }> = [];
    let bootSeq = 0;
    const bootSelection = makeSelection({
      colors: () => colors,
      uiStyle: () => "solid",
      byId: (id) => t.renderer.root.findDescendantById(id),
      setText: () => {},
      setIconState: () => {},
      isCutKey: (key) => cutKeys.has(key),
      scroller: () => null,
      viewH: () => TERM_H - 3,
      rowHInit: () => TILE_H,
      renderPreview: () => {},
    });
    const { renderGrid: bootRender } = makeGridRenderer({
      termW: () => TERM_W,
      termH: () => TERM_H,
      scroller: () => ({ content: bootContent }),
      state: gridState,
      searchQuery: () => "",
      recursiveSearch: () => false,
      pathEditMode: () => false,
      sw: () => SW,
      tileW: () => TILE_W,
      tileH: () => TILE_H,
      iconCells: () => ICON_CELLS,
      hoverLiftOpts: () => hoverLiftOpts,
      listRowH: () => 2,
      uiStyle: () => "solid",
      colors: () => colors,
      previewEnabled: () => false,
      previewWidth: () => 0,
      viewMode: () => viewMode,
      wordWrap: () => false,
      reservedRight: () => 0,
      availW: () => TERM_W - SW,
      tileIdPrefix: "tfm-tile-boot-",
      cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: ASPECT }),
      makeIconSlot: (name: string) => {
        const slotId = `boot-slot-${bootSeq++}`;
        return { el: null, slotId, spec: { slotId, name } };
      },
      pushThumbJob: () => {},
      nextIconId: () => `boot-icon-${bootSeq++}`,
      drainIconQueue: () => {},
      drainThumbs: () => {},
      stripSelectable: () => {},
      fileAnim: (target: { tiles: string[]; inner?: string | null; total?: number }) => {
        bootAnim.push({
          tiles: [...target.tiles],
          inner: target.inner ?? null,
          total: target.total ?? target.tiles.length,
        });
        return "rows" as const;
      },
      fileAnimVisibleOnly: () => visibleOnly,
      selection: bootSelection,
      entryMouseHandlers: () => ({}),
      isCutKey: (key) => cutKeys.has(key),
      waitForResolution: () => Promise.resolve(),
      clearRenameEdit: () => {},
    });
    await bootRender();
    const play = bootAnim.at(-1)!;
    expect(play.tiles.length).toBeGreaterThan(0);
    expect(play.inner).toContain("inner");
  });

  test("hands built tile ids + the container to the file animation sink, but not on a skipped render", async () => {
    fileAnimCalls = [];
    gridState.sortAsc = false; // force a signature change so a real rebuild runs
    await renderGrid();
    const ids = [...selection.tileRefs.values()].map((r) => r.tileId);
    // clearGrid stops the previous animation first, then the rebuild plays
    const play = fileAnimCalls.at(-1)!;
    expect(play.tiles).toEqual(ids);
    expect(play.inner).toContain("inner");
    expect(fileAnimCalls[0]!.tiles).toEqual([]); // the stop call, before clear

    const count = fileAnimCalls.length;
    await renderGrid(); // unchanged signature → no clear/rebuild, no replay
    expect(fileAnimCalls.length).toBe(count);
    gridState.sortAsc = true;
  });

  test("visible-files-only caps the animated list to the viewport; total keeps the true count", async () => {
    // 30 fake entries through the recursive-search seam (no fs writes)
    recursiveSearch = true;
    searchQuery = "f";
    searchEntries = Array.from({ length: 30 }, (_, i) => ({
      name: `file-${String(i).padStart(2, "0")}.txt`,
      isDir: false,
    }));
    visibleOnly = true;
    try {
      await renderGrid();
      const gridPlay = fileAnimCalls.at(-1)!;
      // grid cap = cols * (rows in the terminal + 1 margin) = 5 * 5 = 25
      expect(selection.tileRefs.size).toBe(30);
      expect(gridPlay.tiles.length).toBe(25);
      expect(gridPlay.total).toBe(30);
      // rows: 30 files / 5 cols = 6 rows; the 25-tile viewport cap covers 5
      // of them (ceil(25/5)), rowsTotal keeps the true count for the cascade
      expect(gridPlay.rows).toEqual([
        "tfm-tile-row-0",
        "tfm-tile-row-1",
        "tfm-tile-row-2",
        "tfm-tile-row-3",
        "tfm-tile-row-4",
      ]);
      expect(gridPlay.rowsTotal).toBe(6);

      // list cap = floor(terminal rows / row height) + 1 margin = 13 (the
      // same visibleTileCap math the thumb ranking uses)
      searchQuery = "fi";
      viewMode = "list";
      await renderGrid();
      const listPlay = fileAnimCalls.at(-1)!;
      expect(listPlay.tiles.length).toBe(13);
      expect(listPlay.total).toBe(30);

      // knob off: the whole list goes to the animator again
      searchQuery = "fil";
      viewMode = "grid";
      visibleOnly = false;
      await renderGrid();
      const fullPlay = fileAnimCalls.at(-1)!;
      expect(fullPlay.tiles.length).toBe(30);
      expect(fullPlay.total).toBe(30);
      // all rows too — the knob off means everything animates
      expect(fullPlay.rows!.length).toBe(6);
      expect(fullPlay.rowsTotal).toBe(6);
    } finally {
      // a failed assert above must not strand search mode into later tests
      recursiveSearch = false;
      searchQuery = "";
      searchEntries = [];
      searchCalls = [];
      searchSignals = [];
      visibleOnly = false;
      viewMode = "grid";
      await renderGrid();
    }
  });

  // the animated window must follow scrollTop like the thumb window does —
  // the old head-slice animated the off-screen TOP tiles while the visible
  // ones (scrolled deep) never animated at all
  test("file-anim window follows the scroll position (tiles AND rows)", async () => {
    const big = path.join(tmp, "anim-window-dir");
    mkdirSync(big);
    for (let i = 1; i <= 60; i++) writeFileSync(path.join(big, `w${String(i).padStart(2, "0")}.png`), "x");
    const prevCwd = gridState.cwd;
    try {
      gridState.cwd = big;
      scroller.scrollTop = 12; // two tile-rows down: tiles [10,35), rows [2,7)
      visibleOnly = true;
      await renderGrid();
      const play = fileAnimCalls.at(-1)!;
      // 60 files / 5 cols = 12 rows; viewport cap 25 tiles = 5 rows from row 2
      expect(play.tiles.length).toBe(25);
      // the window STARTS at the first visible tile (index 10), not at 0 —
      // the head-slice bug animated off-screen top tiles instead
      const tileIds = [...selection.tileRefs.values()].map((r) => r.tileId);
      expect(play.tiles[0]).toBe(tileIds[10]);
      expect(play.tiles.at(-1)).toBe(tileIds[34]);
      expect(play.total).toBe(60);
      expect(play.rows).toEqual([
        "tfm-tile-row-2",
        "tfm-tile-row-3",
        "tfm-tile-row-4",
        "tfm-tile-row-5",
        "tfm-tile-row-6",
      ]);
      expect(play.rowsTotal).toBe(12);
    } finally {
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      visibleOnly = false;
      await renderGrid();
    }
  });

  test("a layout-only rebuild (dual-pane toggle / hover drawer width) does NOT replay the animation", async () => {
    gridState.sortAsc = true; // known content state; baseline the content sig
    await renderGrid();
    fileAnimCalls = [];
    // geometry change rebuilds (col math moves) but the CONTENT signature is
    // unchanged, so the sink gets stops only, never a play
    availWSet = 30;
    await renderGrid();
    expect(selection.colsAtBuild()).toBe(2); // the rebuild really happened
    expect(fileAnimCalls.at(-1)!.tiles).toEqual([]); // stop, no play
    availWSet = null;

    // a real content change afterwards still animates
    gridState.sortAsc = false;
    await renderGrid();
    const play = fileAnimCalls.at(-1)!;
    expect(play.tiles.length).toBeGreaterThan(0);
    gridState.sortAsc = true;
  });

  test("hides dotfiles unless showHidden is on", async () => {
    writeFileSync(path.join(tmp, ".secret"), "x");
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain(".secret");

    gridState.showHidden = true;
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain(".secret");
    gridState.showHidden = false;
  });

  test("search filters entries; no matches paints the no-matches pane", async () => {
    searchQuery = "b.";
    await renderGrid();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("b.md");
    expect(frame).not.toContain("a.txt");

    searchQuery = "zzz";
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("no matches");
    searchQuery = "";
  });

  test("in-dir search honors the show-hidden toggle", async () => {
    writeFileSync(path.join(tmp, ".shidden"), "x");
    searchQuery = "shidden";
    gridState.showHidden = false;
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("no matches");
    gridState.showHidden = true;
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain(".shidden");
    gridState.showHidden = false;
    searchQuery = "";
  });

  test("recursive mode swaps in subtree matches; off filters in place", async () => {
    searchCalls = [];
    searchEntries = [
      { name: "deep/b.md", isDir: false, abs: path.join(tmp, "deep", "b.md") },
      { name: "deep/other", isDir: true, abs: path.join(tmp, "deep", "other") },
    ];
    // off (default): the dir filter runs, search backend never gets called
    searchQuery = "b.";
    recursiveSearch = false;
    await renderGrid();
    await t.renderOnce();
    expect(searchCalls).toEqual([]);
    expect(selection.tileRefs.has(path.join(tmp, "deep", "b.md"))).toBe(false);

    // on: the fake backend's entries become the grid, keys are absolute
    recursiveSearch = true;
    await renderGrid();
    await t.renderOnce();
    expect(searchCalls.length).toBe(1);
    // recursive search honors the show-hidden toggle (fd skips .git/.cache)
    expect(searchCalls[0]).toBe(`${tmp}|b.|hidden=false`);
    // ...and a signal is always handed to the backend for cancellation
    expect(searchSignals.length).toBe(1);
    const keys = [...selection.tileRefs.keys()];
    expect(keys).toContain(path.join(tmp, "deep", "b.md"));
    expect(keys).toContain(path.join(tmp, "deep", "other"));
    // mouse handlers got the results — selection/ops work on abs paths
    expect(mouseHandlers.some((m) => m.key === path.join(tmp, "deep", "b.md"))).toBe(true);

    // showHidden on → the backend is asked to include hidden entries
    searchCalls = [];
    gridState.showHidden = true;
    await renderGrid();
    expect(searchCalls[0]).toBe(`${tmp}|b.|hidden=true`);
    gridState.showHidden = false;

    // virtual cwds never recurse — results stay a same-dir filter
    searchCalls = [];
    gridState.cwd = "recent://";
    await renderGrid();
    await t.renderOnce();
    expect(searchCalls).toEqual([]);
    gridState.cwd = tmp;
    recursiveSearch = false;
    searchQuery = "";
    searchEntries = [];
  });

  test("a new render aborts the previous in-flight search", async () => {
    searchCalls = [];
    searchSignals = [];
    searchEntries = [{ name: "b.md", isDir: false, abs: path.join(tmp, "b.md") }];
    recursiveSearch = true;
    searchQuery = "b";
    let release!: () => void;
    searchGate = new Promise<void>((r) => {
      release = r;
    });
    const first = renderGrid();
    await Promise.resolve();
    expect(searchSignals.length).toBe(1);
    expect(searchSignals[0]!.aborted).toBe(false);
    // second render (still gated) must abort the first search
    const second = renderGrid();
    await Promise.resolve();
    expect(searchSignals[0]!.aborted).toBe(true);
    release();
    searchGate = null;
    await first;
    await second;
    recursiveSearch = false;
    searchQuery = "";
    searchEntries = [];
    searchSignals = [];
  });

  test("a pending launch-file is selected once, then cleared", async () => {
    const picked = path.join(tmp, "picked.txt");
    writeFileSync(picked, "x");
    await renderGrid();
    gridState.pendingSelect = picked;
    await renderGrid();
    await t.renderOnce();
    // the file's tile is selected and focused on the first build after the flag
    expect(selection.tileRefs.get(picked)?.selected).toBe(true);
    expect(selection.focusIdx()).toBe(selection.focusKeys().indexOf(picked));
    // one-shot: consumed, and a later rebuild does NOT re-select it
    expect(gridState.pendingSelect).toBeNull();
    selection.clearTileSelection();
    await renderGrid();
    expect(selection.tileRefs.get(picked)?.selected).toBe(false);
  });

  test("pending launch-file selection works in list view too", async () => {
    const picked = path.join(tmp, "list-pick.txt");
    writeFileSync(picked, "x");
    viewMode = "list";
    gridState.pendingSelect = picked;
    await renderGrid();
    await t.renderOnce();
    expect(selection.tileRefs.get(picked)?.selected).toBe(true);
    viewMode = "grid";
  });

  test("long names ellipsize to the tile width", async () => {
    writeFileSync(path.join(tmp, "a-very-long-filename-here.txt"), "x");
    await renderGrid();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("…");
    expect(frame).not.toContain("a-very-long-filename-here.txt");
  });

  test("image files hand off to the thumbnail queue, non-images do not", async () => {
    writeFileSync(path.join(tmp, "pic.png"), "pngbytes");
    await renderGrid();
    await t.renderOnce();

    const job = thumbJobs.find((j) => j.path.endsWith("pic.png"));
    expect(job).toBeTruthy();
    expect(job.wCells).toBe(Math.round(ASPECT * ICON_CELLS));
    expect(job.vector).toBe(false);
    // the job's slot is the tile's registered thumb slot (no icon spec)
    const ref = selection.tileRefs.get(path.join(tmp, "pic.png"))!;
    expect(ref.iconSlotId).toBe(job.slotId);
    expect(ref.iconSpec).toBeUndefined();
    expect(thumbJobs.find((j) => j.path.endsWith("a.txt"))).toBeUndefined();
  });

  // the thumb jobs' `visible` flag is what thumbJobRank orders the drain by —
  // the viewport window must follow scrollTop (a hover-drawer settle rebuilds
  // mid-scroll) and mark only the first screenful of tiles for fast raster
  test("thumb jobs flag viewport membership; scrolling moves the window", async () => {
    const big = path.join(tmp, "viewport-dir");
    mkdirSync(big);
    for (let i = 1; i <= 60; i++) writeFileSync(path.join(big, `v${String(i).padStart(2, "0")}.png`), "x");
    const prevCwd = gridState.cwd;
    try {
      gridState.cwd = big;
      scroller.scrollTop = 0;
      thumbJobs = [];
      await renderGrid();
      await t.renderOnce();
      // grid: cols = floor((80-20-3)/10) = 5, rows = 24/6 = 4 → cap = 5*5 = 25
      expect(thumbJobs.length).toBe(60);
      const visAt = (name: string) => thumbJobs.find((j) => j.path.endsWith(name))!.visible;
      expect(visAt("v01.png")).toBe(true);
      expect(visAt("v25.png")).toBe(true);
      expect(visAt("v26.png")).toBe(false);

      // scrolled two tile-rows down (12 cells): window = [10, 35) — forced
      // because scrollTop is deliberately not part of the content signature
      scroller.scrollTop = 12;
      thumbJobs = [];
      await renderGrid(true);
      await t.renderOnce();
      expect(visAt("v10.png")).toBe(false);
      expect(visAt("v11.png")).toBe(true);
      expect(visAt("v35.png")).toBe(true);
      expect(visAt("v36.png")).toBe(false);
    } finally {
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      thumbJobs = [];
      await renderGrid();
      await t.renderOnce();
    }
  });

  test("re-render preserves selection, focus and anchor by path", async () => {
    const aIdx = selection.focusKeys().indexOf(path.join(tmp, "a.txt"));
    selection.selectTileAt(aIdx);
    selection.setSelAnchor(0);
    const focusKey = selection.focusKeys()[selection.focusIdx()]!;
    iconStateCalls.length = 0;
    await renderGrid(true); // force a rebuild: same listing, selection must survive
    await t.renderOnce();
    const ref = selection.tileRefs.get(path.join(tmp, "a.txt"))!;
    expect(ref.selected).toBe(true);
    expect(selection.focusKeys()[selection.focusIdx()]).toBe(focusKey);
    expect(selection.selAnchor()).toBe(0);
    // repainted as Selected (icon state 2) after the rebuild
    expect(iconStateCalls.some((c) => c.idx === 2)).toBe(true);
  });

  test("re-render drops selection for vanished files, keeps the rest", async () => {
    writeFileSync(path.join(tmp, "gone.txt"), "x");
    await renderGrid();
    const goneIdx = selection.focusKeys().indexOf(path.join(tmp, "gone.txt"));
    selection.selectRange(0, goneIdx); // subdir (index 0) through gone.txt
    rmSync(path.join(tmp, "gone.txt"));
    await renderGrid();
    await t.renderOnce();
    expect(selection.tileRefs.get(path.join(tmp, "gone.txt"))).toBeUndefined();
    expect(selection.tileRefs.get(path.join(tmp, "subdir"))!.selected).toBe(true);
  });

  test("cut (pending-move) tiles are dimmed at rebuild", async () => {
    cutKeys.add(path.join(tmp, "a.txt"));
    iconStateCalls.length = 0;
    await renderGrid(true); // force: cut state is out-of-band, dims at rebuild
    await t.renderOnce();
    // setTileVisual(Rest) on a cut key routes icon state 3 (cut)
    expect(iconStateCalls.some((c) => c.idx === 3)).toBe(true);
    cutKeys.clear();
  });

  test("an unchanged listing skips the rebuild (no cross-pane refresh)", async () => {
    gridState.cwd = tmp;
    await renderGrid();
    const slotsBefore = iconSlots.length;
    await renderGrid(); // identical signature: must NOT rebuild
    expect(iconSlots.length).toBe(slotsBefore);
  });
});

describe("renderGrid (panes)", () => {
  test("empty folder paints the empty pane", async () => {
    const empty = path.join(tmp, "empty-dir");
    mkdirSync(empty);
    const prevCwd = gridState.cwd;
    gridState.cwd = empty;
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("this folder is empty");
    gridState.cwd = prevCwd;
  });

  test("unreadable folder paints the error pane, not a blank grid", async () => {
    const prevCwd = gridState.cwd;
    gridState.cwd = path.join(tmp, "gone");
    await renderGrid();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("can't open this folder");
    gridState.cwd = prevCwd;
  });
});

describe("renderGrid (list view)", () => {
  test("rows paint name + size, register refs with row heights", async () => {
    viewMode = "list";
    await renderGrid();
    await t.renderOnce();

    const frame = t.captureCharFrame();
    expect(frame).toContain("a.txt");
    expect(frame).toContain("5 B"); // a.txt = "hello" = 5 bytes
    // single column, row height from the list-row-height knob (2)
    expect(selection.colsAtBuild()).toBe(1);
    expect(selection.rowHAtBuild()).toBe(2);
    viewMode = "grid";
  });
});

// --- [ui] windowed-grid: only the visible row window (+overscan) is built;
// the full tileRefs/focusKeys list stays the selection's contract, spacers
// keep the content height honest, and syncWindow slides on scroll ---
describe("renderGrid (windowed grid)", () => {
  // tmp is assigned in beforeAll — describe bodies run at collection time,
  // so every path derives lazily inside the tests
  const bigDir = (): string => path.join(tmp, "windowed-dir");
  const byId = (id: string): any => t.renderer.root.findDescendantById(id);
  const bigFile = (i: number): string => path.join(bigDir(), `w${String(i).padStart(4, "0")}.txt`);
  const ensureBig = (): void => {
    mkdirSync(bigDir(), { recursive: true });
    for (let i = 1; i <= 500; i++) writeFileSync(bigFile(i), "x");
  };

  test("builds only the window but registers EVERY entry (grid + list)", async () => {
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      mouseHandlers.length = 0;
      await renderGrid();
      await t.renderOnce();

      // the SELECTION contract: 500 refs + focusKeys even though ~30 tiles exist
      expect(selection.tileRefs.size).toBe(500);
      expect(selection.focusKeys().length).toBe(500);

      // grid: 5 cols, TILE_H 6 → 5+1 visible rows + 1 overscan = rows 0..5;
      // pad-top collapses at r0=0, pad-bottom fills the remaining 94 rows
      const inner = byId("tfm-tile-inner");
      expect(inner.getChildren()).toHaveLength(8);
      expect(byId("tfm-tile-row-5")).toBeTruthy();
      expect(byId("tfm-tile-row-6")).toBeFalsy();
      expect(byId("tfm-tile-pad-top").yogaNode.getComputedHeight()).toBe(0);
      expect(byId("tfm-tile-pad-bottom").yogaNode.getComputedHeight()).toBe((100 - 6) * 6);
      // unbuilt rows are not built AT ALL (mouse handlers only exist per built tile)
      expect(mouseHandlers.map((m) => m.idx)).toEqual([...Array(30).keys()]);
      // absolute ids: tile 0 is index 0, and off-window refs point at nothing
      expect(selection.tileRefs.get(bigFile(1))!.tileId).toBe("tfm-tile-0");
      expect(byId("tfm-tile-300")).toBeFalsy();

      // list view: rows ARE tiles — 13 visible + 1 overscan → rows 0..13,
      // pad-bottom fills the remaining 486 rows (all at height 2)
      viewMode = "list";
      await renderGrid();
      await t.renderOnce();
      expect(byId("tfm-tile-inner").getChildren()).toHaveLength(16);
      expect(byId("tfm-tile-13")).toBeTruthy();
      expect(byId("tfm-tile-14")).toBeFalsy();
      expect(byId("tfm-tile-pad-bottom").yogaNode.getComputedHeight()).toBe((500 - 14) * 2);
      expect(selection.tileRefs.size).toBe(500);
    } finally {
      viewMode = "grid";
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("syncWindow slides the window; selection survives and re-paints on re-entry", async () => {
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      selection.selectTileAt(1); // w0002.txt, row 0

      // fling to row 50 (scrollTop 300 / TILE_H 6): rows 49..55 built now
      scroller.scrollTop = 300;
      mouseHandlers.length = 0;
      syncWindow();
      await t.renderOnce();
      expect(byId("tfm-tile-row-0")).toBeFalsy();
      expect(byId("tfm-tile-row-50")).toBeTruthy();
      expect(byId("tfm-tile-inner").getChildren()).toHaveLength(9); // pad-top + 7 rows + pad-bottom
      expect(byId("tfm-tile-pad-top").yogaNode.getComputedHeight()).toBe(49 * 6);
      // slide-built tiles carry ABSOLUTE indices (handlers, ids and the
      // cascade window can never drift out of display order)
      expect(mouseHandlers.map((m) => m.idx)).toEqual(Array.from({ length: 35 }, (_, i) => 245 + i));
      // the model NEVER shrank: selection, status source and focus keys are
      // the full list while the DOM holds only the window
      expect(selection.selPaths().map((s) => s.path)).toEqual([bigFile(2)]);
      expect(selection.focusKeys().length).toBe(500);
      // a second syncWindow without scroll movement must not rebuild
      const rows1 = byId("tfm-tile-inner").getChildren()[1];
      syncWindow();
      expect(byId("tfm-tile-inner").getChildren()[1]).toBe(rows1);

      // ONE-row notch: the slide is INCREMENTAL — the inner and every
      // surviving row keep their identity (destroying/rebuilding them is
      // what flickered: each fresh icon slot repaints the fallback glyph
      // until the async drain swaps the raster back in)
      const innerNode = byId("tfm-tile-inner");
      const row50 = byId("tfm-tile-row-50");
      mouseHandlers.length = 0;
      scroller.scrollTop = 306; // firstRow 51 → window 50..56
      syncWindow();
      await t.renderOnce();
      expect(byId("tfm-tile-inner")).toBe(innerNode);
      expect(byId("tfm-tile-row-50")).toBe(row50);
      expect(byId("tfm-tile-row-49")).toBeFalsy(); // left edge dropped…
      expect(byId("tfm-tile-row-56")).toBeTruthy(); // …right edge added
      expect(innerNode.getChildren()).toHaveLength(9); // same row count
      expect(byId("tfm-tile-pad-top").yogaNode.getComputedHeight()).toBe(50 * 6);
      expect(byId("tfm-tile-pad-bottom").yogaNode.getComputedHeight()).toBe((100 - 1 - 56) * 6);
      // only the ENTERING row built tiles (handlers are the proof of work)
      expect(mouseHandlers.map((m) => m.idx)).toEqual([280, 281, 282, 283, 284]);

      // UPWARD two-row notch: entering rows PREPEND in order (index-insert,
      // not append) and display order must survive for band/anim/index math
      mouseHandlers.length = 0;
      scroller.scrollTop = 294; // firstRow 49 → window 48..54
      syncWindow();
      await t.renderOnce();
      expect(
        innerNode
          .getChildren()
          .slice(1, -1)
          .map((c: any) => c.id),
      ).toEqual(Array.from({ length: 7 }, (_, i) => `tfm-tile-row-${48 + i}`));
      expect(byId("tfm-tile-row-55")).toBeFalsy();
      expect(byId("tfm-tile-row-56")).toBeFalsy();
      expect(byId("tfm-tile-pad-top").yogaNode.getComputedHeight()).toBe(48 * 6);
      expect(mouseHandlers.map((m) => m.idx)).toEqual([240, 241, 242, 243, 244, 245, 246, 247, 248, 249]);

      // back to the top: no overlap → full rebuild, and the stale selection
      // repaints as its row re-enters
      scroller.scrollTop = 0;
      syncWindow();
      await t.renderOnce();
      expect(byId("tfm-tile-row-0")).toBeTruthy();
      const selBg = byId("tfm-tile-1").backgroundColor?.toInts();
      const sibBg = byId("tfm-tile-2").backgroundColor?.toInts();
      expect(selBg).not.toEqual(sibBg);
    } finally {
      selection.clearTileSelection();
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("an in-progress rename/create edit survives a scroll (slide gated)", async () => {
    // the editor Input lives INSIDE the tile node — a slide during an edit
    // would destroy the input and orphan a just-created file (clearRenameEdit
    // is state-drop-only and skips the create cleanup), so the slide waits
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      renamingOn = true;
      scroller.scrollTop = 300;
      syncWindow();
      expect(byId("tfm-tile-row-0")).toBeTruthy(); // window untouched…
      expect(byId("tfm-tile-row-50")).toBeFalsy(); // …no slide happened
      renamingOn = false;
      syncWindow();
      expect(byId("tfm-tile-row-50")).toBeTruthy(); // next chance lands it
    } finally {
      renamingOn = false;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("a selected row re-entering via an INCREMENTAL slide keeps its selection", async () => {
    // The fallback rebuild repaints every window row, but the incremental
    // slide only repaints ENTERING rows from ref state — so buildTile's
    // "preserve ref.selected on re-register" is the ONLY thing that stops a
    // scrolled-out-then-back selection from silently dropping. Break that
    // line in ui-grid.ts and THIS test must go red (not just the fling one).
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      selection.selectTileAt(1); // w0002.txt, row 0

      // slide row 0 fully OUT of the window (down past r1), then INCREMENTALLY
      // back so the row is re-added (buildTile re-registers ref #1)
      scroller.scrollTop = 36; // firstRow 6 → window 5..11: row 0 dropped
      syncWindow();
      await t.renderOnce();
      expect(byId("tfm-tile-row-0")).toBeFalsy();
      expect(selection.selPaths().length).toBe(1); // model still selected

      scroller.scrollTop = 0; // back to window 0..5
      syncWindow();
      await t.renderOnce();
      expect(byId("tfm-tile-row-0")).toBeTruthy();
      const selBg = byId("tfm-tile-1").backgroundColor?.toInts();
      const sibBg = byId("tfm-tile-2").backgroundColor?.toInts();
      expect(selBg).not.toEqual(sibBg); // ref.selected survived re-registration
    } finally {
      selection.clearTileSelection();
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("scroll reveal animates exactly the entering rows and follows the edge", async () => {
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    // a REAL chrome gap: the grid viewport is 20 rows inside a 24-row
    // terminal — the bottom crossing must follow the viewport, not termH
    // (termH math revealed row 5 while it was still off-screen: the
    // "only the top animates" bug)
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;

      // one notch down: visible range [0..3] → [1..4], so ROW 4 (tiles
      // 20..24) crosses the bottom edge; row 5 (just built, off-screen) must
      // NOT be revealed
      scroller.scrollTop = 6;
      syncWindow();
      const down = fileAnimCalls.at(-1)!;
      expect(down.enterFrom).toBe("bottom");
      expect(down.rows).toEqual(["tfm-tile-row-4"]);
      expect(down.tiles).toEqual([20, 21, 22, 23, 24].map((i) => `tfm-tile-${i}`));
      expect(down.inner).toBeNull(); // NEVER the whole grid container

      // jump up from deep: rows 8..9 newly cross the TOP edge
      scroller.scrollTop = 60; // firstRow 10 → fallback rebuild, window 9..15
      syncWindow();
      scroller.scrollTop = 48; // firstRow 8 → window 7..13, visible 8..12
      syncWindow();
      const up = fileAnimCalls.at(-1)!;
      expect(up.enterFrom).toBe("top");
      expect(up.rows).toEqual(["tfm-tile-row-8", "tfm-tile-row-9"]);
      expect(up.tiles.length).toBe(10);
      expect(up.tiles[0]).toBe("tfm-tile-40");

      // knob off: the slide does not touch the animator at all (no stop, no play)
      revealOn = false;
      fileAnimCalls.length = 0;
      scroller.scrollTop = 54; // firstRow 9 → window 8..14
      syncWindow();
      expect(fileAnimCalls).toEqual([]);
      revealOn = true;

      // a fling PAST the window falls back to a whole rebuild — and reveals
      // nothing (jumping users want immediacy)
      fileAnimCalls.length = 0;
      scroller.scrollTop = 540; // firstRow 90 → disjoint from 8..14
      syncWindow();
      expect(byId("tfm-tile-row-94")).toBeTruthy();
      expect(fileAnimCalls.at(-1)!.tiles).toEqual([]);
    } finally {
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("scroll reveal fires on the TOP edge of a partially visible bottom row", async () => {
    // viewport 20 / TILE_H 6: jumping 0 -> 11 shows row 5's top cell (y=30
    // inside 11..30) while the old full-row math (firstRow + floor(visH/rh))
    // still reports bottom=4. The reveal must follow overlap, not full rows.
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 11; // rem=5: row 5 peeks in by one cell
      syncWindow();
      const play = fileAnimCalls.at(-1)!;
      expect(play.enterFrom).toBe("bottom");
      expect(play.rows).toEqual(["tfm-tile-row-4", "tfm-tile-row-5"]);
    } finally {
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("scroll reveal fires for a sub-row notch that leaves the build window in place", async () => {
    // the build window only moves when firstRow crosses a row boundary, so a
    // 570 -> 575 notch changes nothing built — but row 99's top cell (y=594
    // inside 575..594) newly overlaps. Returning early on equal windows would
    // delay the reveal until the next full-row notch.
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      scroller.scrollTop = 570; // fallback rebuild near the end, no reveal
      syncWindow();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 575; // same build window, row 99 peeks in
      syncWindow();
      const play = fileAnimCalls.at(-1)!;
      expect(play.enterFrom).toBe("bottom");
      expect(play.rows).toEqual(["tfm-tile-row-99"]);
    } finally {
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("scroll-reveal delay defers the play until scroll settles: one wave, union of crossings", async () => {
    // fast fling = a play per notch today: each new wave retriggers while the
    // last is mid-flight, so nothing ever completes visibly AND every frame
    // pays native pushes. With a settle delay, quick notches coalesce into
    // ONE play over the union of crossed rows — cheaper and actually seen.
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      // two quick notches: visible [0..3] → [1..4] → [2..5]; rows 4 AND 5
      // cross, but nothing may play yet
      scroller.scrollTop = 6;
      syncWindow();
      scroller.scrollTop = 12;
      syncWindow();
      expect(fileAnimCalls).toEqual([]);
      // settle: exactly ONE play covering the union of both crossings
      revealClock.flush();
      expect(fileAnimCalls.length).toBe(1);
      const play = fileAnimCalls[0]!;
      expect(play.enterFrom).toBe("bottom");
      expect(play.rows).toEqual(["tfm-tile-row-4", "tfm-tile-row-5"]);
      expect(play.tiles.length).toBe(10);
      expect(play.tiles[0]).toBe("tfm-tile-20");
    } finally {
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("a fling past the window cancels a pending deferred reveal", async () => {
    // the fallback rebuild shows the landing spot instantly by design — a
    // late reveal firing after the jump would animate stale rows over it
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 6; // row 4 crosses: pending, not played
      syncWindow();
      expect(fileAnimCalls).toEqual([]);
      scroller.scrollTop = 540; // firstRow 90 → disjoint: fallback rebuild
      syncWindow();
      revealClock.flush();
      // only the fallback's stop (empty tiles) may exist — never a reveal
      expect(fileAnimCalls.every((c) => c.tiles.length === 0)).toBe(true);
    } finally {
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("navigating away drops a pending deferred reveal (no late stop into the new folder)", async () => {
    // the pending play for the OLD folder's rows must die with the rebuild:
    // firing later would stop() the new folder's boot wave mid-flight
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 6; // row 4 crosses: pending, not played
      syncWindow();
      expect(fileAnimCalls).toEqual([]);
      gridState.cwd = prevCwd; // navigate away: full rebuild
      await renderGrid();
      fileAnimCalls.length = 0; // drop the new folder's own content play
      revealClock.flush();
      expect(fileAnimCalls).toEqual([]); // stale bigDir reveal never fires
    } finally {
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("deferred reveal pre-stages entering rows invisible (no rest-then-snap flash)", async () => {
    // with a settle delay the wave plays ~80ms AFTER the rows mount — if
    // they sit at rest until then, the first wave tick snaps 1→0: visible,
    // then invisible, then fading in = the flicker. Staging the crossing
    // rows at frame-0 opacity at mount makes the delayed play a
    // continuation, not a snap. Break the staging line and THIS goes red.
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 6; // row 4 crosses into view
      syncWindow();
      await t.renderOnce();
      expect(fileAnimCalls).toEqual([]); // still deferred
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(0); // staged, not resting
      expect((byId("tfm-tile-row-0") as any).opacity).not.toBe(0); // survivors untouched
      revealClock.flush(); // the wave plays over the staged set — no snap
      expect(fileAnimCalls.length).toBe(1);
      expect(fileAnimCalls[0]!.rows).toEqual(["tfm-tile-row-4"]);
      // rows-mode: flush must NOT release the staged rows — the wave owns
      // exactly them and starts from frame 0 (they'd blink back to rest)
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(0);
    } finally {
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("disabling reveal mid-pending restores staged rows (no stuck-invisible rows)", async () => {
    // staged rows sit at opacity 0 waiting for a wave that will now never
    // come — the knob-off cancel must put them back to rest, or they stay
    // invisible until the next rebuild. Row 4 survives both slides below.
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 6; // row 4 crosses, staged at 0
      syncWindow();
      await t.renderOnce();
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(0);
      revealOn = false;
      scroller.scrollTop = 12; // slide with knob off → cancel path
      syncWindow();
      await t.renderOnce();
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(1); // restored
      revealClock.flush();
      expect(fileAnimCalls).toEqual([]); // nothing late fires
    } finally {
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("flush releases staged rows when the wave drives per-file tiles (row-granularity off)", async () => {
    // the mount-time staging is rows-only (cheapest addressing); the driven
    // set is decided by the animator at flush. A row left at 0 would hide
    // every per-file child regardless of its own opacity — flush must
    // release the rows as soon as play() reports "tiles".
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    fileAnimMode = "tiles";
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      fileAnimCalls.length = 0;
      scroller.scrollTop = 6; // row 4 crosses, staged at 0
      syncWindow();
      await t.renderOnce();
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(0);
      revealClock.flush();
      expect(fileAnimCalls.length).toBe(1);
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(1); // released for the tiles wave
    } finally {
      fileAnimMode = "rows";
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("flush releases staged rows when no wave comes (animation master off)", async () => {
    // reveal knob ON + file-animation master OFF: play() early-returns null,
    // nothing animates — without the release the rows would strand invisible
    // until the next rebuild.
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    revealOn = true;
    revealDelayMs = 80;
    revealClock.reset();
    fileAnimMode = null;
    scroller.viewport = { height: 20 };
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      scroller.scrollTop = 6; // row 4 crosses, staged at 0
      syncWindow();
      await t.renderOnce();
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(0);
      revealClock.flush();
      expect((byId("tfm-tile-row-4") as any).opacity).toBe(1); // not stranded
    } finally {
      fileAnimMode = "rows";
      revealDelayMs = 0;
      revealClock.reset();
      revealOn = false;
      scroller.viewport = undefined;
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("flipping windowed-grid forces a rebuild and full build disables sliding", async () => {
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      expect(byId("tfm-tile-inner").getChildren()).toHaveLength(8);
      // toggle OFF: the same content with a different mode must rebuild
      // (windowed is part of the render signature), yielding the full 100 rows
      windowedGridOn = false;
      await renderGrid();
      await t.renderOnce();
      expect(byId("tfm-tile-inner").getChildren()).toHaveLength(100);
      // a full build has no window to slide: scrolling must not touch anything
      scroller.scrollTop = 300;
      syncWindow();
      await t.renderOnce();
      expect(byId("tfm-tile-row-0")).toBeTruthy();
      expect(byId("tfm-tile-pad-top")).toBeFalsy();
    } finally {
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("recursively-searched (flat) results window identically", async () => {
    // results come from the injected fake; 40 abs-keyed entries exercise the
    // same window with `entry.abs` instead of cwd-joined names
    recursiveSearch = true;
    searchQuery = "w";
    searchEntries = Array.from({ length: 40 }, (_, i) => ({
      name: `q${i}.txt`,
      isDir: false,
      abs: path.join(tmp, `q${i}.txt`),
    })) as Entry[];
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid();
      await t.renderOnce();
      // 40 files / 5 cols = 8 rows, window rows 0..5 → 6 rows + pad
      expect(byId("tfm-tile-inner").getChildren()).toHaveLength(8);
      expect(byId("tfm-tile-pad-bottom").yogaNode.getComputedHeight()).toBe(2 * 6);
      expect(selection.tileRefs.size).toBe(40);
    } finally {
      recursiveSearch = false;
      searchQuery = "";
      searchEntries = [];
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });

  test("a deep stale scrollTop on a shrunk listing builds a CLAMPED window", async () => {
    // mass-delete scenario: the watcher re-renders a 6-entry folder while the
    // scroller still holds a deep (stale) offset — unclamped, windowRange
    // produced r0 > r1 = a pads-only blank pane
    ensureBig();
    const prevCwd = gridState.cwd;
    windowedGridOn = true;
    try {
      gridState.cwd = bigDir();
      scroller.scrollTop = 0;
      await renderGrid(); // establish windowed state on the big folder
      gridState.cwd = tmp; // small dir (few entries) under a stale deep offset
      scroller.scrollTop = 3000;
      await renderGrid();
      await t.renderOnce();
      // the clamp parks the window at the LAST rows (where a deep scroll
      // legitimately lands on a short list) instead of building no rows at all
      const totalRows = Math.ceil(selection.tileRefs.size / 5);
      const r0 = Math.max(0, totalRows - 2);
      expect(byId(`tfm-tile-row-${totalRows - 1}`)).toBeTruthy();
      expect(byId(`tfm-tile-row-${r0}`)).toBeTruthy(); // no pads-only pane
      expect(byId("tfm-tile-pad-top").yogaNode.getComputedHeight()).toBe(r0 * 6);
      expect(byId("tfm-tile-pad-bottom").yogaNode.getComputedHeight()).toBe(0);
      expect([...byId("tfm-tile-inner").getChildren()].length).toBe(totalRows - r0 + 2);
    } finally {
      windowedGridOn = false;
      scroller.scrollTop = 0;
      gridState.cwd = prevCwd;
      await renderGrid();
    }
  });
});

describe("hookScrollerScroll", () => {
  class FakeScroller {
    #y = 0;
    get scrollTop(): number {
      return this.#y;
    }
    set scrollTop(v: number) {
      this.#y = Math.max(0, v);
    }
  }

  test("every scrollTop write fires the callback once; reads and clamping stay native", () => {
    const s = new FakeScroller() as any;
    let calls = 0;
    expect(hookScrollerScroll(s, () => calls++)).toBe(true);
    s.scrollTop = 5;
    expect(s.scrollTop).toBe(5);
    expect(calls).toBe(1);
    s.scrollTop = -9; // the prototype's clamp still applies — the hook wraps it
    expect(s.scrollTop).toBe(0);
    expect(calls).toBe(2);
    // never double-hook, and objects without an accessor are rejected
    expect(hookScrollerScroll(s, () => calls++)).toBe(false);
    expect(hookScrollerScroll({}, () => calls++)).toBe(false);
  });

  test("a scrollbar thumb drag (which bypasses the setter) notifies too", () => {
    // ScrollBar's slider writes its private position field and then invokes
    // the bar's _onChange closure — that's the only scroll path NOT going
    // through scrollTop, so the hook chains it as well (original first)
    const seen: Array<string | number> = [];
    const sc = {
      scrollTop: 0, // plain data property: no accessor to wrap here
      verticalScrollBar: { _onChange: (p: number) => seen.push(`orig:${p}`) },
    } as any;
    expect(hookScrollerScroll(sc, () => seen.push("notify"))).toBe(true);
    sc.verticalScrollBar._onChange(42);
    expect(seen).toEqual(["orig:42", "notify"]);
  });
});
