import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeMenu, type ListEntry } from "./ui-menu";
import { makeFloats } from "./floats";
import { deriveSystemTheme, type TerminalPaletteInput } from "../config/system-theme";
import type { Theme } from "../config/config";
import { chromeSurface, floatSurface, applySurface } from "./style";

// Repro for "System theme leaves outline + floating UI unthemed": mount the
// REAL file menu plus outline/float surfaces under System-DERIVED themes
// (dark, light, hostile terminal replies) and assert what actually paints —
// node bg/borderColor as ints plus painted frame text. If this is green, the
// defect is in the query path (terminal answers), not the paint path.

const hexInts = (hex: string): [number, number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};
const nodeInts = (n: any): [number, number, number, number] =>
  n?.backgroundColor ? (n.backgroundColor.toInts() as [number, number, number, number]) : [0, 0, 0, 0];
const borderInts = (n: any): [number, number, number, number] =>
  n?.borderColor ? (n.borderColor.toInts() as [number, number, number, number]) : [0, 0, 0, 0];
const MAGENTA: [number, number, number, number] = [255, 0, 255, 255];

const darkInput = (): TerminalPaletteInput => ({
  palette: [
    "#16161e",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
    "#565f89",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
  ],
  defaultForeground: "#c0caf5",
  defaultBackground: "#1a1b26",
  cursorColor: "#ff9e64",
});

// hostile terminal replies: short palette, uppercase, rgb:-form, empties,
// invalid cursor — everything outside #rrggbb must fall back, never leak
const hostileInput = (): TerminalPaletteInput => ({
  palette: ["#FF9E64", "rgb:ffff/9e9e/6464", "", null] as Array<string | null>,
  defaultForeground: "#C0CAF5",
  defaultBackground: "#1A1B26",
  cursorColor: "#GGGGGG",
});

const fixtures: Array<[string, TerminalPaletteInput]> = [
  ["dark", darkInput()],
  ["light", { ...darkInput(), defaultForeground: "#333333", defaultBackground: "#fafafa", cursorColor: "#0066cc" }],
  ["hostile", hostileInput()],
  [
    "all-null",
    {
      palette: new Array(16).fill(null),
      defaultForeground: null,
      defaultBackground: null,
      cursorColor: null,
    },
  ],
];

let t: TestRendererSetup;
const floats = makeFloats();

beforeAll(async () => {
  t = await createTestRenderer({ width: 80, height: 24 });
});

afterAll(() => {
  t.renderer.destroy();
});

const mkMenu = (colors: Theme) =>
  makeMenu({
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
    makeIconSlot: (name) => ({ el: Box({ width: 1, height: 1 }), slotId: `slot-${name}`, spec: null as any }),
  });

const entries: ListEntry[] = [
  { label: "alpha", action: () => {} },
  { label: "beta", action: () => {} },
];

describe("system-derived theme paints floating UI", () => {
  for (const [name, input] of fixtures) {
    test(`file menu paints derived sidebarBg, never magenta (${name})`, async () => {
      const theme = deriveSystemTheme(input, null);
      const menu = mkMenu(theme);
      menu.openContextMenu(5, 5, "", entries);
      await t.renderOnce();
      const node = t.renderer.root.findDescendantById("tfm-filemenu") as any;
      expect(node).toBeTruthy();
      expect(nodeInts(node)).toEqual(hexInts(theme.sidebarBg));
      expect(nodeInts(node)).not.toEqual(MAGENTA);
      expect(t.captureCharFrame()).toContain("alpha");
      menu.closeFileMenu();
      await t.renderOnce();
    });

    test(`outline chrome ring paints derived border (${name})`, async () => {
      const theme = deriveSystemTheme(input, null);
      const panel: any = Box({ id: "tfm-repro-outline", width: 20, height: 5 });
      applySurface(panel, chromeSurface("outline", theme, theme.sidebarBg));
      t.renderer.root.add(panel);
      await t.renderOnce();
      const node = t.renderer.root.findDescendantById("tfm-repro-outline") as any;
      expect(node.border).toBe(true);
      expect(borderInts(node)).toEqual(hexInts(theme.border));
      expect(borderInts(node)).not.toEqual([0, 0, 0, 0]);
      t.renderer.root.remove(node);
      await t.renderOnce();
    });

    test(`pure-outline float keeps its border ring (${name})`, async () => {
      const theme = deriveSystemTheme(input, null);
      const panel: any = Box({ id: "tfm-repro-float", width: 20, height: 5 });
      applySurface(panel, floatSurface("outline", theme, theme.sidebarBg));
      t.renderer.root.add(panel);
      await t.renderOnce();
      const node = t.renderer.root.findDescendantById("tfm-repro-float") as any;
      expect(node.border).toBe(true);
      expect(borderInts(node)).toEqual(hexInts(theme.border));
      t.renderer.root.remove(node);
      await t.renderOnce();
    });
  }
});
