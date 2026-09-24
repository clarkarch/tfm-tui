import { describe, expect, test } from "bun:test";
import {
  ensureVisible,
  flatVisible,
  sectionKey,
  SETTINGS_W,
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
  test("panel is 78 wide", () => {
    expect(SETTINGS_W).toBe(78);
  });

  test("taller window on roomy terminals, still compact on tiny ones", () => {
    expect(settingsVisRows(40)).toBe(18);
    expect(settingsVisRows(24)).toBe(10);
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
