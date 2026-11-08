import { describe, expect, test } from "bun:test";
import { Text } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeFloats } from "./floats";
import { makeBulkRename } from "./ui-bulk-rename";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import { destroyChildren } from "../lib/uiutil";

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
    byId: (id) => t.renderer.root.findDescendantById(id),
    rootAdd: (n) => t.renderer.root.add(n),
    // the ctx hands over a real node, so the REAL teardown is the honest fake
    destroyChildren,
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
    setPointer: (s) => void pointers.push(s),
  });

const TWO = ["/tfm-bulk/IMG_001.jpg", "/tfm-bulk/IMG_002.jpg"];
const TEN = Array.from({ length: 10 }, (_, i) => `/tfm-bulk/f${i}.txt`);

// mouse pointer shapes requested through the ctx seam (OSC 22 sink)
const pointers: string[] = [];

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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("apply uses the value in the input field", async () => {
    // The Input node is the source of truth. The field STRIPS control chars
    // (the user cannot type one), so the applied names must be the ones the
    // field SHOWS — a mirror could carry a different string and rename to a
    // name the user never typed.
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      const performed: Array<{ from: string; to: string }> = [];
      const bulk = mkBulk(t, floats, performed);
      bulk.open(TWO);
      await t.renderOnce();
      bulk.setValue("vaca\x01tion");
      await t.renderOnce();
      const input = t.renderer.root.findDescendantById("tfm-bulkrename-input") as any;
      expect(input.value).toBe("vacation"); // the field shows the stripped form
      bulk.handleKey({ name: "return" });
      expect(performed).toEqual([
        { from: "/tfm-bulk/IMG_001.jpg", to: "/tfm-bulk/vacation 1.jpg" },
        { from: "/tfm-bulk/IMG_002.jpg", to: "/tfm-bulk/vacation 2.jpg" },
      ]);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("an error raised after a theme switch wears the NEW theme's error color", async () => {
    // The error row's color is the widget's THEME state, not something that
    // depends on whether an error is showing: the row used to compare the
    // rendered node's content against the empty marker (a comparison that is
    // always true — the node's content is a chunk object, not a string) and
    // painted the color by accident. The row's color must follow the theme
    // either way, so an error raised AFTER a theme switch wears the new one.
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      const floats = makeFloats();
      let live: Theme = { ...colors };
      const bulk = mkBulk(t, floats, [], () => live);
      bulk.open(TWO);
      await t.renderOnce();
      const hexInts = (hex: string): [number, number, number, number] => {
        const n = Number.parseInt(hex.slice(1), 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
      };
      const err = t.renderer.root.findDescendantById("tfm-bulkrename-error") as any;
      live = { ...colors, ansi1: "#ff0000" };
      bulk.repaint();
      await t.renderOnce();
      // the error row's COLOR is theme state: it is projected unconditionally
      // (a conditional paint — "only while an error is showing" — would
      // leave the row wearing the color it was built with)
      expect([...err.fg.toInts()]).toEqual(hexInts("#ff0000"));
      bulk.setValue("/"); // "/" is an illegal name -> the error appears
      await t.renderOnce();
      expect([...err.fg.toInts()]).toEqual(hexInts("#ff0000"));
      expect(t.captureCharFrame()).toContain("Invalid name");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("open sets the text pointer, esc restores default", async () => {
    const t = await createTestRenderer({ width: 100, height: 26 });
    try {
      pointers.length = 0;
      const floats = makeFloats();
      const bulk = mkBulk(t, floats, []);
      bulk.open(TWO);
      await t.renderOnce();
      expect(pointers).toEqual(["text"]);
      bulk.handleKey({ name: "escape" });
      await t.renderOnce();
      expect(floats.isOpen("bulkrename")).toBe(false);
      expect(pointers).toEqual(["text", "default"]);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("no-drift rule", () => {
  test("the typed value lives in the INPUT node, and the error in a VARIABLE", async () => {
    // Two mirrored states, both recoverable from the wrong place:
    //  - the typed value was MIRRORED into a `value` variable while the
    //    Input node stayed the source of truth — the mirror drifted (the
    //    field strips control chars, the mirror did not) and `apply` renamed
    //    to a name the user never typed;
    //  - the error lived ONLY in the DOM: the repaint recovered it by
    //    comparing the rendered node's content against the empty marker (a
    //    comparison that is ALWAYS true — the node's content is a chunk
    //    object, not a string).
    // The value is read from the node; the error is a variable.
    const src = (await Bun.file(`${import.meta.dir}/ui-bulk-rename.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // (assert on the booleans, not the source: a failed match would dump
    // the whole module into the test output)
    expect(/err\.content/.test(src)).toBe(false); // no read-back out of the DOM
    expect(/errMsg/.test(src)).toBe(true); // the error is a variable
    expect(/let value\b/.test(src)).toBe(false); // no value mirror
    expect(/currentValue\(\)/.test(src)).toBe(true); // one accessor reads the node
  });
});
