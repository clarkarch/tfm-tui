import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { MouseButtons } from "@opentui/core/testing";
import { makeChrome, tabChipMaxWidth } from "./ui-chrome";
import { gridDrag } from "../input/grid-input";
import { defaultConfig } from "../config/config-schema";
import { loadSystemPlaces } from "../fs/places";
import type { NotifyLevel } from "../lib/notify-level";
import type { Theme } from "../config/config";
import type { Tab } from "../app/tabs";

// Headless widget test (createTestRenderer pilot: ui-menu.test.ts). Pins the
// places sidebar + tab strip: row mounting with byte-identical ids, selection
// paint (cwd row), navigate/context-menu click routing, the DROP contract
// (trash-target routes to trashPaths, self-drops filtered), tab chip
// activation/close/drop, the strip visibility rule and hover normalization.
// buildSections() runs without loadSystemPlaces() — defaults are deterministic
// (Home/Recent/Starred/Trash with a sandboxed $XDG_DATA_HOME).

const colors = defaultConfig.theme as Theme & Record<string, any>;
const HOME = os.homedir();

const hexInts = (hex: string): number[] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
};

let t: TestRendererSetup;
let trashSandbox: string;
let savedXdgData: string | undefined;
let chrome: ReturnType<typeof makeChrome>;
let calls: {
  navigate: string[];
  switchTab: number[];
  closeTab: number[];
  newTab: number;
  trashPaths: string[][];
  moveInto: Array<[string, { path: string; isDir: boolean }[]]>;
  finishDrag: number;
  contextMenu: Array<{ x: number; y: number; title: string }>;
  closeFileMenu: number;
  blurTerminal: number;
  hoverRow: Array<[string, boolean]>;
  iconStates: Array<{ spec: any; idx: number }>;
};
let cwd: string;
let rasterSig: string;
let tabBar: boolean;
let availWVal: number; // 0 = seam absent (roomy 24-wide chips, today's look)
let tabModel: { list: Tab[]; active: number };
let tabModel1: { list: Tab[]; active: number };
let kbActive: boolean;
let kbIdx: number;
let modalOpen: boolean;
// eject/mount test seams: notify/home/spawn capture for a second chrome
// instance, built in the eject describe's beforeAll so the shared fakes above
// keep their old shape
let notifies: Array<[string, string | undefined, NotifyLevel | undefined]>;
let fakeHome: string;
let spawns: string[][];
// [ui] sidebar-section-titles: names each group in place of the dividers
let sectionTitles: boolean;
// fake icon-slot id sequence: the real makeIconSlot sequences ids (iconSeq), so
// a constant one would resolve the FIRST tab's element for every tab
let iconSlots = 0;

const mkTabs = (n: number): Tab[] => Array.from({ length: n }, (_, i) => ({ history: [`/dir${i}`], histIdx: 0 }));

const byId = (id: string) => t.renderer.root.findDescendantById(id);
const bgInts = (id: string): number[] => {
  const n: any = byId(id);
  return n?.backgroundColor ? [...n.backgroundColor.toInts()] : [0, 0, 0, 0];
};

beforeAll(async () => {
  t = await createTestRenderer({ width: 80, height: 24 });
  // sandbox the trash root so the Trash place is deterministic and no real
  // ~/.local/share/Trash is touched; restored in afterAll (shared process env)
  savedXdgData = process.env.XDG_DATA_HOME;
  trashSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-chrome-test-"));
  process.env.XDG_DATA_HOME = trashSandbox;
  mkdirSync(path.join(trashSandbox, "Trash", "files"), { recursive: true });

  calls = {
    navigate: [],
    switchTab: [],
    closeTab: [],
    newTab: 0,
    trashPaths: [],
    moveInto: [],
    finishDrag: 0,
    contextMenu: [],
    closeFileMenu: 0,
    blurTerminal: 0,
    hoverRow: [],
    iconStates: [],
  };
  cwd = HOME;
  rasterSig = "raster-a";
  tabBar = false;
  availWVal = 0;
  tabModel = { list: mkTabs(2), active: 1 };
  tabModel1 = { list: mkTabs(3), active: 2 };
  kbActive = false;
  kbIdx = -1;
  modalOpen = false;
  sectionTitles = false;
  // eject/mount seams: written by the eject describe below; absent here so
  // the shared fakes keep today's ctx shape
  notifies = [];
  fakeHome = HOME;
  spawns = [];

  const host = Box(
    { flexDirection: "row" },
    Box({ id: "tfm-places", flexDirection: "column", width: 20 }),
    Box({ id: "tfm-p0-tabbar", flexDirection: "row", height: 1, overflow: "hidden" }),
    Box({ id: "tfm-p1-tabbar", flexDirection: "row", height: 1, overflow: "hidden" }),
  );
  t.renderer.root.add(host);
  await t.renderOnce();

  chrome = makeChrome({
    byId,
    uiStyle: () => "solid",
    colors: () => colors,
    sw: () => 20,
    sideInnerW: () => 20,
    tabBar: () => tabBar,
    // [ui] sidebar-section-titles (absent in the old fakes = dividers only)
    sectionTitles: () => sectionTitles,
    availW: () => availWVal,
    rasterSig: () => rasterSig,
    renderAll: () => {},
    navigate: (target) => {
      calls.navigate.push(target);
    },
    blurTerminal: () => {
      calls.blurTerminal++;
    },
    closeFileMenu: () => {
      calls.closeFileMenu++;
    },
    openContextMenu: (x, y, title, _entries) => {
      calls.contextMenu.push({ x, y, title });
    },
    sidebarEntriesFor: () => [],
    finishDrag: () => {
      calls.finishDrag++;
    },
    dlog: () => {},
    trashPaths: (paths) => {
      calls.trashPaths.push(paths);
      return Promise.resolve();
    },
    moveInto: (dest, items) => {
      calls.moveInto.push([dest, items]);
      return Promise.resolve();
    },
    kbActive: () => kbActive,
    kbIdx: () => kbIdx,
    modalOpen: () => modalOpen,
    tabs: (pane: 0 | 1) => (pane === 1 ? tabModel1 : tabModel),
    focusPane: () => {},
    closeTab: (_pane: 0 | 1, i: number) => {
      calls.closeTab.push(i);
    },
    switchTab: (_pane: 0 | 1, i: number) => {
      calls.switchTab.push(i);
    },
    newTab: (_pane: 0 | 1) => {
      calls.newTab++;
    },
    hoverBtn: () => Box({ id: "tfm-p0-tab-new", width: 3, height: 1 }),
    stripSelectable: () => {},
    drainIconQueue: () => {},
    // mirrors the REAL makeIconSlot contract: a mounted element box resolvable
    // by byId AFTER the chip is added (the tab ✕'s hide/reveal writes
    // `visible` on it), with a per-call id like the real iconSeq
    makeIconSlot: (
      name: string,
      states: any,
      heightCells?: number,
      initialState?: number,
      onMouseDown?: (ev: any) => void,
    ) => {
      const slotId = `slot-${name}-${iconSlots++}`;
      return {
        el: Box({
          id: slotId,
          width: Math.round((heightCells ?? 1) * 2),
          height: heightCells ?? 1,
          ...(onMouseDown ? { onMouseDown } : {}),
        }),
        slotId,
        spec: {
          slotId,
          name,
          heightCells: heightCells ?? 1,
          states,
          initialState: initialState ?? 0,
        },
      };
    },
    setIconState: (spec, idx) => {
      calls.iconStates.push({ spec, idx });
      return true;
    },
    stateCwd: () => cwd,
    connectServer: () => {},
    hoverRow: (key: string, hovered: boolean) => {
      calls.hoverRow.push([key, hovered]);
    },
  });
});

afterAll(async () => {
  if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgData;
  gridDrag.keys = null;
  gridDrag.active = false;
  rmSync(trashSandbox, { recursive: true, force: true });
  await t.dispose(); // 0.6.0: destroy + await closed
});

describe("renderSidebar", () => {
  test("mounts the default places rows with tfm-place-N ids", async () => {
    chrome.renderSidebar();
    await t.renderOnce();
    expect(byId("tfm-place-0")).toBeTruthy();
    expect(byId("tfm-place-3")).toBeTruthy();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Home");
    expect(frame).toContain("Recent");
    expect(frame).toContain("Starred");
    expect(frame).toContain("Trash");
    expect(frame).toContain("This Device"); // devices group always renders
    expect(chrome.placesHost.length).toBeGreaterThanOrEqual(5);
  });

  test("the cwd place row paints selected (accent), others rest", async () => {
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();
    expect(bgInts("tfm-place-0")).toEqual(hexInts(colors.accentBg));
    expect(bgInts("tfm-place-1")).toEqual(hexInts(colors.sidebarBg)); // Recent rests
  });

  test("left-click navigates to the place target", async () => {
    cwd = "/somewhere";
    chrome.renderSidebar();
    await t.renderOnce();
    await t.mockMouse.click(2, 1, MouseButtons.LEFT); // Recent row
    expect(calls.navigate).toContain("recent://");
    expect(calls.blurTerminal).toBeGreaterThan(0);
  });

  test("right-click opens the sidebar context menu at the click cell", async () => {
    await t.mockMouse.click(2, 0, MouseButtons.RIGHT); // Home row
    expect(calls.contextMenu.length).toBeGreaterThan(0);
    expect(calls.contextMenu.at(-1)!.title).toBe("Home");
    expect(calls.closeFileMenu).toBeGreaterThan(0);
  });

  test("a cwd-only change repaints the highlight without rebuilding rows", async () => {
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();
    const row0 = chrome.placesHost[0]!.row;
    const spec0 = chrome.placesHost[0]!.specs[0];
    cwd = "/elsewhere/entirely";
    chrome.renderSidebar();
    await t.renderOnce();
    // same node + slot (no fallback-glyph flash), highlight moved off Home
    expect(chrome.placesHost[0]!.row).toBe(row0);
    expect(chrome.placesHost[0]!.specs[0]).toBe(spec0);
    expect(chrome.placesHost[0]!.selected).toBe(false);
  });

  test("section titles name every group; dividers give way", async () => {
    cwd = HOME;
    sectionTitles = true;
    chrome.renderSidebar();
    await t.renderOnce();
    // deterministic groups: Places (home/recent/starred/trash), Devices, Network
    expect(t.captureCharFrame()).toContain("Places");
    expect(t.captureCharFrame()).toContain("Devices");
    expect(t.captureCharFrame()).toContain("Network");
  });

  test("a section title centers in the sidebar column", async () => {
    cwd = HOME;
    sectionTitles = true;
    chrome.renderSidebar();
    await t.renderOnce();
    const line =
      t
        .captureCharFrame()
        .split("\n")
        .find((l) => l.includes("Places")) ?? "";
    // 20-wide inner column: "Places" (6) centers at col 7
    expect(line.indexOf("Places")).toBe(Math.floor((20 - "Places".length) / 2));
    sectionTitles = false;
    chrome.renderSidebar();
    await t.renderOnce();
  });

  test("a blank row sits above each section title, no divider", async () => {
    cwd = HOME;
    sectionTitles = true;
    chrome.renderSidebar();
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    const i = lines.findIndex((l) => l.includes("Places"));
    expect(i).toBeGreaterThan(0);
    // space above the title; the group's rows follow it directly (no rule)
    expect(lines[i - 1]!.trim()).toBe("");
    expect(lines[i + 1]).toContain("Home");
    // every section repeats it (Devices is deterministic: always rendered)
    const j = lines.findIndex((l) => l.includes("Devices"));
    expect(j).toBeGreaterThan(0);
    expect(lines[j - 1]!.trim()).toBe("");
    expect(lines[j + 1]).not.toContain("~");
    sectionTitles = false;
    chrome.renderSidebar();
    await t.renderOnce();
  });

  test("flipping the section-titles switch repaints (the sig carries the flag)", async () => {
    cwd = HOME;
    sectionTitles = true;
    chrome.renderSidebar();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Devices");
    sectionTitles = false;
    chrome.renderSidebar();
    await t.renderOnce();
    // off = today's look: the title text is gone (divider only)
    expect(t.captureCharFrame()).not.toContain("Devices");
  });

  test("a raster-mode flip rebuilds rows so force-glyph applies live", async () => {
    // same places, different graphics mode: the old rasters must go, so the
    // rows (and their icon slots) are re-created instead of highlighted
    cwd = HOME;
    rasterSig = "raster-a";
    chrome.renderSidebar();
    await t.renderOnce();
    const row0 = chrome.placesHost[0]!.row;
    rasterSig = "raster-b";
    chrome.renderSidebar();
    await t.renderOnce();
    expect(chrome.placesHost[0]!.row).not.toBe(row0);
    rasterSig = "raster-a";
    chrome.renderSidebar();
    await t.renderOnce();
  });

  test("a mounts-driven rebuild replays the boot intro on the fresh nodes", async () => {
    // isolated renderer: this file's shared renderer/module state (sysMounts
    // in fs/places, "tfm-places" host contents) made the replay asserts order-
    // dependent — a dedicated renderer per replay test is the only honest
    // isolation (same pattern as the toolbar crumb tests below).
    const rt = await createTestRenderer({ width: 80, height: 24 });
    try {
      // the lazy-mounts race: renderAll builds the sidebar, the boot intro
      // plays (stages frame 0 on the rows), then refreshMounts lands with new
      // Devices rows and rebuilds — the fresh nodes must cascade, not arrive
      // settled.
      const replays: number[] = [];
      const staleDrops: number[] = [];
      // the wiring's guard: replaySidebarIntro is a no-op until the boot intro
      // played once (playedAt seam here) — the widget calls unconditionally
      // and the guard decides. First build replays nothing; a rebuild inside
      // the intro window replays once; later rebuilds stay silent.
      // forgetStaleHover answers through a REAL animator (empty refs =
      // nothing owned = false), so the test pins the call shape while
      // ui-sidebar-hover.test.ts pins the behavior.
      const { makeSidebarHover } = await import("./ui-sidebar-hover");
      const staleHover = makeSidebarHover({
        renderer: () => null as any,
        byId: () => null,
        rowRefs: () => new Map(),
        hoverOpts: () => ({
          enabled: true,
          ms: 0,
          slideCells: 1,
          ease: "ease-out",
          direction: "left",
          includeLabel: false,
        }),
      });
      let playedAt = 0;
      let sigNow = "intro-replay";
      const hostId = "tfm-places-intro-replay";
      const rbyId = (id: string) => rt.renderer.root.findDescendantById(id);
      rt.renderer.root.add(Box({ id: hostId, flexDirection: "column", width: 20 }));
      await rt.renderOnce();
      const introChrome = makeChrome({
        byId: rbyId,
        hostBox: () => rbyId(hostId),
        uiStyle: () => "solid",
        colors: () => colors,
        sw: () => 20,
        sideInnerW: () => 20,
        tabBar: () => false,
        availW: () => 0,
        rasterSig: () => sigNow,
        renderAll: () => {},
        navigate: () => {},
        blurTerminal: () => {},
        closeFileMenu: () => {},
        openContextMenu: () => {},
        sidebarEntriesFor: () => [],
        finishDrag: () => {},
        dlog: () => {},
        trashPaths: () => Promise.resolve(),
        moveInto: () => Promise.resolve(),
        kbActive: () => false,
        kbIdx: () => -1,
        tabs: () => ({ list: mkTabs(1), active: 0 }),
        focusPane: () => {},
        closeTab: () => {},
        switchTab: () => {},
        newTab: () => {},
        hoverBtn: () => Box({ id: "tfm-intro-tab-new", width: 3, height: 1 }),
        stripSelectable: () => {},
        drainIconQueue: () => {},
        makeIconSlot: (name: string) => ({
          el: null,
          slotId: `intro-${name}`,
          spec: { slotId: `intro-${name}`, name, heightCells: 1, states: [], initialState: 0 },
        }),
        setIconState: () => true,
        stateCwd: () => HOME,
        connectServer: () => {},
        hoverRow: () => {},
        forgetStaleHover: () => {
          const dropped = staleHover.forgetStale();
          if (dropped) staleDrops.push(1);
          return dropped;
        },
        replaySidebarIntro: () => {
          if (playedAt) replays.push(1);
        },
      });
      introChrome.renderSidebar();
      await rt.renderOnce();
      expect(replays.length).toBe(0); // first build: the boot step hasn't played yet
      // the boot intro plays; mounts land inside the window: exactly one replay.
      // nothing is hovered here, so the stale-hover forget stays a silent
      // no-op (its true path is pinned in ui-sidebar-hover.test.ts).
      playedAt = 1;
      sigNow = "intro-replay-2";
      introChrome.renderSidebar();
      await rt.renderOnce();
      expect(replays).toHaveLength(1);
      expect(staleDrops).toHaveLength(0);
      // same sig again: fast path, no replay, no storm
      introChrome.renderSidebar();
      await rt.renderOnce();
      expect(replays).toHaveLength(1);
      expect(staleDrops).toHaveLength(0);
    } finally {
      await rt.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("place drops (OSC-72 / internal drag targets)", () => {
  const dropOn = (id: string) => {
    (byId(id) as any).processMouseEvent({
      type: "drop",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
  };

  test("dropping files on Home moves them into it", () => {
    gridDrag.keys = [
      { path: "/x/f1", isDir: false },
      { path: "/x/f2", isDir: false },
    ];
    dropOn("tfm-place-0");
    expect(calls.moveInto.length).toBe(1);
    const [dest, items] = calls.moveInto[0]!;
    expect(dest).toBe(HOME);
    expect(items.map((i) => i.path)).toEqual(["/x/f1", "/x/f2"]);
    expect(calls.finishDrag).toBe(1);
    gridDrag.keys = null;
  });

  test("the dragged target itself is filtered out of its own drop payload", () => {
    gridDrag.keys = [
      { path: HOME, isDir: true },
      { path: "/x/f2", isDir: false },
    ];
    dropOn("tfm-place-0");
    const [, items] = calls.moveInto.at(-1)!;
    expect(items.map((i) => i.path)).toEqual(["/x/f2"]);
    gridDrag.keys = null;
  });

  test("dropping on the Trash place routes to trashPaths, never a plain move", () => {
    const trashFiles = path.join(trashSandbox, "Trash", "files");
    gridDrag.keys = [{ path: "/x/f1", isDir: false }];
    dropOn("tfm-place-3");
    expect(calls.trashPaths.length).toBe(1);
    expect(calls.trashPaths[0]).toEqual(["/x/f1"]);
    // a trash drop must never come back as a moveInto onto the trash dir
    const trashMoves = calls.moveInto.filter(([d]) => d === trashFiles);
    expect(trashMoves).toEqual([]);
    gridDrag.keys = null;
  });

  test("virtual places (Recent/Starred) accept no drops", () => {
    const movesBefore = calls.moveInto.length;
    gridDrag.keys = [{ path: "/x/f1", isDir: false }];
    dropOn("tfm-place-1");
    expect(calls.moveInto.length).toBe(movesBefore);
    gridDrag.keys = null;
  });
});

describe("renderTabbar", () => {
  test("mounts one chip per tab + the new-tab button", async () => {
    tabBar = false;
    tabModel = { list: mkTabs(2), active: 1 };
    chrome.renderTabbar(0);
    await t.renderOnce();
    expect(byId("tfm-p0-tab-0")).toBeTruthy();
    expect(byId("tfm-p0-tab-1")).toBeTruthy();
    expect(byId("tfm-p0-tab-new")).toBeTruthy();
    expect(t.captureCharFrame()).toContain("dir1"); // active tab title paints
  });

  test("pane 1's strip renders its OWN tab model, independently", async () => {
    tabModel = { list: mkTabs(2), active: 0 };
    tabModel1 = { list: mkTabs(3), active: 2 };
    chrome.renderTabbar(0);
    chrome.renderTabbar(1);
    await t.renderOnce();
    expect(byId("tfm-p1-tab-0")).toBeTruthy();
    expect(byId("tfm-p1-tab-2")).toBeTruthy();
    expect(byId("tfm-p1-tab-3")).toBeFalsy();
    expect(t.captureCharFrame()).toContain("dir2"); // pane 1's active chip title
    tabModel = { list: mkTabs(2), active: 1 };
    tabModel1 = { list: mkTabs(3), active: 2 };
  });

  test("visibility: adaptive (off) hides the strip for a single tab, the setting forces it", () => {
    const bar: any = byId("tfm-p0-tabbar");
    tabModel = { list: mkTabs(1), active: 0 };
    chrome.renderTabbar(0);
    expect(bar.visible).toBe(false); // adaptive, one tab
    tabModel = { list: mkTabs(2), active: 0 };
    chrome.renderTabbar(0);
    expect(bar.visible).toBe(true); // adaptive, two tabs
    tabBar = true;
    tabModel = { list: mkTabs(1), active: 0 };
    chrome.renderTabbar(0);
    expect(bar.visible).toBe(true); // forced on
    tabBar = false;
    tabModel = { list: mkTabs(2), active: 1 };
  });

  test("clicking a chip switches tabs; middle-click closes it", () => {
    const chip0: any = byId("tfm-p0-tab-0");
    chip0.processMouseEvent({
      type: "down",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(calls.switchTab).toContain(0);
    chip0.processMouseEvent({
      type: "down",
      button: 1,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(calls.closeTab).toContain(0);
  });

  test("the tab ✕ highlights its raster state AND its wrapper surface together", async () => {
    tabModel = { list: mkTabs(2), active: 1 }; // tab 0 is the inactive chip
    calls.iconStates.length = 0;
    chrome.renderTabbar(0);
    await t.renderOnce();
    const closeId = "tfm-p0-tab-0-close";
    // an inactive chip's ✕ rests on the canvas fill and flattens onto it
    expect(bgInts(closeId)).toEqual(hexInts(colors.bg));
    const fire = (type: string) =>
      (byId(closeId) as any).processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
    fire("move");
    // 1 = Active (the hover raster) — swapping only this left a flat square on
    // the wrapper in glyph/transparent modes, which is the bug class this pins
    expect(calls.iconStates.at(-1)?.idx).toBe(1);
    expect(bgInts(closeId)).toEqual(hexInts(colors.hoverBg));
    fire("out");
    expect(calls.iconStates.at(-1)?.idx).toBe(0);
    expect(bgInts(closeId)).toEqual(hexInts(colors.bg));
  });

  test("the tab ✕ hides until the chip is hovered, with the reserved cells keeping the strip still", async () => {
    tabModel = { list: mkTabs(2), active: 1 };
    availWVal = 0;
    chrome.renderTabbar(0);
    await t.renderOnce();
    const chip: any = byId("tfm-p0-tab-0");
    const slotEl = (): any => (byId("tfm-p0-tab-0-close") as any)?.getChildren()[0];
    const fire = (type: string) =>
      chip.processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
    expect(slotEl().visible).toBe(false); // at rest the strip shows no ✕
    // The reserved cells are a FIXED width: the chip (and every chip after it)
    // must sit exactly where it does with the ✕ hidden — a collapsing slot
    // shrinks the chip and shifts the tail ("jittery strip under the mouse").
    const restW = chip.getLayout().width;
    const restX1 = (byId("tfm-p0-tab-1") as any).x;
    // a rebuild under a stationary cursor re-fires a SYNTHETIC "over" (no move,
    // no out) — the ✕ must reveal there, or a click-switch hides it until a wiggle
    fire("over");
    expect(slotEl().visible).toBe(true);
    fire("out");
    expect(slotEl().visible).toBe(false);
    fire("move");
    expect(slotEl().visible).toBe(true);
    await t.renderOnce(); // layout AFTER the reveal
    expect(chip.getLayout().width).toBe(restW);
    expect((byId("tfm-p0-tab-1") as any).x).toBe(restX1);
    fire("out");
    await t.renderOnce();
    expect(slotEl().visible).toBe(false);
    expect(chip.getLayout().width).toBe(restW);
  });

  test("a folder dragged over a chip never reveals the ✕", async () => {
    tabModel = { list: mkTabs(2), active: 0 };
    availWVal = 0;
    chrome.renderTabbar(0);
    await t.renderOnce();
    const chip: any = byId("tfm-p0-tab-0");
    const slotEl = (): any => (byId("tfm-p0-tab-0-close") as any)?.getChildren()[0];
    const fire = (type: string) =>
      chip.processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
    gridDrag.active = true;
    gridDrag.keys = [{ path: "/x/dragdir", isDir: true }];
    try {
      // the drag's only chip signal is the over; the drop-target cue branch of
      // the move paint hides it too (a close ✕ under a dragged folder misfires)
      fire("over");
      expect(slotEl().visible).toBe(false);
      fire("move");
      expect(slotEl().visible).toBe(false);
    } finally {
      gridDrag.active = false;
      gridDrag.keys = null;
      fire("out");
    }
    // drag over: the chip is a plain chip again and hovers normally
    fire("move");
    expect(slotEl().visible).toBe(true);
    fire("out");
  });

  test("a click on the hidden ✕ falls through to the chip; a revealed one closes", async () => {
    tabModel = { list: mkTabs(2), active: 1 };
    availWVal = 0;
    chrome.renderTabbar(0);
    await t.renderOnce();
    const wrap: any = byId("tfm-p0-tab-0-close");
    calls.switchTab.length = 0;
    calls.closeTab.length = 0;
    // display:none drops the slot's hit cells, so these 2 cells belong to the
    // chip: the click switches tab instead of closing it (no invisible ✕ trap)
    await t.mockMouse.click(wrap.x, wrap.y, MouseButtons.LEFT);
    expect(calls.closeTab).toEqual([]);
    expect(calls.switchTab).toContain(0);
    // hovering the CHIP BODY reveals the ✕ (the ✕'s own cells aren't hoverable yet)
    const chipBody = byId("tfm-p0-tab-0") as any;
    await t.mockMouse.moveTo(chipBody.x + 1, chipBody.y);
    await t.renderOnce();
    const revealed = (byId("tfm-p0-tab-0-close") as any).getChildren()[0] as any;
    expect(revealed.visible).toBe(true);
    // … and the same cell now hits the slot's own handler
    calls.switchTab.length = 0;
    await t.mockMouse.click(wrap.x, wrap.y, MouseButtons.LEFT);
    expect(calls.closeTab).toContain(0);
    expect(calls.switchTab).toEqual([]);
  });

  test("four tabs in a 32-wide strip fit without overflow (chips shrink, plus stays)", async () => {
    tabModel = { list: mkTabs(4), active: 0 };
    tabModel1 = { list: mkTabs(1), active: 0 }; // pane 1 strip hidden, no space fight
    availWVal = 32;
    (byId("tfm-p0-tabbar") as any).width = 32;
    chrome.renderTabbar(0);
    chrome.renderTabbar(1);
    await t.renderOnce();
    const w = (id: string): number => (byId(id) as any)?.getLayout?.()?.width ?? 99;
    const chips = [0, 1, 2, 3].map((i) => w(`tfm-p0-tab-${i}`));
    // 4 chips + 4 gaps + 3-wide plus must fit 32: chips shrink below content width
    const total = chips.reduce((a, b) => a + b, 0) + 4 + 3;
    expect(Math.max(...chips)).toBeLessThanOrEqual(8);
    expect(total).toBeLessThanOrEqual(32);
    expect(byId("tfm-p0-tab-new")).toBeTruthy();
    // restore the shared fixtures (later describes reuse tabModel/width)
    (byId("tfm-p0-tabbar") as any).width = "auto";
    availWVal = 0;
    tabModel = { list: mkTabs(2), active: 1 };
    tabModel1 = { list: mkTabs(3), active: 2 };
  });

  test("tabChipMaxWidth splits the row: plus + gaps accounted, clamped both ends", () => {
    expect(tabChipMaxWidth(54, 2)).toBe(24); // roomy strips keep today's look
    expect(tabChipMaxWidth(54, 1)).toBe(24); // one tab never stretches
    expect(tabChipMaxWidth(32, 4)).toBe(6); // (32-3-4)/4: the shrink case above
    expect(tabChipMaxWidth(26, 2)).toBe(10); // narrow dual pane, two tabs
    expect(tabChipMaxWidth(14, 2)).toBe(6); // minimum wins over the math (4)
    expect(tabChipMaxWidth(26, 10)).toBe(6); // past the minimum the tail clips
    expect(tabChipMaxWidth(54, 0)).toBe(24); // no tabs stays roomy, never NaN
  });

  test("dropping a single dragged folder on a chip navigates that tab to it", async () => {
    tabModel = { list: mkTabs(2), active: 1 }; // previous test rendered a 1-tab bar
    chrome.renderTabbar(0);
    await t.renderOnce();
    gridDrag.keys = [{ path: "/x/afolder", isDir: true }];
    (byId("tfm-p0-tab-1") as any).processMouseEvent({
      type: "drop",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(calls.switchTab).toContain(1);
    expect(calls.navigate).toContain("/x/afolder");
    // a file (non-dir) never triggers chip navigation
    const navBefore = calls.navigate.length;
    gridDrag.keys = [{ path: "/x/afile", isDir: false }];
    (byId("tfm-p0-tab-1") as any).processMouseEvent({
      type: "drop",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    expect(calls.navigate.length).toBe(navBefore);
    gridDrag.keys = null;
  });
});

describe("normalizePlaces (hover/kb focus)", () => {
  test("setMousePlace lights exactly one non-selected row and clearMousePlace restores it", async () => {
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();
    chrome.setMousePlace(2);
    expect(bgInts("tfm-place-2")).toEqual(hexInts(colors.hoverBg));
    expect(bgInts("tfm-place-1")).toEqual(hexInts(colors.sidebarBg));
    chrome.clearMousePlace();
    expect(bgInts("tfm-place-2")).toEqual(hexInts(colors.sidebarBg));
  });

  test("keyboard focus (kbActive) wins over mouse hover", () => {
    chrome.setMousePlace(2); // mouse on Starred
    kbActive = true;
    kbIdx = 1;
    chrome.renderSidebar(); // render path applies kb focus at rebuild tail
    expect(bgInts("tfm-place-1")).toEqual(hexInts(colors.hoverBg));
    expect(bgInts("tfm-place-2")).toEqual(hexInts(colors.sidebarBg));
    kbActive = false;
    kbIdx = -1;
    chrome.clearMousePlace();
  });

  test("a modal open suppresses every sidebar highlight (kb focus can't keep one lit)", () => {
    cwd = HOME;
    chrome.renderSidebar();
    kbActive = true;
    kbIdx = 1;
    chrome.renderSidebar();
    expect(bgInts("tfm-place-1")).toEqual(hexInts(colors.hoverBg));
    // the menu opened: the kb-focused row must drop its highlight under the dim
    modalOpen = true;
    chrome.normalizePlaces();
    expect(bgInts("tfm-place-1")).toEqual(hexInts(colors.sidebarBg));
    // closing restores it
    modalOpen = false;
    chrome.normalizePlaces();
    expect(bgInts("tfm-place-1")).toEqual(hexInts(colors.hoverBg));
    kbActive = false;
    kbIdx = -1;
  });

  test("mouse move/out routes the row key to hoverRow (per-row nudge)", async () => {
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();
    // hover-on rides on MOVE, never on OVER (see ui-slots.hoverEvents): OpenTUI
    // re-fires a synthetic "over" on a rebuild under a stationary cursor
    const fire = (id: string, type: string) =>
      (byId(id) as any).processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
    const nOver = calls.hoverRow.length;
    fire("tfm-place-2", "move");
    // exclusivity: the only emission for THIS row on a move is the lift
    expect(calls.hoverRow.slice(nOver).filter(([k]) => k === "tfm-place-2")).toEqual([["tfm-place-2", true]]);
    // paint still normalizes alongside the nudge
    expect(bgInts("tfm-place-2")).toEqual(hexInts(colors.hoverBg));
    // a repeated move over the same row is a no-op (the wiring is idempotent,
    // so per-pixel moves can't repaint every row in the sidebar)
    const nRepeat = calls.hoverRow.length;
    fire("tfm-place-2", "move");
    expect(calls.hoverRow.length).toBe(nRepeat);
    const nOut = calls.hoverRow.length;
    fire("tfm-place-2", "out");
    expect(calls.hoverRow.slice(nOut).filter(([k]) => k === "tfm-place-2")).toEqual([["tfm-place-2", false]]);
    expect(bgInts("tfm-place-2")).toEqual(hexInts(colors.sidebarBg));
  });

  test("a lifted row that becomes selected has its lift released on repaint", async () => {
    // the stuck-lift regression: mouse rests on an unselected row (it lifts),
    // then cwd changes to that row (click/keyboard/grid nav) with NO mouse out —
    // normalizePlaces must route a release so the selected row never keeps nudging
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();
    // pick a row that is unselected while cwd=HOME and has a real path
    const target = chrome.placesHost.find((r) => !r.selected && r.place.path);
    expect(target).toBeTruthy();
    (byId(target!.rowId) as any).processMouseEvent({
      type: "move",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    // now navigate cwd to that row; the mouse stays put (no out event fires)
    cwd = target!.place.path!;
    const n = calls.hoverRow.length;
    // go through the real funnel: renderSidebar's fast path (sig excludes cwd) →
    // normalizePlaces, which recomputes selected from live cwd and must release
    // the newly-selected row's lift via hoverRow(key, false)
    chrome.renderSidebar();
    expect(calls.hoverRow.slice(n).filter(([k]) => k === target!.rowId)).toEqual([[target!.rowId, false]]);
  });
});

// --- eject / mount UX: every op tells the user what happened (notify), and
// the eject icon's click never also navigates (stopPropagation, like the tab
// ✕). The fake slot mounts a LIVE row child carrying the real onMouseDown,
// so processMouseEvent on it proves the bubble guard for real; the fake spawn
// stores its child in `lastChild`, which the test then drives. The ejectable
// row comes from a fake `lsblk` JSON on PATH: buildSections reads the real
// module state, and the suite shares one module cache, so the PATH seam (not
// a module mock) is what makes the row appear. ---
describe("eject / mount", () => {
  type FakeChild = {
    on(ev: "close" | "error", cb: (...a: never[]) => void): FakeChild;
    emitClose(code: number): void;
    emitError(err: Error): void;
  };
  let lastChild: FakeChild | null;
  let spawned: FakeChild[];
  let slotSeq: number;
  let ejectChrome: ReturnType<typeof makeChrome>;
  let savedPath: string | undefined;
  let binDir: string;

  beforeAll(() => {
    lastChild = null;
    spawned = [];
    slotSeq = 0;
    // fake lsblk on PATH: a removable vfat stick at /media/usb plus a TWO-
    // partition USB hard drive whose bridge lies about RM (RM=0, TRAN=usb),
    // so buildSections yields ejectable rows for both after loadSystemPlaces
    binDir = mkdtempSync(path.join(os.tmpdir(), "tfm-eject-bin-"));
    writeFileSync(
      path.join(binDir, "lsblk"),
      `#!/bin/sh\ncat <<'EOF'\n{"blockdevices":[{"name":"sdb","rm":true,"tran":"usb","path":"/dev/sdb","children":[{"name":"sdb1","fstype":"vfat","mountpoints":["/media/usb"]}]},{"name":"sdc","rm":false,"tran":"usb","path":"/dev/sdc","children":[{"name":"sdc1","fstype":"ext4","mountpoints":["/media/hdd1"]},{"name":"sdc2","fstype":"ext4","mountpoints":["/media/hdd2"]}]}]}\nEOF\n`,
    );
    chmodSync(path.join(binDir, "lsblk"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    const fakeMakeIconSlot = (
      name: string,
      states: unknown,
      heightCells?: number,
      initialState?: number,
      onMouseDown?: (ev: unknown) => void,
    ) => {
      // unique ids per slot: the real makeIconSlot sequences them, and three
      // ejectable rows share the "eject" name — a static id would make byId
      // always hit the first row's icon (the sdb stick, never the hdd rows)
      const slotId = `ej-slot-${name}-${slotSeq++}`;
      const el =
        typeof onMouseDown === "function"
          ? Box({ id: slotId, width: 2, height: 1, onMouseDown }, Box({ width: 1, height: 1 }))
          : Box({ id: slotId, width: 2, height: 1 });
      return {
        el,
        slotId,
        spec: { slotId, name, heightCells: heightCells ?? 1, states, initialState: initialState ?? 0 },
      };
    };
    const spawnUdisks = (args: string[]): FakeChild => {
      spawns.push(args);
      const listeners: Record<"close" | "error", ((...a: never[]) => void)[]> = { close: [], error: [] };
      const child: FakeChild = {
        on: (ev, cb) => {
          listeners[ev].push(cb);
          return child;
        },
        emitClose: (code: number) => {
          for (const cb of listeners.close) cb(code as never);
        },
        emitError: (err: Error) => {
          for (const cb of listeners.error) cb(err as never);
        },
      };
      lastChild = child;
      spawned.push(child);
      return child;
    };
    ejectChrome = makeChrome({
      byId,
      uiStyle: () => "solid",
      colors: () => colors,
      sw: () => 20,
      sideInnerW: () => 20,
      tabBar: () => tabBar,
      renderAll: () => {},
      navigate: (target) => {
        calls.navigate.push(target);
      },
      blurTerminal: () => {},
      closeFileMenu: () => {},
      openContextMenu: () => {},
      sidebarEntriesFor: () => [],
      finishDrag: () => {},
      dlog: () => {},
      trashPaths: () => Promise.resolve(),
      moveInto: () => Promise.resolve(),
      kbActive: () => false,
      kbIdx: () => -1,
      tabs: (pane: 0 | 1) => (pane === 1 ? tabModel1 : tabModel),
      focusPane: () => {},
      closeTab: () => {},
      switchTab: () => {},
      newTab: () => {},
      hoverBtn: () => Box({ id: "tfm-p0-tab-new", width: 3, height: 1 }),
      stripSelectable: () => {},
      drainIconQueue: () => {},
      makeIconSlot: fakeMakeIconSlot as never,
      setIconState: () => true,
      stateCwd: () => cwd,
      connectServer: () => {},
      hoverRow: () => {},
      notify: (msg, title, level) => {
        notifies.push([msg, title, level]);
      },
      home: () => fakeHome,
      spawnUdisks: spawnUdisks as never,
    });
  });

  afterAll(async () => {
    ejectChrome.dispose();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
    // give back real places state: the fake lsblk above replaced sysMounts
    // for the whole shared module cache — later files must see real devices
    await loadSystemPlaces();
    gridDrag.keys = null;
  });

  const resetSeams = () => {
    calls.navigate.length = 0;
    notifies.length = 0;
    spawns.length = 0;
    // a previous test's child outlives its spawn: without clearing, a
    // no-spawn regression still drives the OLD child and false-greens
    lastChild = null;
    spawned = [];
    cwd = HOME;
    fakeHome = HOME;
  };

  // the child of THIS test's spawn: asserts a fresh spawn happened first, so
  // the failure reads "spawned no child", not a bare null-child
  const child = (): FakeChild => {
    expect(spawns.length).toBe(1);
    expect(lastChild).toBeTruthy();
    return lastChild!;
  };

  // Synthetic click carrying the real propagation protocol (Renderable.ts):
  // stopPropagation flips the flag the parent's bubble check reads. A bare
  // object without it keeps bubbling — the row navigates mid-test while the
  // same click in production stops at the eject icon.
  const clickEjectIcon = (slotId: string): boolean => {
    const ev: {
      type: string;
      button: number;
      x: number;
      y: number;
      modifiers: { shift: boolean; alt: boolean; ctrl: boolean };
      propagationStopped: boolean;
      stopPropagation(): void;
    } = {
      type: "down",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
      propagationStopped: false,
      stopPropagation() {
        ev.propagationStopped = true;
      },
    };
    (byId(slotId) as any).processMouseEvent(ev);
    return ev.propagationStopped;
  };

  // the ejectable row's icon slot id, once the sidebar has rendered it
  const ejectSlotId = (target = "/media/usb"): string => {
    const rec = ejectChrome.placesHost.find((r) => r.place.ejectable && r.place.path === target);
    expect(rec).toBeTruthy();
    return rec!.specs[1]!.slotId;
  };

  // i-th child of this test's spawns: sequential udisks spawns park on close,
  // so the test drives each step after settling on the spawn count
  const kid = (i: number): FakeChild => {
    expect(spawns.length).toBeGreaterThan(i);
    const c = spawned[i];
    expect(c).toBeTruthy();
    return c!;
  };

  const settleSpawns = async (n: number): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (spawns.length < n && Date.now() < deadline) await Bun.sleep(10);
    expect(spawns.length).toBeGreaterThanOrEqual(n);
  };

  const settleUntilNotifies = async (n: number): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (notifies.length < n && Date.now() < deadline) await Bun.sleep(10);
    expect(notifies.length).toBeGreaterThanOrEqual(n);
  };

  test("ejecting without a device spawns nothing and says why", () => {
    resetSeams();
    ejectChrome.ejectDevice({ label: "ghost" });
    expect(spawns).toEqual([]);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("error");
  });

  test("eject click stops propagation: the row never navigates", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    const stopped = clickEjectIcon(ejectSlotId());
    expect(stopped).toBe(true);
    expect(calls.navigate).toEqual([]);
    ejectChrome.dispose();
  });

  test("eject leaves its own mountpoint before unmounting", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    cwd = "/media/usb/some/dir";
    clickEjectIcon(ejectSlotId());
    expect(calls.navigate).toEqual([fakeHome]);
    // Nautilus parity: unmount the partition, then power the disk off
    await settleSpawns(1);
    kid(0).emitClose(0);
    await settleSpawns(2);
    expect(spawns).toEqual([
      ["unmount", "-b", "/dev/sdb1"],
      ["power-off", "-b", "/dev/sdb"],
    ]);
    ejectChrome.dispose();
  });

  test("eject toasts safe-to-unplug after unmount + power-off", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    clickEjectIcon(ejectSlotId());
    await settleSpawns(1);
    kid(0).emitClose(0);
    await settleSpawns(2);
    kid(1).emitClose(0);
    await settleUntilNotifies(1);
    // the fake lsblk carries no LABEL, so places.ts falls back to the
    // mountpoint basename — the toast names the device either way
    expect(notifies[0]).toEqual([expect.stringMatching(/safe to unplug/i), "eject", "success"]);
    ejectChrome.dispose();
  });

  test("eject aborts the chain on an unmount failure (no power-off)", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    clickEjectIcon(ejectSlotId());
    await settleSpawns(1);
    kid(0).emitClose(1);
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("error");
    // the chain stopped: no power-off spawn follows the failed unmount
    expect(spawns).toEqual([["unmount", "-b", "/dev/sdb1"]]);
    ejectChrome.dispose();
  });

  test("eject toasts failure when the spawn itself errors", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    clickEjectIcon(ejectSlotId());
    await settleSpawns(1);
    kid(0).emitError(new Error("spawn ENOENT"));
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("error");
    ejectChrome.dispose();
  });

  test("a spawn error settles once: the trailing close never toasts twice", async () => {
    // node fires error AND close on ENOENT — without a settled guard one
    // failure yields two error toasts
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    clickEjectIcon(ejectSlotId());
    await settleSpawns(1);
    kid(0).emitError(new Error("spawn ENOENT"));
    kid(0).emitClose(-2);
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    ejectChrome.dispose();
  });

  test("ejectDevice leaves the device's mountpoint before unmounting", async () => {
    // the context-menu Eject row builds the same spec object the icon path
    // uses, so ejectDevice can leave first either way
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    cwd = "/media/usb/some/dir";
    ejectChrome.ejectDevice({ device: "/dev/sdb1", label: "usb", target: "/media/usb" });
    expect(calls.navigate).toEqual([fakeHome]);
    await settleSpawns(1);
    expect(spawns).toEqual([["unmount", "-b", "/dev/sdb1"]]);
    ejectChrome.dispose();
  });

  test("an RM=0 USB hard drive shows an ejectable row (TRAN=usb)", async () => {
    // the bridge lies about RM — without the TRAN rule this row would be a
    // mounted harddisk with no eject affordance at all
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    const rec = ejectChrome.placesHost.find((r) => r.place.path === "/media/hdd1");
    expect(rec).toBeTruthy();
    expect(rec!.place.ejectable).toBe(true);
    expect(rec!.place.icon).toBe("usb");
    expect(rec!.place.disk).toBe("/dev/sdc");
  });

  test("ejecting one partition unmounts every partition, then powers off", async () => {
    // a two-partition USB HDD: power-off with a part still mounted fails, so
    // the chain covers the whole disk even though the click names one row
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    clickEjectIcon(ejectSlotId("/media/hdd1"));
    await settleSpawns(1);
    kid(0).emitClose(0);
    await settleSpawns(2);
    kid(1).emitClose(0);
    await settleSpawns(3);
    expect(spawns).toEqual([
      ["unmount", "-b", "/dev/sdc1"],
      ["unmount", "-b", "/dev/sdc2"],
      ["power-off", "-b", "/dev/sdc"],
    ]);
    kid(2).emitClose(0);
    await settleUntilNotifies(1);
    expect(notifies[0]![0]).toMatch(/safe to unplug/i);
    expect(notifies[0]![2]).toBe("success");
    ejectChrome.dispose();
  });

  test("ejecting from a sibling partition still leaves the disk first", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    cwd = "/media/hdd2/docs";
    clickEjectIcon(ejectSlotId("/media/hdd1"));
    // left the disk (not just the clicked row) before unmounting anything
    expect(calls.navigate).toEqual([fakeHome]);
    await settleSpawns(1);
    expect(spawns[0]).toEqual(["unmount", "-b", "/dev/sdc1"]);
    ejectChrome.dispose();
  });

  test("a failed power-off after clean unmounts says the data is safe", async () => {
    resetSeams();
    await loadSystemPlaces();
    ejectChrome.renderSidebar();
    await t.renderOnce();
    clickEjectIcon(ejectSlotId());
    await settleSpawns(1);
    kid(0).emitClose(0);
    await settleSpawns(2);
    kid(1).emitClose(1);
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("error");
    // unmounted = flushed, so the toast says so — but never claims the
    // drive spun down or is safe to yank
    expect(notifies[0]![0]).toMatch(/data is safe/i);
    expect(notifies[0]![0]).not.toMatch(/safe to unplug/i);
    ejectChrome.dispose();
  });

  test("a signal-killed child toasts killed, not exit null", async () => {
    // the 10s spawnSafe kill-switch SIGKILLs wedged children: close arrives
    // with code null, and `exit null` in a toast reads like a bug
    resetSeams();
    ejectChrome.mountDevice("/dev/sdc");
    await settleSpawns(1);
    kid(0).emitClose(null as never);
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("error");
    expect(notifies[0]![0]).toMatch(/killed/);
    expect(notifies[0]![0]).not.toMatch(/null/);
    ejectChrome.dispose();
  });

  test("mount toasts success on exit 0", async () => {
    resetSeams();
    ejectChrome.mountDevice("/dev/sdc");
    expect(spawns).toEqual([["mount", "-b", "/dev/sdc"]]);
    child().emitClose(0);
    // mount toasts ride the spawnWait promise (a microtask past emitClose)
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("success");
    ejectChrome.dispose();
  });

  test("mount toasts failure on a non-zero exit", async () => {
    resetSeams();
    ejectChrome.mountDevice("/dev/sdc");
    child().emitClose(1);
    await settleUntilNotifies(1);
    expect(notifies.length).toBe(1);
    expect(notifies[0]![2]).toBe("error");
    ejectChrome.dispose();
  });
});
