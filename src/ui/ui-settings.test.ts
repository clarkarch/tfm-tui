import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeEscMenu } from "./ui-settings";
import { makeFloats } from "./floats";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { SettingGroup, SettingRow } from "./settings";

// Headless widget test (createTestRenderer pilot: ui-menu.test.ts). Pins the
// esc-menu + settings panel through the PUBLIC makeEscMenu surface only, so
// the ui-settings/ui-settings-panel split cannot change behavior: root view,
// settings two-pane layout, windowed scrolling, pane tab, per-kind row
// adjust/activate, the keybind capture flow (valid/invalid/cancel) and the
// floats open/close policy.

const colors = defaultConfig.theme as Theme & Record<string, any>;
const TERM_H = 24;

// fake rows mirroring the real settings-model row shapes
const mkRows = (): SettingRow[] => {
  const stepper = { v: 20 };
  const cycle = { i: 0 };
  const keybind = { binds: ["ctrl+q"] };
  const toggle = { on: false };
  const action = { ran: 0 };
  const rows: SettingRow[] = [
    { kind: "toggle", label: "show hidden", get: () => toggle.on, set: (v) => (toggle.on = v) },
    {
      kind: "stepper",
      label: "sidebar width",
      min: 16,
      max: 60,
      step: 2,
      fmt: (v) => String(v),
      get: () => stepper.v,
      set: (v) => (stepper.v = v),
    },
    {
      kind: "cycle",
      label: "theme",
      names: ["tokyo-night", "gruvbox"],
      getIdx: () => cycle.i,
      setIdx: (i) => (cycle.i = i),
    },
    { kind: "keybind", label: "quit", get: () => keybind.binds, set: (v) => (keybind.binds = v) },
    { kind: "action", label: "edit config.toml", keepOpen: false, run: () => action.ran++ },
  ];
  return rows;
};

const mkGroups = (rowCount = 5): SettingGroup[] => {
  const rows = mkRows().slice(0, rowCount) as any[];
  const big: SettingGroup[] = [{ header: "general", rows }];
  // a scrollable category for the windowing contract (vis = min(14, 24-12) = 12)
  big.push({
    header: "behavior",
    rows: Array.from({ length: 20 }, (_, i) => ({
      kind: "stepper" as const,
      label: `knob-${i}`,
      min: 0,
      max: 9,
      step: 1,
      fmt: (v: number) => String(v),
      get: () => i,
      set: () => {},
    })),
  });
  big.push({ header: "keybindings", rows: mkRows().filter((r) => r.kind === "keybind") });
  return big;
};

let t: TestRendererSetup;
let floats: ReturnType<typeof makeFloats>;
let menu: ReturnType<typeof makeEscMenu>;
let scrim: boolean;
let cancelledBand: number;
let warns: Array<[string, string | undefined]>;
let groups: SettingGroup[];
let quitCalls: number;

beforeAll(async () => {
  t = await createTestRenderer({ width: 90, height: TERM_H });
  floats = makeFloats();
  scrim = false;
  cancelledBand = 0;
  warns = [];
  groups = mkGroups();
  quitCalls = 0;
  let iconSeq = 0;

  menu = makeEscMenu({
    renderer: () => t.renderer,
    byId: (id) => t.renderer.root.findDescendantById(id),
    clearChildren: (node) => {
      for (const c of [...node.getChildren()]) node.remove(c);
    },
    stripSelectable: () => {},
    escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
    makeIconSlot: (name: string, states: any, heightCells?: number, initialState?: number) => {
      const slotId = `slot-${iconSeq++}`;
      return {
        el: null,
        slotId,
        spec: { slotId, name, heightCells: heightCells ?? 1, states, initialState: initialState ?? 0 },
      };
    },
    drainIconQueue: () => {},
    setScrim: (on) => {
      scrim = on;
    },
    cancelBand: () => {
      cancelledBand++;
    },
    colors: () => colors,
    uiStyle: () => "solid",
    menuW: () => 36,
    settingGroups: () => groups,
    warn: (message, title) => {
      warns.push([message, title]);
    },
    floats,
    log: () => {},
    quit: () => {
      quitCalls++;
    },
  });
});

afterAll(() => {
  t.renderer.destroy();
});

// openMenu is a no-op while open (shared instance state across tests) — close
// first so every test starts from the root view with reset cursor/pane/capture
const openSettings = async () => {
  menu.closeMenu();
  await t.renderOnce();
  menu.openMenu();
  menu.menuActivate(); // root cursor is Settings (keepOpen) — switches the view
  await t.renderOnce();
};

const bgInts = (id: string): number[] => {
  const n: any = t.renderer.root.findDescendantById(id);
  return n?.backgroundColor ? [...n.backgroundColor.toInts()] : [0, 0, 0, 0];
};
const hexInts = (hex: string): number[] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
};
// Text renderables read content back as {chunks:[{text}]} — normalize to a string
const text = (id: string): string => {
  const n: any = t.renderer.root.findDescendantById(id);
  const c = n?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c?.chunks)) return c.chunks.map((x: any) => x?.text ?? "").join("");
  if (Array.isArray(c)) return c.map((x: any) => x?.text ?? "").join("");
  return c?.text ?? "";
};

describe("esc-menu root view", () => {
  test("openMenu mounts the scrim + panel and paints the root items", async () => {
    menu.openMenu();
    await t.renderOnce();
    expect(t.renderer.root.findDescendantById("tfm-menu")).toBeTruthy();
    expect(t.renderer.root.findDescendantById("tfm-menu-panel")).toBeTruthy();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Settings");
    expect(frame).toContain("Quit");
    expect(floats.isOpen("escmenu")).toBe(true);
    expect(scrim).toBe(true);
    expect(cancelledBand).toBe(1); // a modal kills in-flight rubber-band
    menu.closeMenu();
    await t.renderOnce();
  });

  test("root activate: Quit closes the menu and runs; nothing leaks into floats", async () => {
    menu.openMenu();
    await t.renderOnce();
    menu.moveMenu(1); // cursor to Quit
    menu.menuActivate();
    await t.renderOnce();
    expect(quitCalls).toBe(1);
    expect(floats.isOpen("escmenu")).toBe(false);
    expect(scrim).toBe(false);
    expect(t.renderer.root.findDescendantById("tfm-menu")).toBeFalsy();
  });
});

describe("settings view", () => {
  test("activating Settings keeps the menu open and mounts the two panes", async () => {
    await openSettings();
    expect(floats.isOpen("escmenu")).toBe(true);
    expect(t.renderer.root.findDescendantById("tfm-set-cat-0")).toBeTruthy();
    expect(t.renderer.root.findDescendantById("tfm-set-row-0")).toBeTruthy();
    const frame = t.captureCharFrame();
    expect(frame).toContain("show hidden");
    expect(frame).toContain("sidebar width");
    expect(frame).toContain("Menu — settings");
  });

  test("row adjust: toggle flips on/accent, stepper steps within bounds, cycle wraps", async () => {
    // toggle row 0
    menu.menuActivate();
    await t.renderOnce();
    expect(text("tfm-set-rowv-0")).toBe("on");
    // stepper row 1: 20 -> 22 (step 2, in bounds)
    menu.moveMenu(1);
    menu.adjustSelectedSetting(1);
    await t.renderOnce();
    expect(text("tfm-set-rowv-1")).toBe("22");
    // cycle row 2: tokyo-night -> gruvbox -> tokyo-night (wraps)
    menu.moveMenu(1);
    menu.adjustSelectedSetting(1);
    menu.adjustSelectedSetting(1);
    await t.renderOnce();
    expect(text("tfm-set-rowv-2")).toBe("tokyo-night");
  });

  test("hover paints the hovered row by id WITHOUT a rebuild (prev row restored)", async () => {
    await openSettings();
    (t.renderer.root.findDescendantById("tfm-set-row-2") as any).processMouseEvent({
      type: "over",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    await t.renderOnce();
    expect(bgInts("tfm-set-row-2")).toEqual(hexInts(colors.accentBg));
    expect(bgInts("tfm-set-row-0")).toEqual([0, 0, 0, 0]); // initial row cleared
  });

  test("tab toggles panes; category switch repaints the active cat", async () => {
    await openSettings();
    menu.menuTab(); // rows -> cats
    menu.adjustSelectedSetting(1); // in cats pane = switchCategory(+1)
    await t.renderOnce();
    expect(bgInts("tfm-set-cat-1")).toEqual(hexInts(colors.accentBg));
    menu.menuTab(); // back to rows
    menu.adjustSelectedSetting(1); // rows pane again = value adjust
    await t.renderOnce();
  });

  test("windowed scrolling: the right pane caps at vis rows and the counter tracks the cursor", async () => {
    await openSettings();
    // switch to the 20-row behavior category via the cats pane — the switch
    // itself focuses the rows pane (switchCategory sets pane="rows")
    menu.menuTab();
    menu.adjustSelectedSetting(1);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("1-12 of 20"); // vis = 12 at termH 24
    // walk the cursor to the last row: window follows
    for (let i = 0; i < 19; i++) menu.moveMenu(1);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("9-20 of 20");
    // wrap-around from the end returns to the top window
    menu.moveMenu(1);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("1-12 of 20");
  });
});

describe("keybind capture", () => {
  test("enter on a keybind row starts capture; a valid key commits; invalid warns and retries", async () => {
    await openSettings();
    // row 3 = keybind "quit"
    for (let i = 0; i < 3; i++) menu.moveMenu(1);
    menu.menuActivate(); // startCapture
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("press a key…");

    // bare letter = reserved for type-to-search -> warn, stay in capture
    expect(menu.captureKey({ name: "a", ctrl: false, shift: false, meta: false })).toBe(true);
    expect(warns.length).toBe(1);
    expect(warns[0]![0]).toContain("type-to-search");
    expect(t.captureCharFrame()).toContain("press a key…"); // still capturing

    // ctrl+f is valid -> committed via row.set, capture ends
    expect(menu.captureKey({ name: "f", ctrl: true, shift: false, meta: false })).toBe(true);
    await t.renderOnce();
    const keyRow = groups[0]!.rows.find((r) => r.kind === "keybind") as { get(): string[] };
    expect(keyRow.get()).toEqual(["ctrl+f"]);
    expect(t.captureCharFrame()).not.toContain("press a key…");
  });

  test("escape cancels capture without committing; while armed every key is swallowed", async () => {
    await openSettings();
    for (let i = 0; i < 3; i++) menu.moveMenu(1);
    menu.menuActivate(); // arm capture on the keybind row
    await t.renderOnce();
    // a valid key while armed is consumed by the capture (committed to the row)
    expect(menu.captureKey({ name: "z", ctrl: true, shift: false, meta: false })).toBe(true);
    const binds = (groups[0]!.rows.find((r) => r.kind === "keybind") as { get(): string[] }).get();
    expect(binds).toEqual(["ctrl+z"]);
    // re-arm, then escape: nothing changes
    menu.menuActivate();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("press a key…");
    expect(menu.captureKey({ name: "escape", ctrl: false, shift: false, meta: false })).toBe(true);
    await t.renderOnce();
    expect((groups[0]!.rows.find((r) => r.kind === "keybind") as { get(): string[] }).get()).toEqual(binds);
  });
});

describe("action rows + close policy", () => {
  test("a non-keepOpen action closes the menu, then runs", async () => {
    await openSettings();
    // switch to the keybindings category (row 0 there is the keybind row; use
    // the general category's action row instead: row 4)
    for (let i = 0; i < 4; i++) menu.moveMenu(1);
    menu.menuActivate();
    await t.renderOnce();
    expect(floats.isOpen("escmenu")).toBe(false);
  });
});
