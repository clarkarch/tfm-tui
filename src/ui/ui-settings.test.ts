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
  big.push({ header: "keys", rows: mkRows().filter((r) => r.kind === "keybind") });
  return big;
};

let t: TestRendererSetup;
let floats: ReturnType<typeof makeFloats>;
let menu: ReturnType<typeof makeEscMenu>;
let scrim: boolean;
let cancelledBand: number;
let warns: Array<[string, string | undefined]>;
let groups: SettingGroup[];
let plugGroups: SettingGroup[];
let quitCalls: number;
// icon names requested through the slot sink (the entry's icon choice is
// observable here — the sink IS the seam, not fake bookkeeping)
let requestedIcons: string[];
// rescan hook: openMenu re-reads the plugins dir so added/removed plugins
// reflect without a restart (code edits still need one — Bun module cache)
let reloadImpl: () => Promise<unknown>;
let reloadCalls: number;

beforeAll(async () => {
  t = await createTestRenderer({ width: 90, height: TERM_H });
  floats = makeFloats();
  scrim = false;
  cancelledBand = 0;
  warns = [];
  groups = mkGroups();
  plugGroups = [];
  quitCalls = 0;
  requestedIcons = [];
  reloadCalls = 0;
  reloadImpl = async () => {
    reloadCalls++;
  };
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
      requestedIcons.push(name);
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
    pluginGroups: () => plugGroups,
    reloadPlugins: () => reloadImpl(),
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
// first so every test starts from the root view. BOTH views now open with NO
// cursor (menuIdx -1); these tests select the first row explicitly to reach
// the historic "row 0 active" baseline (a dedicated test pins the no-cursor
// default).
const openSettings = async () => {
  menu.closeMenu();
  await t.renderOnce();
  menu.openMenu();
  menu.moveMenu(1); // root: down fills first row = Settings
  menu.menuActivate(); // keepOpen -> switches the view
  menu.moveMenu(1); // settings: down fills first row (baseline)
  await t.renderOnce();
};

const bgInts = (id: string): number[] => {
  const n: any = t.renderer.root.findDescendantById(id);
  return n?.backgroundColor ? [...n.backgroundColor.toInts()] : [0, 0, 0, 0];
};
const fgInts = (id: string): number[] => {
  const n: any = t.renderer.root.findDescendantById(id);
  const fg = n?.fg;
  if (fg && typeof fg.toInts === "function") return [...fg.toInts()];
  return fg;
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
    menu.moveMenu(-1); // up from no-cursor fills the LAST row = Quit
    menu.menuActivate();
    await t.renderOnce();
    expect(quitCalls).toBe(1);
    expect(floats.isOpen("escmenu")).toBe(false);
    expect(scrim).toBe(false);
    expect(t.renderer.root.findDescendantById("tfm-menu")).toBeFalsy();
  });

  test("the root menu opens with no cursor; enter is a no-op until an arrow", async () => {
    const before = quitCalls;
    menu.openMenu();
    await t.renderOnce();
    menu.menuActivate(); // no cursor -> nothing happens
    await t.renderOnce();
    expect(quitCalls).toBe(before);
    expect(floats.isOpen("escmenu")).toBe(true);
    menu.closeMenu();
    await t.renderOnce();
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
      // "move": hover-select is driven by motion so a post-rebuild synthetic
      // "over" can't steal the cursor (see ui-menu hover/arrow regression)
      type: "move",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    await t.renderOnce();
    expect(bgInts("tfm-set-row-2")).toEqual(hexInts(colors.accentBg));
    expect(bgInts("tfm-set-row-0")).toEqual([0, 0, 0, 0]); // initial row cleared
  });

  test("selected toggle reads white (not accent); unselected on-toggle keeps the accent cue", async () => {
    await openSettings();
    // row 0 = toggle; flip it while selected — the value must read white
    // on the highlighted row regardless of on/off
    menu.menuActivate();
    await t.renderOnce();
    const shown = text("tfm-set-rowv-0");
    expect(["on", "off"]).toContain(shown);
    expect(fgInts("tfm-set-rowv-0")).toEqual(hexInts(colors.white));
    // move off: value falls back to the on/accent cue (or muted when off)
    menu.moveMenu(1);
    await t.renderOnce();
    expect(fgInts("tfm-set-rowv-0")).toEqual(shown === "on" ? hexInts(colors.accent) : hexInts(colors.sidebarFgMuted));
  });

  test("chevrons follow the row highlight; synthetic over never steals the cursor", async () => {
    await openSettings();
    const move = (id: string, type: string) =>
      (t.renderer.root.findDescendantById(id) as any)?.processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
    move("tfm-set-row-1", "move");
    await t.renderOnce();
    expect(bgInts("tfm-set-row-1")).toEqual(hexInts(colors.accentBg));
    expect(fgInts("tfm-chev-1--1")).toEqual(hexInts(colors.white));
    expect(fgInts("tfm-chev-1-1")).toEqual(hexInts(colors.white));
    // a stationary-cursor synthetic "over" on the old row must not move anything
    move("tfm-set-row-0", "over");
    await t.renderOnce();
    expect(bgInts("tfm-set-row-1")).toEqual(hexInts(colors.accentBg));
    expect(bgInts("tfm-set-row-0")).toEqual([0, 0, 0, 0]);
  });

  test("header hover-off restores the muted label (not the value-row gray)", async () => {
    const keep = groups;
    groups = [
      {
        header: "general",
        rows: [
          { kind: "toggle", label: "aaa", get: () => false, set: () => {} },
          { kind: "header", label: "section one" },
          { kind: "toggle", label: "bbb", get: () => false, set: () => {} },
        ],
      },
    ];
    try {
      menu.closeMenu();
      await t.renderOnce();
      menu.openMenu();
      menu.moveMenu(1);
      menu.menuActivate();
      await t.renderOnce();
      const move = (id: string) =>
        (t.renderer.root.findDescendantById(id) as any)?.processMouseEvent({
          type: "move",
          button: 0,
          x: 0,
          y: 0,
          modifiers: { shift: false, alt: false, ctrl: false },
        });
      move("tfm-set-row-1");
      await t.renderOnce();
      expect(bgInts("tfm-set-row-1")).toEqual(hexInts(colors.accentBg));
      move("tfm-set-row-2");
      await t.renderOnce();
      expect(bgInts("tfm-set-row-1")).toEqual([0, 0, 0, 0]);
      expect(fgInts("tfm-set-rowl-1")).toEqual(hexInts(colors.sidebarFgMuted));
    } finally {
      groups = keep;
      menu.closeMenu();
      await t.renderOnce();
    }
  });

  test("root-menu hover repaints by id without rebuilding the panel", async () => {
    menu.closeMenu();
    await t.renderOnce();
    menu.openMenu();
    await t.renderOnce();
    const panel: any = t.renderer.root.findDescendantById("tfm-menu-panel");
    const before = [...panel.getChildren()].length;
    (t.renderer.root.findDescendantById("tfm-root-row-1") as any)?.processMouseEvent({
      type: "move",
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
    });
    await t.renderOnce();
    expect(bgInts("tfm-root-row-1")).toEqual(hexInts(colors.accentBg));
    expect([...(t.renderer.root.findDescendantById("tfm-menu-panel") as any).getChildren()].length).toBe(before);
    menu.closeMenu();
    await t.renderOnce();
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
    expect(t.captureCharFrame()).toContain("1-10 of 20"); // vis = 10 at termH 24
    // walk the cursor to the last row: window follows
    for (let i = 0; i < 19; i++) menu.moveMenu(1);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("11-20 of 20");
    // wrap-around from the end returns to the top window
    menu.moveMenu(1);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("1-10 of 20");
  });

  test("headers take the cursor and collapse/expand on activate (no more skip)", async () => {
    const keep = groups;
    let ran = 0;
    groups = [
      {
        header: "general",
        rows: [
          { kind: "toggle", label: "aaa", get: () => false, set: () => {} },
          { kind: "header", label: "section one" },
          { kind: "toggle", label: "bbb", get: () => false, set: () => {} },
          { kind: "action", label: "ccc", keepOpen: true, run: () => ran++ },
        ],
      },
    ];
    try {
      menu.closeMenu();
      await t.renderOnce();
      menu.openMenu();
      menu.moveMenu(1); // root: down fills Settings
      menu.menuActivate();
      await t.renderOnce();
      // the section header paints with its chevron and no option count...
      expect(t.captureCharFrame()).toContain("section one");
      expect(t.captureCharFrame()).toContain("▼");
      expect(t.captureCharFrame()).not.toMatch(/section one\s*\(\d+\)/);
      expect(t.renderer.root.findDescendantById("tfm-set-row-1")).toBeTruthy();
      // the view opens with no cursor: first arrow fills row 0...
      menu.moveMenu(1);
      await t.renderOnce();
      expect(bgInts("tfm-set-row-0")).toEqual(hexInts(colors.accentBg));
      // ...second arrow LANDS on the header (it takes the cursor now)
      menu.moveMenu(1);
      await t.renderOnce();
      expect(bgInts("tfm-set-row-1")).toEqual(hexInts(colors.accentBg));
      // activate collapses the section: bbb vanishes, counter reports it
      menu.menuActivate();
      await t.renderOnce();
      expect(t.captureCharFrame()).not.toContain("bbb");
      expect(t.captureCharFrame()).toContain("▶");
      expect(t.captureCharFrame()).toContain("collapsed");
      // cursor parks on the header, menu stays open
      expect(bgInts("tfm-set-row-1")).toEqual(hexInts(colors.accentBg));
      expect(floats.isOpen("escmenu")).toBe(true);
      // activate again re-expands
      menu.menuActivate();
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("bbb");
      // arrows walk through the header in both directions (no skipping)
      menu.moveMenu(1); // header -> bbb
      await t.renderOnce();
      expect(bgInts("tfm-set-row-2")).toEqual(hexInts(colors.accentBg));
      menu.moveMenu(-1); // bbb -> header
      await t.renderOnce();
      expect(bgInts("tfm-set-row-1")).toEqual(hexInts(colors.accentBg));
      menu.moveMenu(-1); // header -> aaa
      await t.renderOnce();
      expect(bgInts("tfm-set-row-0")).toEqual(hexInts(colors.accentBg));
      expect(ran).toBe(0);
    } finally {
      groups = keep;
      menu.closeMenu();
      await t.renderOnce();
    }
  });

  test("description footer shows the row blurb and follows the cursor; no hint line", async () => {
    const keep = groups;
    groups = [
      {
        header: "general",
        rows: [
          { kind: "toggle", label: "aaa", blurb: "first thing explained", get: () => false, set: () => {} },
          { kind: "toggle", label: "bbb", blurb: "second thing explained", get: () => false, set: () => {} },
        ],
      },
    ];
    try {
      menu.closeMenu();
      await t.renderOnce();
      menu.openMenu();
      menu.moveMenu(1); // root: down fills Settings
      menu.menuActivate();
      await t.renderOnce();
      // no cursor yet: placeholder, and the old hint line is gone
      expect(t.captureCharFrame()).toContain("Choose a setting");
      expect(t.captureCharFrame()).not.toContain("↑↓ move");
      menu.moveMenu(1); // cursor on aaa
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("first thing explained");
      menu.moveMenu(1); // cursor on bbb — footer follows live
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("second thing explained");
      expect(t.captureCharFrame()).not.toContain("first thing explained");
      // hover moves the footer too (by-id paint, no rebuild)
      (t.renderer.root.findDescendantById("tfm-set-row-0") as any).processMouseEvent({
        type: "move",
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("first thing explained");
    } finally {
      groups = keep;
      menu.closeMenu();
      await t.renderOnce();
    }
  });

  test("collapsing under the cursor parks it on the header (never hidden)", async () => {
    const keep = groups;
    groups = [{ header: "empty", rows: [{ kind: "header", label: "nothing here" }] }];
    try {
      menu.closeMenu();
      await t.renderOnce();
      menu.openMenu();
      menu.moveMenu(1); // root: down fills Settings
      menu.menuActivate();
      await t.renderOnce();
      menu.moveMenu(1); // nowhere interactive to land — parks on the header
      menu.menuActivate(); // must not throw, must not close
      menu.adjustSelectedSetting(1);
      menu.adjustSelectedSetting(-1);
      await t.renderOnce();
      expect(floats.isOpen("escmenu")).toBe(true);
      expect(t.captureCharFrame()).toContain("nothing here");
    } finally {
      groups = keep;
      menu.closeMenu();
      await t.renderOnce();
    }
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
    expect(warns[0]![1]).toBe("invalid keybind");
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

describe("plugins view (separate from settings)", () => {
  const openRoot = async () => {
    menu.closeMenu();
    await t.renderOnce();
    menu.openMenu();
    await t.renderOnce();
  };

  // hand-built groups (the toggle construction itself is pinned in
  // settings-model.test — here the view only renders what it's given)
  const helloGroup = (run: () => void): SettingGroup => ({
    header: "hello",
    rows: [
      { kind: "toggle", label: "enabled", get: () => true, set: () => {} },
      { kind: "action", label: "Say hello", run },
    ],
  });

  test("root menu shows Plugins iff a plugin category exists", async () => {
    plugGroups = [];
    await openRoot();
    expect(t.captureCharFrame()).not.toContain("Plugins");
    plugGroups = [helloGroup(() => {})];
    requestedIcons.length = 0;
    await openRoot();
    expect(t.captureCharFrame()).toContain("Plugins");
    // F06A5 (md-power_plug) through the whole pipeline, not cog-box
    expect(requestedIcons).toContain("power-plug");
    expect(requestedIcons).not.toContain("cog-box");
    plugGroups = [];
  });

  test("activating Plugins opens its own view rendering that plugin's rows", async () => {
    plugGroups = [helloGroup(() => {})];
    await openRoot();
    menu.moveMenu(1); // no cursor -> Settings
    menu.moveMenu(1); // Settings -> Plugins
    menu.menuActivate();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Say hello");
    expect(frame).toContain("enabled"); // core-built on/off toggle, first row
    expect(frame).toContain("Menu — plugins");
    // core settings stay out of the plugins view
    expect(frame).not.toContain("sidebar width");
    plugGroups = [];
  });

  test("plugin action runs without closing the menu only when keepOpen", async () => {
    let ran = 0;
    plugGroups = [helloGroup(() => ran++)];
    await openRoot();
    menu.moveMenu(1); // no cursor -> Settings
    menu.moveMenu(1); // Settings -> Plugins
    menu.menuActivate();
    await t.renderOnce();
    menu.moveMenu(1); // view opens with no cursor -> enabled toggle
    menu.moveMenu(1); // -> "Say hello"
    menu.menuActivate(); // activates the "Say hello" row (no keepOpen -> closes)
    expect(ran).toBe(1);
    expect(floats.isOpen("escmenu")).toBe(false);
    plugGroups = [];
  });

  test("openMenu rescans the plugins dir (adds/removes without restart)", async () => {
    plugGroups = [];
    reloadCalls = 0;
    await openRoot();
    expect(reloadCalls).toBe(1);
    menu.closeMenu();
    await t.renderOnce();
    await openRoot();
    expect(reloadCalls).toBe(2);
    plugGroups = [];
  });

  test("rows arriving with the rescan render once it settles", async () => {
    plugGroups = [];
    let release!: () => void;
    reloadImpl = () => new Promise<void>((r) => (release = r));
    menu.closeMenu();
    await t.renderOnce();
    menu.openMenu();
    await t.renderOnce();
    // rescan lands while the menu is open with new rows available
    plugGroups = [helloGroup(() => {})];
    release();
    const deadline = Date.now() + 2000;
    while (!t.captureCharFrame().includes("Plugins") && Date.now() < deadline) {
      await t.renderOnce();
    }
    expect(t.captureCharFrame()).toContain("Plugins");
    menu.closeMenu();
    await t.renderOnce();
    reloadImpl = async () => {
      reloadCalls++;
    };
    plugGroups = [];
  });
});

describe("action rows + close policy", () => {
  test("a non-keepOpen action closes the menu, then runs", async () => {
    await openSettings();
    // switch to the keys category (row 0 there is the keybind row; use
    // the general category's action row instead: row 4)
    for (let i = 0; i < 4; i++) menu.moveMenu(1);
    menu.menuActivate();
    await t.renderOnce();
    expect(floats.isOpen("escmenu")).toBe(false);
  });
});

describe("menu placement", () => {
  test("esc menu opens vertically centered, not top-third", async () => {
    menu.closeMenu();
    await t.renderOnce();
    menu.openMenu();
    await t.renderOnce();
    const panel: any = t.renderer.root.findDescendantById("tfm-menu-panel");
    expect(panel).toBeTruthy();
    // yogaNode is protected (TS-level only) — reachable at runtime; the
    // computed top IS the painted position, not a prop echo
    const yoga = panel.yogaNode;
    const top = yoga.getComputedTop();
    const h = yoga.getComputedHeight();
    const scrim: any = t.renderer.root.findDescendantById("tfm-menu");
    // centered in the terminal (yoga rounding may drift a cell)…
    expect(Math.abs(top - (TERM_H - h) / 2)).toBeLessThanOrEqual(1);
    // …and the old top-third pad is gone (a coincident height could satisfy
    // the centering formula under the old code — zero pad kills that hole)
    expect(scrim.yogaNode.getComputedPadding(1)).toBe(0); // Edge.Top
  });
});

describe("no initial cursor (fresh views)", () => {
  test("a freshly entered settings view highlights nothing until an arrow", async () => {
    menu.closeMenu();
    await t.renderOnce();
    menu.openMenu();
    menu.moveMenu(1); // root: down fills Settings
    menu.menuActivate();
    await t.renderOnce();
    // no row selected yet
    expect(bgInts("tfm-set-row-0")).toEqual([0, 0, 0, 0]);
    menu.moveMenu(1); // first arrow selects row 0
    await t.renderOnce();
    expect(bgInts("tfm-set-row-0")).toEqual(hexInts(colors.accentBg));
    menu.closeMenu();
    await t.renderOnce();
  });
});
