import { describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { filterItems, fuzzyScore, makePick, type PickItem } from "./ui-pick";
import type { NodeLike } from "../lib/node-like";
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
    renderer: () => t.renderer,
    byId: (id) => t.renderer.root.findDescendantById(id),
    rootAdd: (n) => t.renderer.root.add(n),
    clearChildren: (node) => {
      // the ctx hands over a real node; this fake only touches the tree API
      const n = node as NodeLike;
      for (const c of [...n.getChildren()]) n.remove(c);
    },
    stripSelectable: () => {},
    colors: getColors,
    uiStyle: () => "solid",
    floats,
    escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
    drainIconQueue: () => {},
    commands,
    ...(onError ? { onError } : {}),
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
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
      t.renderer.destroy();
    }
  });
});
