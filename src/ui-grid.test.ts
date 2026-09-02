import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, type Renderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeGridRenderer, type GridState } from "./ui-grid";
import { makeSelection } from "./selection";
import { defaultConfig } from "./config-schema";
import type { Theme } from "./config";
import type { SortMode } from "./menu-entries";

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
let gridState: GridState;
let cutKeys: Set<string>;
let iconStateCalls: Array<{ spec: any; idx: number }>;
let thumbJobs: any[];
let iconSlots: Array<{ name: string; heightCells: number; initialState: number }>;
let mouseHandlers: Array<{ name: string; key: string; idx: number }>;
let searchQuery: string;
let viewMode: "grid" | "list";
let selection: ReturnType<typeof makeSelection>;
let renderGrid: () => Promise<void>;

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
  viewMode = "grid";
  let iconSeq = 0;

  t.renderer.root.add(Box({ id: "tfm-scroll-test", flexDirection: "column", flexGrow: 1 }));
  await t.renderOnce();
  content = t.renderer.root.findDescendantById("tfm-scroll-test") as Renderable;

  selection = makeSelection({
    colors: () => colors,
    uiStyle: () => "solid",
    byId: (id) => t.renderer.root.findDescendantById(id),
    setIconState: (spec, idx) => {
      iconStateCalls.push({ spec, idx });
    },
    isCutKey: (key) => cutKeys.has(key),
    scroller: () => null,
    viewH: () => TERM_H - 3,
    rowHInit: () => TILE_H,
    renderPreview: () => {},
  });

  const { renderGrid: rg } = makeGridRenderer({
    termW: () => TERM_W,
    termH: () => TERM_H,
    scroller: () => ({ content }),
    state: gridState,
    searchQuery: () => searchQuery,
    pathEditMode: () => false,
    sw: () => SW,
    tileW: () => TILE_W,
    tileH: () => TILE_H,
    iconCells: () => ICON_CELLS,
    listRowH: () => 2,
    uiStyle: () => "solid",
    colors: () => colors,
    previewEnabled: () => false,
    previewWidth: () => 0,
    viewMode: () => viewMode,
    wordWrap: () => false,
    reservedRight: () => 0,
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

  test("hides dotfiles unless showHidden (or a search) is on", async () => {
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

  test("cut (pending-move) tiles are dimmed at rebuild", async () => {
    cutKeys.add(path.join(tmp, "a.txt"));
    iconStateCalls.length = 0;
    await renderGrid();
    await t.renderOnce();
    // setTileVisual(mode 0) on a cut key routes icon state 3 (cut)
    expect(iconStateCalls.some((c) => c.idx === 3)).toBe(true);
    cutKeys.clear();
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
