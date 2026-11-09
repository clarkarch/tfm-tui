import { describe, expect, test } from "bun:test";
import {
  clampToVisible,
  fitDescText,
  fitValueText,
  flatVisible,
  scrollFor,
  sectionKey,
  SETTINGS_MAX_W,
  settingsPanelWidth,
  settingsWidths,
  settingsVisRows,
} from "./ui-settings-panel";
import type { SettingRow } from "./settings";

// Pure scroll-window math (the panel widget is pinned through makeEscMenu in
// ui-settings.test.ts; this covers the no-cursor state in isolation).

describe("scrollFor (the window offset that keeps the cursor visible)", () => {
  test("ignores the no-cursor state (never scrolls to -1)", () => {
    expect(scrollFor(5, 12, -1, 3)).toBe(3);
  });

  test("scrolls up/down to keep a real cursor visible", () => {
    expect(scrollFor(5, 12, 1, 3)).toBe(1);
    expect(scrollFor(5, 12, 9, 3)).toBe(5);
  });

  test("clamps the window to the visible total", () => {
    expect(scrollFor(10, 4, 3, 0)).toBe(0);
  });

  test("keeps the offset when the cursor is already visible", () => {
    expect(scrollFor(5, 12, 4, 3)).toBe(3);
  });
});

describe("panel geometry (room for the description footer)", () => {
  test("panel width adapts to the terminal like the help view", () => {
    expect(SETTINGS_MAX_W).toBe(80);
    expect(settingsPanelWidth(200)).toBe(80);
    expect(settingsPanelWidth(90)).toBe(80);
    expect(settingsPanelWidth(80)).toBe(76);
    expect(settingsPanelWidth(40)).toBe(64);
  });

  test("columns widen with the panel so labels/values stop truncating", () => {
    // longest real label is 23 chars ("directory bar animation") — sliced at
    // the old 22; a wide panel must fit it, the floor keeps the old widths
    expect(settingsWidths(80).labelW).toBe(27);
    expect(settingsWidths(78).labelW).toBe(25);
    expect(settingsWidths(64).labelW).toBe(22);
    expect(settingsWidths(80).valW).toBe(16);
    expect(settingsWidths(80).keyW).toBe(24);
  });

  test("description footer fills the panel width", () => {
    expect(fitDescText("x".repeat(200), 80).length).toBe(76);
    expect(fitDescText("x".repeat(200), 64).length).toBe(60);
  });

  test("taller window on roomy terminals, still compact on tiny ones", () => {
    expect(settingsVisRows(40)).toBe(20);
    expect(settingsVisRows(24)).toBe(12);
    expect(settingsVisRows(16)).toBe(8);
  });
});

const tgl = (label: string): SettingRow => ({ kind: "toggle", label, get: () => false, set: () => {} });
const hdr = (label: string): SettingRow => ({ kind: "header", label });

describe("collapsible sections (flatVisible projection)", () => {
  const rows: SettingRow[] = [tgl("theme"), hdr("sizes"), tgl("w"), tgl("h"), hdr("grid"), tgl("tile")];

  test("section keys are stable per category + subsection", () => {
    expect(sectionKey("layout", "sizes")).toBe("layout::sizes");
    expect(sectionKey("layout", "sizes")).not.toBe(sectionKey("layout", "grid"));
    expect(sectionKey("layout", "sizes")).not.toBe(sectionKey("panes", "sizes"));
  });

  test("nothing collapsed: every index visible", () => {
    expect(flatVisible(rows, "layout", new Set())).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("collapsed section hides its children but keeps the header", () => {
    const vis = flatVisible(rows, "layout", new Set(["layout::sizes"]));
    expect(vis).toEqual([0, 1, 4, 5]);
  });

  test("leading headerless rows always stay visible", () => {
    const vis = flatVisible(rows, "layout", new Set(["layout::sizes", "layout::grid"]));
    expect(vis).toEqual([0, 1, 4]);
  });

  test("unknown keys collapse nothing", () => {
    expect(flatVisible(rows, "layout", new Set(["other::sizes"]))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("fitValueText (centered value cells)", () => {
  test("short values pad both sides so the text sits centered", () => {
    expect(fitValueText("on", 6)).toBe("  on  ");
    expect(fitValueText("22", 15)).toBe("      22       ");
  });

  test("odd leftover puts the extra space on the right", () => {
    expect(fitValueText("off", 6)).toBe(" off  ");
  });

  test("exact-fit values pass through untouched", () => {
    expect(fitValueText("123456", 6)).toBe("123456");
  });

  test("long values truncate like before (no wider than the room)", () => {
    expect(fitValueText("tokyo-night-extra-long", 15)).toBe("tokyo-night-ext");
  });
});

describe("clampToVisible (gated-rebuild cursor parking)", () => {
  test("keeps a still-visible cursor where it is", () => {
    expect(clampToVisible([0, 1, 3], 3)).toBe(3);
  });

  test("parks on the nearest visible row at or above the vanished one", () => {
    // row 2 hidden by its master toggle: cursor was on it
    expect(clampToVisible([0, 1, 3], 2)).toBe(1);
  });

  test("cursor below every visible row parks on the first visible row", () => {
    expect(clampToVisible([2, 3], 0)).toBe(2);
  });

  test("empty projection parks on -1 (no cursor)", () => {
    expect(clampToVisible([], 0)).toBe(-1);
  });
});
