import { describe, expect, test } from "bun:test";
import {
  clampToVisible,
  ensureVisible,
  fitDescText,
  fitValueText,
  flatVisible,
  sectionKey,
  SETTINGS_MAX_W,
  settingsPanelWidth,
  settingsWidths,
  settingsVisRows,
  type SettingsPanelState,
} from "./ui-settings-panel";
import type { SettingRow } from "./settings";

// Pure scroll-window math (the panel widget is pinned through makeEscMenu in
// ui-settings.test.ts; this covers the no-cursor sentinel in isolation).

const panelState = (over: Partial<SettingsPanelState> = {}): SettingsPanelState => ({
  catIdx: 0,
  menuIdx: -1,
  pane: "rows",
  scrollOff: 3,
  hoverCat: -1,
  capturing: null,
  swapOffer: null,
  collapsed: new Set<string>(),
  ...over,
});

describe("ensureVisible", () => {
  test("ignores the no-cursor sentinel (never scrolls to -1)", () => {
    const st = panelState({ menuIdx: -1, scrollOff: 3 });
    ensureVisible(st, 5, 12, -1);
    expect(st.scrollOff).toBe(3);
  });

  test("scrolls up/down to keep a real cursor visible", () => {
    const up = panelState({ scrollOff: 3 });
    ensureVisible(up, 5, 12, 1);
    expect(up.scrollOff).toBe(1);

    const down = panelState({ scrollOff: 3 });
    ensureVisible(down, 5, 12, 9);
    expect(down.scrollOff).toBe(5);
  });

  test("clamps the window to the visible total", () => {
    const st = panelState({ scrollOff: 0 });
    ensureVisible(st, 10, 4, 3);
    expect(st.scrollOff).toBe(0);
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
