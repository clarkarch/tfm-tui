import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeChrome } from "./ui-chrome";
import { makeSidebarHover } from "./ui-sidebar-hover";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { IconSpec } from "./ui-slots";
import type { Tab } from "../app/tabs";

// End-to-end stuck-lift guard: the recording-stub test in ui-chrome.test.ts only
// proves normalizePlaces EMITS hoverRow(key,false) on a selection change. This
// wires the REAL makeSidebarHover behind chrome's hoverRow seam and asserts the
// real icon/label nodes actually snap back to translate 0 when a lifted row
// becomes the selected (cwd) row with the mouse resting on it (no out event).

const colors = defaultConfig.theme as Theme;
const HOME = os.homedir();

let t: TestRendererSetup;
let chrome: ReturnType<typeof makeChrome>;
let hover: ReturnType<typeof makeSidebarHover>;
let cwd: string;
let trashSandbox: string;
let savedXdgData: string | undefined;
let seq = 0;

const byId = (id: string) => t.renderer.root.findDescendantById(id);

const noop = () => {};
const mkTabs = (n: number): Tab[] => Array.from({ length: n }, (_, i) => ({ history: [`/d${i}`], histIdx: 0 }));

beforeAll(async () => {
  t = await createTestRenderer({ width: 80, height: 24 });
  savedXdgData = process.env.XDG_DATA_HOME;
  trashSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-hover-int-"));
  process.env.XDG_DATA_HOME = trashSandbox;
  mkdirSync(path.join(trashSandbox, "Trash", "files"), { recursive: true });
  cwd = HOME;

  const host = Box({ flexDirection: "row" }, Box({ id: "tfm-places", flexDirection: "column", width: 20 }));
  t.renderer.root.add(host);
  await t.renderOnce();

  // chrome's hoverRow seam forwards to the REAL animator (mirrors wiring/chrome)
  hover = makeSidebarHover({
    byId,
    rowRefs: () =>
      new Map(
        chrome.placesHost.map((r) => [
          r.rowId,
          { rowId: r.rowId, iconSlotId: r.specs[0]?.slotId ?? "", labelId: r.labelId, selected: r.selected },
        ]),
      ),
    hoverOpts: () => ({ enabled: true, direction: "left", includeLabel: true }),
  });

  chrome = makeChrome({
    byId,
    uiStyle: () => "solid",
    colors: () => colors,
    sw: () => 20,
    sideInnerW: () => 20,
    tabBar: () => false,
    renderAll: noop,
    navigate: noop,
    blurTerminal: noop,
    closeFileMenu: noop,
    openContextMenu: noop,
    sidebarEntriesFor: () => [],
    finishDrag: noop,
    dlog: noop,
    trashPaths: () => Promise.resolve(),
    moveInto: () => Promise.resolve(),
    kbActive: () => false,
    kbIdx: () => -1,
    tabs: (): { list: Tab[]; active: number } => ({ list: mkTabs(1), active: 0 }),
    focusPane: noop,
    closeTab: noop,
    switchTab: noop,
    newTab: noop,
    hoverBtn: () => Box({ width: 1, height: 1 }),
    stripSelectable: noop,
    drainIconQueue: noop,
    // real slot node mounted into the tree so its translate is observable
    makeIconSlot: (name: string): { el: any; slotId: string; spec: IconSpec } => {
      const slotId = `int-icon-${seq++}`;
      const el = Box({ id: slotId, width: 1, height: 1 }, Box({ id: `${slotId}-s0`, width: 1, height: 1 }));
      const spec = { slotId, name, heightCells: 1, states: [], initialState: 0, done: true } as unknown as IconSpec;
      return { el, slotId, spec };
    },
    setIconState: () => true,
    stateCwd: () => cwd,
    connectServer: noop,
    hoverRow: (key: string, hovered: boolean) => hover.playHover(key, hovered),
  });
});

afterAll(() => {
  if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgData;
  rmSync(trashSandbox, { recursive: true, force: true });
  t.renderer.destroy();
});

const fire = (id: string, type: "over" | "out") =>
  (byId(id) as any).processMouseEvent({
    type,
    button: 0,
    x: 0,
    y: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
  });

describe("sidebar hover lift (real animator + real chrome)", () => {
  test("a lift on a row snaps back to 0 when that row becomes selected (no mouse out)", async () => {
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();

    const target = chrome.placesHost.find((r) => !r.selected && r.place.path);
    expect(target).toBeTruthy();
    const iconId = target!.specs[0]!.slotId;

    // hover it (unselected) → the real node nudges one cell left
    fire(target!.rowId, "over");
    await t.renderOnce();
    expect((byId(iconId) as any).translateX).toBe(-1);

    // navigate cwd to the row; the mouse never leaves, so NO out event fires.
    // renderSidebar's fast path → normalizePlaces must clear the real node.
    cwd = target!.place.path!;
    chrome.renderSidebar();
    await t.renderOnce();
    expect((byId(iconId) as any).translateX).toBe(0);

    // the repaint changes the row's hit grid, so the real terminal re-fires a
    // SYNTHETIC over on the stationary cursor — the selected row must stay flat
    fire(target!.rowId, "over");
    await t.renderOnce();
    expect((byId(iconId) as any).translateX).toBe(0);
  });

  test("a lifted row clears when swept to by the cursor leaving it for another row", async () => {
    cwd = HOME;
    chrome.renderSidebar();
    await t.renderOnce();
    const a = chrome.placesHost.find((r) => !r.selected && r.place.path)!;
    const iconA = a.specs[0]!.slotId;
    fire(a.rowId, "over");
    await t.renderOnce();
    expect((byId(iconA) as any).translateX).toBe(-1);
    // real out restores
    fire(a.rowId, "out");
    await t.renderOnce();
    expect((byId(iconA) as any).translateX).toBe(0);
  });
});
