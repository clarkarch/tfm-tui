import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, MouseButtons, type TestRendererSetup } from "@opentui/core/testing";
import { makeMenu } from "./ui-menu";
import { CLOSED_FLYOUT, cursorAt, cursorIndex, openFlyout } from "../lib/uiutil";
import type { ListEntry } from "../lib/menu-entry";
import { makeFloats } from "./floats";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";

// UI TDD pilot: the sanctioned pattern for renderer-coupled widgets is
// @opentui/core/testing's createTestRenderer (headless native frame loop).
// This pins the file-menu widget end-to-end: mount-by-id, the keyboard-nav
// contract (the MENU owns the cursor — the router asks it to move/activate),
// edge clamping, floats replacement policy and teardown.

let t: TestRendererSetup;
let floats: ReturnType<typeof makeFloats>;
let menu: ReturnType<typeof makeMenu>;
// mouse pointer shapes requested through the ctx seam (OSC 22 sink)
const pointers: string[] = [];
// icon slots requested by the widget (chevron-right for submenu rows, etc.)
const iconSlots: string[] = [];
const colors = defaultConfig.theme as Theme & Record<string, any>;

const mkEntries = (n: number): ListEntry[] =>
  Array.from({ length: n }, (_, i) => ({ label: `entry-${i}`, action: () => {} }));

beforeAll(async () => {
  t = await createTestRenderer({ width: 80, height: 24 });
  floats = makeFloats();
  menu = makeMenu({
    byId: (id) => t.renderer.root.findDescendantById(id),
    rootAdd: (node) => t.renderer.root.add(node),
    termW: () => 80,
    termH: () => 24,
    stripSelectable: () => {},
    drainIconQueue: () => {},
    uiStyle: () => "solid",
    colors: () => colors,
    menuW: 36,
    floats,
    setPointer: (s) => void pointers.push(s),
    // real node so painted frames work (the widget wraps the raster in a box)
    makeIconSlot: (name) => {
      iconSlots.push(name);
      return { el: Box({ width: 1, height: 1 }), slotId: `slot-${name}`, spec: null as any };
    },
  });
});

afterAll(() => t.dispose()); // 0.6.0: destroy + await closed

const panelRows = () => {
  const panel = t.renderer.root.findDescendantById("tfm-filemenu-panel") as any;
  return panel.getChildren().slice(1); // [0] is the divider row
};

describe("openContextMenu", () => {
  test("opens with NO cursor highlight", async () => {
    menu.openContextMenu(5, 5, "", [{ sep: true, label: "", action: () => {} }, ...mkEntries(2)]);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(-1);
    const ints = (r: any) => (r.backgroundColor ? [...r.backgroundColor.toInts()] : [0, 0, 0, 0]);
    for (const r of panelRows()) expect(ints(r)).toEqual([0, 0, 0, 0]);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("mounts the menu node and paints the entries", async () => {
    menu.openContextMenu(5, 5, "", mkEntries(3));
    await t.renderOnce();
    expect(t.renderer.root.findDescendantById("tfm-filemenu")).toBeTruthy();
    const frame = t.captureCharFrame();
    expect(frame).toContain("entry-0");
    expect(frame).toContain("entry-2");
    expect(menu.isFileMenuOpen()).toBe(true);
    expect(floats.isOpen("filemenu")).toBe(true);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("clamps to the terminal edges", async () => {
    menu.openContextMenu(79, 23, "", mkEntries(3));
    await t.renderOnce();
    const node = t.renderer.root.findDescendantById("tfm-filemenu") as any;
    // px + w > termW - 1 -> px = 80 - 36 - 1; h = 3 entries + 2 chrome rows
    expect(node.left).toBe(43);
    expect(node.top).toBe(24 - 5 - 1);
    menu.closeFileMenu();
    await t.renderOnce();
  });
});

describe("keyboard nav contract (the menu owns the cursor)", () => {
  // The menu is the ONE owner of its cursor: the key router ASKS it to move
  // or activate, it never writes the state. The router used to mutate the
  // live state object in place — two owners for one cursor (the mouse path
  // here, the keyboard path in the router), free to drift apart.
  const moveDown = (times = 1): void => {
    for (let i = 0; i < times; i++) menu.moveMain(1);
  };
  const ints = (r: any) => (r.backgroundColor ? [...r.backgroundColor.toInts()] : [0, 0, 0, 0]);

  test("moveMain repaints the highlight on the cursor's row", async () => {
    menu.openContextMenu(2, 2, "", mkEntries(3));
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(-1);

    moveDown(3); // no cursor -> first row -> ... -> the third row
    await t.renderOnce();

    const rows = panelRows();
    // OpenTUI keeps bgs as parsed RGBA objects; unhighlighted rows are transparent
    expect(ints(rows[0])).toEqual([0, 0, 0, 0]);
    expect(ints(rows[1])).toEqual([0, 0, 0, 0]);
    expect(ints(rows[2])).not.toEqual([0, 0, 0, 0]);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("the keyboard and the mouse agree on the cursor after a move", async () => {
    menu.openContextMenu(2, 2, "", mkEntries(3));
    await t.renderOnce();
    // the mouse picks row 1: screen y = py(2) + divider(1) + index(1)
    await t.mockMouse.moveTo(4, 4);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(1);

    // the keyboard moves on to row 2 — ONE cursor, both paths land on it
    moveDown();
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(2);
    expect(ints(panelRows()[2])).not.toEqual([0, 0, 0, 0]);

    // the mouse arriving on the SAME row agrees (no snap-back, no second cursor)
    await t.mockMouse.moveTo(4, 5);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(2);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("enter on an open flyout with no highlighted row does nothing VISIBLY", async () => {
    const calls: string[] = [];
    menu.openContextMenu(5, 5, "", [
      {
        label: "Open",
        action: () => calls.push("parent"),
        submenu: [{ label: "Open in New Tab", action: () => calls.push("sub") }],
      },
    ]);
    await t.renderOnce();
    moveDown(); // the cursor onto the parent row
    await t.renderOnce();
    menu.openSubmenu(); // the flyout opens with NO row highlighted
    await t.renderOnce();
    expect(menu.fileMenuState()!.flyout).toEqual(openFlyout());

    const before = t.captureCharFrame();
    menu.activate(); // enter
    await t.renderOnce();

    // nothing ran: the flyout has no row, so enter has no target
    expect(calls).toEqual([]);
    // and nothing changed: the flyout is still open, still without a cursor
    expect(menu.fileMenuState()!.flyout).toEqual(openFlyout());
    const subPanel = t.renderer.root.findDescendantById("tfm-filemenu-sub-panel") as any;
    for (const r of subPanel.getChildren().slice(1)) expect(ints(r)).toEqual([0, 0, 0, 0]);
    expect(t.captureCharFrame()).toBe(before);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("fileMenuState returns the LIVE object the widget renders from", () => {
    menu.openContextMenu(2, 2, "", mkEntries(2));
    const st = menu.fileMenuState()!;
    menu.moveMain(1);
    expect(menu.fileMenuState()).toBe(st);
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(0);
    menu.closeFileMenu();
  });

  test("enter fires the cursor's row action", async () => {
    const calls: string[] = [];
    menu.openContextMenu(5, 5, "", [
      { label: "first", action: () => calls.push("first") },
      { label: "second", action: () => calls.push("second") },
    ]);
    await t.renderOnce();
    moveDown();
    menu.activate();
    expect(calls).toEqual(["first"]);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("moving the main cursor closes the flyout", async () => {
    const entries: ListEntry[] = [
      { label: "Open", action: () => {}, submenu: [{ label: "Open in New Tab", action: () => {} }] },
      { label: "Trash", action: () => {} },
    ];
    menu.openContextMenu(5, 5, "", entries);
    await t.renderOnce();
    menu.moveMain(1); // the parent row
    menu.openSubmenu();
    await t.renderOnce();
    expect(menu.fileMenuState()!.flyout.kind).toBe("open");
    menu.moveMain(1); // onto the next row
    await t.renderOnce();
    expect(menu.fileMenuState()!.flyout).toEqual(CLOSED_FLYOUT);
    expect(t.renderer.root.findDescendantById("tfm-filemenu-sub")).toBeFalsy();
    menu.closeFileMenu();
    await t.renderOnce();
  });
});

describe("close + floats policy", () => {
  test("closeFileMenu removes the node and clears state", async () => {
    menu.openContextMenu(4, 4, "", mkEntries(2));
    await t.renderOnce();
    menu.closeFileMenu();
    await t.renderOnce();
    expect(t.renderer.root.findDescendantById("tfm-filemenu")).toBeFalsy();
    expect(menu.isFileMenuOpen()).toBe(false);
    expect(floats.isOpen("filemenu")).toBe(false);
  });
  test("re-opening replaces the popup (exactly one menu node on the tree)", async () => {
    menu.openContextMenu(4, 4, "", mkEntries(2));
    await t.renderOnce();
    menu.openContextMenu(6, 6, "", mkEntries(4));
    await t.renderOnce();
    let count = 0;
    const walk = (n: any) => {
      if (n.id === "tfm-filemenu") count++;
      try {
        for (const c of n.getChildren()) walk(c);
      } catch {}
    };
    walk(t.renderer.root);
    expect(count).toBe(1);
    const frame = t.captureCharFrame();
    expect(frame).toContain("entry-3"); // the NEW entries render
    expect(frame).not.toContain("entry-0\n"); // stale ones are gone
    menu.closeFileMenu();
    await t.renderOnce();
  });
  test("a right-click that lands as a modal opens replaces the modal — one floating UI", async () => {
    // a right-click in the same frame as a modal open slips past the modal's
    // scrim (the scrim has no layout yet): the context menu must REPLACE the
    // modal, not stack on top of it (two floating UIs on screen at once)
    let modalClosed = false;
    floats.open("escmenu", () => {
      modalClosed = true;
    });
    menu.openContextMenu(4, 4, "", mkEntries(2));
    await t.renderOnce();
    expect(modalClosed).toBe(true);
    expect(floats.isOpen("escmenu")).toBe(false);
    expect(floats.isOpen("filemenu")).toBe(true);
    expect(floats.depth()).toBe(1);
    menu.closeFileMenu();
    await t.renderOnce();
  });
  test("a NESTED popup (the props permission menu) keeps the modal below it", async () => {
    let modalClosed = false;
    floats.open("props", () => {
      modalClosed = true;
    });
    menu.openContextMenu(4, 4, "", mkEntries(2), { keepModalBelow: true });
    await t.renderOnce();
    expect(modalClosed).toBe(false);
    expect(floats.isOpen("props")).toBe(true);
    expect(floats.isOpen("filemenu")).toBe(true);
    expect(floats.depth()).toBe(2);
    menu.closeFileMenu();
    await t.renderOnce();
    expect(floats.isOpen("props")).toBe(true);
    floats.close("props");
    await t.renderOnce();
  });
});

describe("flyout submenus", () => {
  test("chevron paints; opening the flyout mounts and activates items", async () => {
    const subCalls: string[] = [];
    const entries: ListEntry[] = [
      {
        label: "Open",
        action: () => {},
        submenu: [
          { label: "Open", action: () => subCalls.push("open") },
          { label: "Open With…", action: () => subCalls.push("openwith") },
        ],
      },
      { label: "Trash", action: () => {} },
    ];
    menu.openContextMenu(5, 5, "", entries);
    await t.renderOnce();
    // submenu rows rasterize the chevron via an icon slot, not a text glyph
    expect(iconSlots).toContain("chevron-right");
    expect(menu.fileMenuState()!.flyout).toEqual(CLOSED_FLYOUT);
    // no cursor on open — the parent must be selected before a flyout opens
    menu.moveMain(1);

    menu.openSubmenu();
    await t.renderOnce();
    expect(menu.fileMenuState()!.flyout).toEqual(openFlyout()); // open, no cursor
    expect(t.renderer.root.findDescendantById("tfm-filemenu-sub")).toBeTruthy();
    expect(t.captureCharFrame()).toContain("Open With…");

    menu.moveSub(1); // first move fills the first item
    expect(menu.fileMenuState()!.flyout).toEqual(openFlyout(cursorAt(0)));
    menu.activateSub();
    expect(subCalls).toEqual(["open"]);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("flies out to the LEFT when the right edge would overflow", async () => {
    const entries: ListEntry[] = [{ label: "Open", action: () => {}, submenu: [{ label: "Open", action: () => {} }] }];
    // px clamps to 80-36-1=43; right flyout (43+36+36) overflows -> flip left
    menu.openContextMenu(60, 5, "", entries);
    await t.renderOnce();
    menu.moveMain(1);
    menu.openSubmenu();
    await t.renderOnce();
    const sub = t.renderer.root.findDescendantById("tfm-filemenu-sub") as any;
    expect(sub.left).toBe(menu.fileMenuState()!.px - 36);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("clicking a submenu parent fires its own action (flyout opens on hover)", async () => {
    const calls: string[] = [];
    menu.openContextMenu(5, 5, "", [
      {
        label: "Open",
        action: () => calls.push("parent"),
        submenu: [{ label: "Open in New Tab", action: () => calls.push("sub") }],
      },
    ]);
    await t.renderOnce();
    // divider paints at py, so row 0 sits at py + 1
    await t.mockMouse.click(7, 6, MouseButtons.LEFT);
    await t.renderOnce();
    expect(calls).toEqual(["parent"]);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("closing the menu tears the flyout down too", async () => {
    const entries: ListEntry[] = [{ label: "Open", action: () => {}, submenu: [{ label: "Open", action: () => {} }] }];
    menu.openContextMenu(3, 3, "", entries);
    await t.renderOnce();
    menu.moveMain(1);
    menu.openSubmenu();
    await t.renderOnce();
    expect(t.renderer.root.findDescendantById("tfm-filemenu-sub")).toBeTruthy();
    menu.closeFileMenu();
    await t.renderOnce();
    expect(t.renderer.root.findDescendantById("tfm-filemenu-sub")).toBeFalsy();
    expect(t.renderer.root.findDescendantById("tfm-filemenu")).toBeFalsy();
  });
});

describe("mouse pointer shapes (ctx seam sink)", () => {
  test("row hover sets pointer, close restores default", async () => {
    pointers.length = 0;
    menu.openContextMenu(2, 2, "", mkEntries(3));
    await t.renderOnce();
    // hover row 1: screen y = py(2) + divider(1) + index(1)
    await t.mockMouse.moveTo(4, 4);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(1);
    expect(pointers).toEqual(["pointer"]);
    menu.closeFileMenu();
    await t.renderOnce();
    expect(pointers).toEqual(["pointer", "default"]);
  });

  test("hovering the keyboard-highlighted row still sets pointer (no change, still positioned)", async () => {
    // the pointer is position truth, the highlight is change truth: moving
    // onto the row the keyboard cursor already sits on must set the shape
    // even though no repaint runs
    pointers.length = 0;
    menu.openContextMenu(2, 2, "", mkEntries(3));
    await t.renderOnce();
    menu.moveMain(1); // the keyboard's path onto row 1
    menu.moveMain(1);
    await t.renderOnce();
    await t.mockMouse.moveTo(4, 4);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(1);
    expect(pointers).toEqual(["pointer"]);
    menu.closeFileMenu();
    await t.renderOnce();
  });
});

describe("hover vs arrow keys (stationary-mouse regression)", () => {
  test("a rebuild does not let a stationary hover steal the keyboard cursor", async () => {
    menu.openContextMenu(2, 2, "", mkEntries(3));
    await t.renderOnce();
    // hover row 1: screen y = py(2) + divider(1) + index(1)
    await t.mockMouse.moveTo(4, 4);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(1);

    // arrow nav to row 2, which rebuilds the panel (hit grid changes; the
    // renderer then re-fires synthetic "over" on the row under the mouse)
    menu.moveMain(1);
    await t.renderOnce();
    expect(cursorIndex(menu.fileMenuState()!.cursor)).toBe(2); // not snapped back to row 1

    menu.closeFileMenu();
    await t.renderOnce();
  });
});
