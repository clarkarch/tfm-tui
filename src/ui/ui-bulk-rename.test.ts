import { describe, expect, test } from "bun:test";
import { Text } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeFloats } from "./floats";
import { makeBulkRename } from "./ui-bulk-rename";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { NodeLike } from "../lib/node-like";

// Headless tests for the bulk-rename modal: one stem input + numbering-style
// chips + a live read-only preview. The apply sink is injected; everything
// else is the real widget. Pinned through open/setValue/handleKey plus frames.

const colors = defaultConfig.theme as Theme;

const mkBulk = (
  t: TestRendererSetup,
  floats: ReturnType<typeof makeFloats>,
  performed: Array<{ from: string; to: string }>,
  getColors: () => Theme = () => colors,
) =>
  makeBulkRename({
    renderer: () => t.renderer,
    byId: (id) => t.renderer.root.findDescendantById(id),
    rootAdd: (n) => t.renderer.root.add(n),
    clearChildren: (node) => {
      // the ctx hands over a real node; this fake only touches the tree API
      const n = node as NodeLike;
      for (const c of [...n.getChildren()]) n.remove(c);
    },
    stripSelectable: () => {},
    escHintBtn: (id, onClose) => {
      const hint: any = Text({ id, content: "esc", fg: colors.sidebarFgMuted });
      hint.onMouseDown = onClose;
      return hint;
    },
    drainIconQueue: () => {},
    colors: getColors,
    uiStyle: () => "solid",
    floats,
    performBulkRename: (pairs) => {
      performed.push(...pairs);
    },
  });

const TWO = ["/tfm-bulk/IMG_001.jpg", "/tfm-bulk/IMG_002.jpg"];
const TEN = Array.from({ length: 10 }, (_, i) => `/tfm-bulk/f${i}.txt`);

describe("bulk rename widget", () => {
  test("open mounts the input; typing shows live generated names", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const bulk = mkBulk(t, floats, []);
      bulk.open(TWO);
      await t.renderOnce();
      expect(t.renderer.root.findDescendantById("tfm-bulkrename")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-bulkrename-input")).toBeTruthy();
      expect(floats.isOpen("bulkrename")).toBe(true);
      bulk.setValue("vacation");
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("IMG_001.jpg");
      expect(frame).toContain("vacation 1.jpg");
      expect(frame).toContain("vacation 2.jpg");
      expect(frame).toContain("Rename 2 items");
      bulk.handleKey({ name: "escape" });
      expect(floats.isOpen("bulkrename")).toBe(false);
      expect(t.renderer.root.findDescendantById("tfm-bulkrename")).toBeFalsy();
    } finally {
      t.renderer.destroy();
    }
  });

  test("open lists the selected files before anything is typed", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const bulk = mkBulk(t, makeFloats(), []);
      bulk.open(TWO);
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("IMG_001.jpg");
      expect(frame).toContain("IMG_002.jpg");
      expect(frame).not.toContain("type a name");
      bulk.handleKey({ name: "escape" });
    } finally {
      t.renderer.destroy();
    }
  });

  test("focus lands on the input and native typing reaches it", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const bulk = mkBulk(t, makeFloats(), []);
      bulk.open(TWO);
      await t.renderOnce();
      await Bun.sleep(30);
      expect((t.renderer as any).currentFocusedRenderable?.id).toBe("tfm-bulkrename-input");
      await t.mockInput.typeText("Z");
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("Z 1.jpg");
      bulk.handleKey({ name: "escape" });
    } finally {
      t.renderer.destroy();
    }
  });

  test("enter applies the generated pairs once and closes", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const performed: Array<{ from: string; to: string }> = [];
      const bulk = mkBulk(t, floats, performed);
      bulk.open(TWO);
      await t.renderOnce();
      bulk.setValue("vacation");
      bulk.handleKey({ name: "return" });
      expect(performed).toEqual([
        { from: "/tfm-bulk/IMG_001.jpg", to: "/tfm-bulk/vacation 1.jpg" },
        { from: "/tfm-bulk/IMG_002.jpg", to: "/tfm-bulk/vacation 2.jpg" },
      ]);
      expect(floats.isOpen("bulkrename")).toBe(false);
    } finally {
      t.renderer.destroy();
    }
  });

  test("tab cycles the numbering style; pad validates against the count", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const performed: Array<{ from: string; to: string }> = [];
      const bulk = mkBulk(t, floats, performed);
      bulk.open(TEN);
      await t.renderOnce();
      bulk.setValue("pic");
      bulk.handleKey({ name: "tab" }); // plain -> pad
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("pic 01.txt");
      bulk.handleKey({ name: "return" });
      expect(performed[0]!.to).toBe("/tfm-bulk/pic 01.txt");
      expect(performed[9]!.to).toBe("/tfm-bulk/pic 10.txt");
    } finally {
      t.renderer.destroy();
    }
  });

  test("paren style is reachable; preview follows it", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const bulk = mkBulk(t, makeFloats(), []);
      bulk.open(TWO);
      await t.renderOnce();
      bulk.setValue("pic");
      bulk.handleKey({ name: "tab" });
      bulk.handleKey({ name: "tab" }); // plain -> pad -> paren
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("pic (1).jpg");
      bulk.handleKey({ name: "escape" });
    } finally {
      t.renderer.destroy();
    }
  });

  test("an empty name keeps the modal open, shows the error, runs nothing", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const performed: Array<{ from: string; to: string }> = [];
      const bulk = mkBulk(t, floats, performed);
      bulk.open(TWO);
      await t.renderOnce();
      bulk.setValue("   ");
      bulk.handleKey({ name: "return" });
      await t.renderOnce();
      expect(performed).toEqual([]);
      expect(floats.isOpen("bulkrename")).toBe(true);
      expect(t.captureCharFrame()).toContain("Name can't be empty");
    } finally {
      t.renderer.destroy();
    }
  });

  test("re-open replaces the previous session (no stacked scrims)", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const bulk = mkBulk(t, floats, []);
      bulk.open(["/tfm-bulk/old.txt"]);
      await t.renderOnce();
      bulk.open(["/tfm-bulk/new-one.txt", "/tfm-bulk/new-two.txt"]);
      await t.renderOnce();
      bulk.setValue("pic");
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("new-one.txt");
      expect(frame).toContain("pic 2.txt");
      expect(frame).not.toContain("old.txt");
      expect(floats.depth()).toBe(1);
      bulk.handleKey({ name: "escape" });
    } finally {
      t.renderer.destroy();
    }
  });

  test("while open, every key is swallowed by the modal (typing stays native)", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const bulk = mkBulk(t, floats, []);
      bulk.open(TWO);
      await t.renderOnce();
      expect(bulk.handleKey({ name: "a" })).toBe(true);
      expect(bulk.handleKey({ name: "down" })).toBe(true);
      expect(floats.isOpen("bulkrename")).toBe(true);
      bulk.handleKey({ name: "escape" });
    } finally {
      t.renderer.destroy();
    }
  });

  test("repaint() repaints panel + input + title + preview with live colors, keeps the value", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      let live: Theme = { ...colors };
      const bulk = mkBulk(t, floats, [], () => live);
      bulk.open(TWO);
      await t.renderOnce();
      bulk.setValue("vacation");
      await t.renderOnce();
      live = { ...colors, sidebarBg: "#101020", accentBg: "#303040", accent: "#ff0000", white: "#f0f0f0" };
      bulk.repaint();
      await t.renderOnce();
      const hexInts = (hex: string): [number, number, number, number] => {
        const n = Number.parseInt(hex.slice(1), 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
      };
      const panel = t.renderer.root.findDescendantById("tfm-bulkrename-panel") as any;
      expect([...panel.backgroundColor.toInts()]).toEqual(hexInts("#101020"));
      const input = t.renderer.root.findDescendantById("tfm-bulkrename-input") as any;
      expect([...input.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
      const title = t.renderer.root.findDescendantById("tfm-bulkrename-title") as any;
      expect([...title.fg.toInts()]).toEqual(hexInts("#ff0000"));
      // value + preview survive (no rebuild of the input)
      const frame = t.captureCharFrame();
      expect(frame).toContain("vacation 1.jpg");
      expect(frame).toContain("Rename 2 items");
    } finally {
      t.renderer.destroy();
    }
  });

  test("repaint() is a no-op when closed", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const bulk = mkBulk(t, floats, []);
      expect(() => bulk.repaint()).not.toThrow();
      expect(t.renderer.root.findDescendantById("tfm-bulkrename")).toBeFalsy();
    } finally {
      t.renderer.destroy();
    }
  });
});
