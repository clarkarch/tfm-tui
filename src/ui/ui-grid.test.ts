import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, type Renderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeGridRenderer, type GridState } from "./ui-grid";
import { makeSelection } from "../input/selection";
import type { Entry } from "../fs/listing";
import { defaultConfig } from "../config/config-schema";
import type { HoverLiftOpts } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { SortMode } from "../lib/sort";

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
let scroller: { content: Renderable; scrollTop: number };
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
let availWSet: number | null;
let hoverLiftOpts: HoverLiftOpts;
let tilePrefix: string;
let visibleOnly: boolean;
let fileAnimCalls: Array<{ tiles: string[]; inner: string | null; total: number }>;

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
  const { renderGrid: rg } = makeGridRenderer({
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
    fileAnim: (target: { tiles: string[]; inner?: string | null; total?: number }) => {
      fileAnimCalls.push({
        tiles: [...target.tiles],
        inner: target.inner ?? null,
        total: target.total ?? target.tiles.length,
      });
    },
    fileAnimVisibleOnly: () => visibleOnly,
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
    hoverLiftOpts = { enabled: true, direction: "up", includeLabel: false };
    await renderGrid();
    const before = [...selection.tileRefs.values()].map((r) => r.tileId);
    hoverLiftOpts = { enabled: true, direction: "down", includeLabel: false };
    await renderGrid();
    const after = [...selection.tileRefs.values()].map((r) => r.tileId);
    expect(after).not.toEqual(before);
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
