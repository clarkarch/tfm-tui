import { describe, expect, test } from "bun:test";
import { ensureVisible, type SettingsPanelState } from "./ui-settings-panel";

// Pure scroll-window math (the panel widget is pinned through makeEscMenu in
// ui-settings.test.ts; this covers the no-cursor sentinel in isolation).

const panelState = (over: Partial<SettingsPanelState> = {}): SettingsPanelState => ({
  catIdx: 0,
  menuIdx: -1,
  pane: "rows",
  scrollOff: 3,
  hoverCat: -1,
  capturing: null,
  ...over,
});

describe("ensureVisible", () => {
  test("ignores the no-cursor sentinel (never scrolls to -1)", () => {
    const st = panelState({ menuIdx: -1, scrollOff: 3 });
    ensureVisible(st, 5);
    expect(st.scrollOff).toBe(3);
  });

  test("scrolls up/down to keep a real cursor visible", () => {
    const up = panelState({ menuIdx: 1, scrollOff: 3 });
    ensureVisible(up, 5);
    expect(up.scrollOff).toBe(1);

    const down = panelState({ menuIdx: 9, scrollOff: 3 });
    ensureVisible(down, 5);
    expect(down.scrollOff).toBe(5);
  });
});
