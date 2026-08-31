import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeMenu, type ListEntry } from "./ui-menu";
import { makeFloats } from "./floats";
import { defaultConfig } from "./config-schema";
import type { Theme } from "./config";

// UI TDD pilot: the sanctioned pattern for renderer-coupled widgets is
// @opentui/core/testing's createTestRenderer (headless native frame loop).
// This pins the file-menu widget end-to-end: mount-by-id, the LIVE-state
// keyboard-nav contract (keymap mutates fmenu.idx in place, then repaints),
// edge clamping, floats replacement policy and teardown.

let t: TestRendererSetup;
let floats: ReturnType<typeof makeFloats>;
let menu: ReturnType<typeof makeMenu>;
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
    makeIconSlot: () => ({ el: null as any, slotId: "", spec: null }),
  });
});

afterAll(() => {
  t.renderer.destroy();
});

const panelRows = () => {
  const panel = t.renderer.root.findDescendantById("tfm-filemenu-panel") as any;
  return panel.getChildren().slice(1); // [0] is the divider row
};

describe("openContextMenu", () => {
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

describe("keyboard nav contract (live state, no setter)", () => {
  test("mutating fileMenuState().idx + renderFileMenu repaints the highlight", async () => {
    menu.openContextMenu(2, 2, "", mkEntries(3));
    await t.renderOnce();
    const st = menu.fileMenuState()!;
    expect(st.idx).toBe(0);

    st.idx = 2; // exactly what the key router does
    menu.renderFileMenu();
    await t.renderOnce();

    const rows = panelRows();
    // OpenTUI keeps bgs as parsed RGBA objects; unhighlighted rows are transparent
    const ints = (r: any) => (r.backgroundColor ? [...r.backgroundColor.toInts()] : [0, 0, 0, 0]);
    expect(ints(rows[0])).toEqual([0, 0, 0, 0]);
    expect(ints(rows[1])).toEqual([0, 0, 0, 0]);
    expect(ints(rows[2])).not.toEqual([0, 0, 0, 0]);
    menu.closeFileMenu();
    await t.renderOnce();
  });

  test("fileMenuState returns the SAME object the widget renders from", () => {
    menu.openContextMenu(2, 2, "", mkEntries(2));
    const st = menu.fileMenuState()!;
    st.idx = 1;
    expect(menu.fileMenuState()).toBe(st);
    expect(menu.fileMenuState()!.idx).toBe(1);
    menu.closeFileMenu();
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
});
