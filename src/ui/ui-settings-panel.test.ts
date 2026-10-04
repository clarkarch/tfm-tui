import { describe, expect, test } from "bun:test";
import {
  ensureVisible,
  fitDescText,
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
    // longest real label is 24 chars ("include filename in lift") — sliced at
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
