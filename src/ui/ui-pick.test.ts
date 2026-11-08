import { describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { filterItems, fuzzyScore, makePick, type PickItem } from "./ui-pick";
import { destroyChildren } from "../lib/uiutil";
import { makeFloats } from "./floats";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";

// Headless tests for the generic filter-list overlay (api.ui.pick primitive).
// Fuzzy scoring is pure; the widget is pinned through its PUBLIC surface
// (open/setFilter/move/activate/handleKey/close) plus painted frames.

describe("fuzzyScore", () => {
  test("empty query matches everything at zero", () => {
    expect(fuzzyScore("", "Quit")).toBe(0);
  });

  test("ranks prefix above word-boundary above gappy subsequence", () => {
    const q = "quit";
    const prefix = fuzzyScore(q, "quit tfm")!;
    const word = fuzzyScore(q, "don't quit me")!;
    const gap = fuzzyScore(q, "quickly update items table")!;
    expect(prefix).not.toBeNull();
    expect(word).not.toBeNull();
    expect(gap).not.toBeNull();
    expect(prefix).toBeLessThan(word);
    expect(word).toBeLessThan(gap);
  });

  test("case-insensitive; non-subsequence is null", () => {
    expect(fuzzyScore("QUT", "quit tfm")).not.toBeNull();
    expect(fuzzyScore("xyz", "quit tfm")).toBeNull();
    expect(fuzzyScore("quit tfm!", "quit tfm")).toBeNull();
  });

  test("filterItems sorts best-first and drops misses", () => {
    const items: PickItem[] = [
      { label: "quickly update items table", run: () => {} },
      { label: "quit tfm", run: () => {} },
      { label: "new tab", run: () => {} },
    ];
    expect(filterItems(items, "quit").map((i) => i.label)).toEqual(["quit tfm", "quickly update items table"]);
    expect(filterItems(items, "")).toHaveLength(3);
    expect(filterItems(items, "zzz")).toEqual([]);
  });
});

const colors = defaultConfig.theme as Theme;

// mouse pointer shapes requested through the ctx seam (OSC 22 sink)
const pointers: string[] = [];

const CMDS: PickItem[] = [
  { label: "new tab", hint: "ctrl+t", run: () => {} },
  { label: "quit tfm", hint: "ctrl+q", run: () => {} },
  { label: "toggle hidden files", hint: "ctrl+h", run: () => {} },
];

const mkPick = (
  t: TestRendererSetup,
  floats: ReturnType<typeof makeFloats>,
  commands: () => PickItem[],
  onError?: (err: unknown) => void,
  getColors: () => Theme = () => colors,
) =>
  makePick({
    byId: (id) => t.renderer.root.findDescendantById(id),
    rootAdd: (n) => t.renderer.root.add(n),
    // the ctx hands over a real node, so the REAL teardown is the honest fake
    destroyChildren,
    stripSelectable: () => {},
    colors: getColors,
    uiStyle: () => "solid",
    floats,
    escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
    drainIconQueue: () => {},
    commands,
    ...(onError ? { onError } : {}),
    setPointer: (s) => void pointers.push(s),
  });

const hexInts = (hex: string): [number, number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};

describe("pick widget", () => {
  test("open mounts scrim + panel + input; esc closes; empty query lists all", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      expect(t.renderer.root.findDescendantById("tfm-pick")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-pick-input")).toBeTruthy();
      expect(floats.isOpen("pick")).toBe(true);
      const frame = t.captureCharFrame();
      expect(frame).toContain("new tab");
      expect(frame).toContain("quit tfm");
      pick.handleKey({ name: "escape" });
      expect(floats.isOpen("pick")).toBe(false);
      expect(t.renderer.root.findDescendantById("tfm-pick")).toBeFalsy();
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("input bar keeps a blank row before the options", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      const lines = t.captureCharFrame().split("\n");
      const input = lines.findIndex((l) => l.includes("Type a command"));
      const first = lines.findIndex((l) => l.includes("new tab"));
      expect(input).toBeGreaterThanOrEqual(0);
      expect(first).toBe(input + 2); // exactly one blank spacer row
      expect(lines[input + 1]?.trim()).toBe("");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("setFilter narrows; activate runs the highlighted item and closes", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let ran = "";
      const pick = mkPick(t, floats, () => CMDS.map((c) => ({ ...c, run: () => (ran = c.label) })));
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      pick.setFilter("quit");
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("quit tfm");
      expect(frame).not.toContain("new tab");
      pick.handleKey({ name: "down" }); // no cursor until the first move
      pick.handleKey({ name: "return" });
      expect(ran).toBe("quit tfm");
      expect(floats.isOpen("pick")).toBe(false);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("no matches shows the empty row; return with no match is a safe no-op", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      pick.setFilter("zzz-nope");
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("No matching items");
      pick.handleKey({ name: "return" }); // nothing to run — stays open, no crash
      expect(floats.isOpen("pick")).toBe(true);
      pick.handleKey({ name: "escape" });
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("an async-rejecting pick item still closes and reports (no unhandled rejection)", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const errs: unknown[] = [];
      const pick = mkPick(
        t,
        floats,
        () => [
          {
            label: "slow boom",
            run: async () => {
              throw new Error("async-pick-boom");
            },
          },
        ],
        (e) => errs.push(e),
      );
      pick.open({ title: "Palette" });
      await t.renderOnce();
      pick.handleKey({ name: "down" });
      expect(() => pick.handleKey({ name: "return" })).not.toThrow();
      expect(floats.isOpen("pick")).toBe(false);
      await Bun.sleep(10);
      expect(errs.length).toBe(1);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("re-open while open replaces title/items (no stacked scrims)", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      pick.open({ title: "First", items: [{ label: "alpha one", run: () => {} }] });
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("alpha one");
      pick.open({ title: "Second", items: [{ label: "beta two", run: () => {} }] });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("beta two");
      expect(frame).not.toContain("alpha one");
      expect(floats.depth()).toBe(1);
      pick.handleKey({ name: "escape" });
      expect(floats.isOpen("pick")).toBe(false);
      expect(t.renderer.root.findDescendantById("tfm-pick")).toBeFalsy();
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a throwing pick item still closes and reports via onError", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const errs: unknown[] = [];
      const pick = mkPick(
        t,
        floats,
        () => [
          {
            label: "boom item",
            run: () => {
              throw new Error("pick-boom");
            },
          },
        ],
        (e) => errs.push(e),
      );
      pick.open({ title: "Palette" });
      await t.renderOnce();
      pick.handleKey({ name: "down" });
      expect(() => pick.handleKey({ name: "return" })).not.toThrow();
      expect(floats.isOpen("pick")).toBe(false);
      expect(errs.length).toBe(1);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("repaint() repaints panel + input + rows with live colors, keeps the filter", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let live: Theme = { ...colors };
      const pick = mkPick(
        t,
        floats,
        () => CMDS,
        undefined,
        () => live,
      );
      pick.open({ title: "Palette" });
      await t.renderOnce();
      pick.setFilter("quit");
      pick.handleKey({ name: "down" }); // cursor onto row 0 (filter alone leaves idx -1)
      await t.renderOnce();
      // theme switch while open: swap the palette behind the widget
      live = { ...colors, sidebarBg: "#101020", accentBg: "#303040", white: "#f0f0f0", accent: "#ff0000" };
      pick.repaint();
      await t.renderOnce();
      const panel = t.renderer.root.findDescendantById("tfm-pick-panel") as any;
      expect([...panel.backgroundColor.toInts()]).toEqual(hexInts("#101020"));
      const input = t.renderer.root.findDescendantById("tfm-pick-input") as any;
      expect([...input.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
      const row = t.renderer.root.findDescendantById("tfm-pick-row-0") as any;
      expect([...row.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
      // filter + content survive the repaint (no rebuild of the input)
      const frame = t.captureCharFrame();
      expect(frame).toContain("quit tfm");
      expect(frame).not.toContain("new tab");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("repaint() is a no-op when closed", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      expect(() => pick.repaint()).not.toThrow();
      expect(t.renderer.root.findDescendantById("tfm-pick")).toBeFalsy();
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("row hover sets pointer per motion, even with no cursor change", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      pointers.length = 0;
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      const move = (id: string) =>
        (t.renderer.root.findDescendantById(id) as any)?.processMouseEvent({
          type: "move",
          button: 0,
          x: 0,
          y: 0,
          modifiers: { shift: false, alt: false, ctrl: false },
        });
      move("tfm-pick-row-1");
      move("tfm-pick-row-1");
      expect(pointers).toEqual(["pointer", "pointer"]);
      pick.handleKey({ name: "escape" });
      expect(pointers).toEqual(["pointer", "pointer", "default"]);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("pick cursor", () => {
  // type into the pick's filter — the Input emits "input" on a value change,
  // which is exactly what the user's keystrokes do
  const typeInto = (t: TestRendererSetup, text: string): void => {
    const input = t.renderer.root.findDescendantById("tfm-pick-input") as any;
    input.value = text;
  };

  test("typing in the pick does not select the first row", async () => {
    // The filter narrows the list; it does not CHOOSE a row for the user —
    // the cursor is the user's explicit choice (an arrow key or a hover).
    // The owner's rule for the filtered list: "no cursor until the first
    // move" (the same as the setFilter seam).
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let ran = "";
      const pick = mkPick(t, floats, () => CMDS.map((c) => ({ ...c, run: () => (ran = c.label) })));
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      typeInto(t, "quit");
      await t.renderOnce();
      // no row is selected: Enter has no target
      pick.handleKey({ name: "return" });
      expect(ran).toBe("");
      expect(floats.isOpen("pick")).toBe(true);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a stale cursor is cleared, not moved", async () => {
    // The cursor names a POSITION in the current results: when the filter
    // changes, the row it named is a different item → the cursor is DROPPED.
    // Moving it onto another row would make Enter run a command the user
    // never chose.
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let ran = "";
      const pick = mkPick(t, floats, () => CMDS.map((c) => ({ ...c, run: () => (ran = c.label) })));
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      pick.move(1);
      pick.move(1);
      pick.move(1); // the cursor is on the last row
      typeInto(t, "new"); // the list narrows to one row — the cursor is stale
      await t.renderOnce();
      pick.handleKey({ name: "return" });
      expect(ran).toBe("");
      expect(floats.isOpen("pick")).toBe(true);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a filter change that reorders the list drops the cursor", async () => {
    // The cursor is a POSITION, not an item: a filter that REORDERS the
    // results leaves the position in range but pointing at a DIFFERENT
    // command. The cursor is dropped — Enter must not run that command.
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let ran = "";
      const pick = mkPick(t, floats, () => CMDS.map((c) => ({ ...c, run: () => (ran = c.label) })));
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      pick.move(1); // the cursor is on row 0 ("new tab")
      typeInto(t, "t"); // all three still match, but the best match is now first
      await t.renderOnce();
      pick.handleKey({ name: "return" });
      expect(ran).toBe("");
      expect(floats.isOpen("pick")).toBe(true);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the filter seam and the input handler agree — neither picks a row", async () => {
    // The two filter paths (the Input's "input" event and the test seam)
    // must land on the SAME cursor state: a filter narrows the list, it
    // never CHOOSES a row for the user.
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let ran = "";
      const pick = mkPick(t, floats, () => CMDS.map((c) => ({ ...c, run: () => (ran = c.label) })));
      pick.open({ title: "Command palette" });
      await t.renderOnce();
      pick.move(1); // the cursor is on row 0
      pick.setFilter("quit");
      await t.renderOnce();
      pick.handleKey({ name: "return" });
      expect(ran).toBe("");
      expect(floats.isOpen("pick")).toBe(true);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a replaced pick does not inherit the previous pick's deferred focus", async () => {
    // The deferred focus is tracked: a pick that is replaced before its
    // focus lands must not focus the NEW pick's input a second time (the new
    // pick focuses its own input).
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const pick = mkPick(t, floats, () => CMDS);
      pick.open({ title: "First" });
      pick.open({ title: "Second" }); // replaces the first pick
      const input = t.renderer.root.findDescendantById("tfm-pick-input") as any;
      let focuses = 0;
      const orig = input.focus.bind(input);
      input.focus = (): void => {
        focuses++;
        orig();
      };
      await Bun.sleep(60); // past the deferred focus
      expect(focuses).toBe(1);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});
