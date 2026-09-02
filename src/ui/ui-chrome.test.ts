import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { MouseButtons } from "@opentui/core/testing";
import { makeChrome } from "./ui-chrome";
import { gridDrag } from "../input/grid-input";
import { defaultConfig } from "../config/config-schema";
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
  iconStates: Array<{ spec: any; idx: number }>;
};
let cwd: string;
let tabBar: boolean;
let tabModel: { list: Tab[]; active: number };
let kbActive: boolean;
let kbIdx: number;

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
    iconStates: [],
  };
  cwd = HOME;
  tabBar = false;
  tabModel = { list: mkTabs(2), active: 1 };
  kbActive = false;
  kbIdx = -1;

  const host = Box(
    { flexDirection: "row" },
    Box({ id: "tfm-places", flexDirection: "column", width: 20 }),
    Box({ id: "tfm-tabbar", flexDirection: "row", height: 1 }),
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
    },
    moveInto: (dest, items) => {
      calls.moveInto.push([dest, items]);
      return Promise.resolve();
    },
    kbActive: () => kbActive,
    kbIdx: () => kbIdx,
    tabs: () => tabModel,
    closeTab: (i) => {
      calls.closeTab.push(i);
    },
    switchTab: (i) => {
      calls.switchTab.push(i);
    },
    newTab: () => {
      calls.newTab++;
    },
    hoverBtn: () => Box({ id: "tfm-tab-new", width: 3, height: 1 }),
    stripSelectable: () => {},
    drainIconQueue: () => {},
    makeIconSlot: (name: string, states: any, heightCells?: number, initialState?: number) => ({
      el: null,
      slotId: `slot-${name}`,
      spec: {
        slotId: `slot-${name}`,
        name,
        heightCells: heightCells ?? 1,
        states,
        initialState: initialState ?? 0,
      },
    }),
    setIconState: (spec, idx) => {
      calls.iconStates.push({ spec, idx });
      return true;
    },
    home: HOME,
    stateCwd: () => cwd,
  });
});

afterAll(() => {
  if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgData;
  gridDrag.keys = null;
  gridDrag.active = false;
  rmSync(trashSandbox, { recursive: true, force: true });
  t.renderer.destroy();
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
    chrome.renderTabbar();
    await t.renderOnce();
    expect(byId("tfm-tab-0")).toBeTruthy();
    expect(byId("tfm-tab-1")).toBeTruthy();
    expect(byId("tfm-tab-new")).toBeTruthy();
    expect(t.captureCharFrame()).toContain("dir1"); // active tab title paints
  });

  test("visibility: adaptive (off) hides the strip for a single tab, the setting forces it", () => {
    const bar: any = byId("tfm-tabbar");
    tabModel = { list: mkTabs(1), active: 0 };
    chrome.renderTabbar();
    expect(bar.visible).toBe(false); // adaptive, one tab
    tabModel = { list: mkTabs(2), active: 0 };
    chrome.renderTabbar();
    expect(bar.visible).toBe(true); // adaptive, two tabs
    tabBar = true;
    tabModel = { list: mkTabs(1), active: 0 };
    chrome.renderTabbar();
    expect(bar.visible).toBe(true); // forced on
    tabBar = false;
    tabModel = { list: mkTabs(2), active: 1 };
  });

  test("clicking a chip switches tabs; middle-click closes it", () => {
    const chip0: any = byId("tfm-tab-0");
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

  test("dropping a single dragged folder on a chip navigates that tab to it", async () => {
    tabModel = { list: mkTabs(2), active: 1 }; // previous test rendered a 1-tab bar
    chrome.renderTabbar();
    await t.renderOnce();
    gridDrag.keys = [{ path: "/x/afolder", isDir: true }];
    (byId("tfm-tab-1") as any).processMouseEvent({
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
    (byId("tfm-tab-1") as any).processMouseEvent({
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
});
