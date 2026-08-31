import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSelection, type SelTileRef, type SelectionCtx } from "./selection";

const COLORS: any = {
  bg: "#111111",
  hoverBg: "#222222",
  accent: "#7aa2f7",
  accentBg: "#333333",
  sidebarFg: "#aaaaaa",
  sidebarFgMuted: "#666666",
};

const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(10);
};

const makeHarness = () => {
  const nodes = new Map<string, any>();
  const byId = (id: string): any => nodes.get(id);
  const iconEvents: Array<{ key: string; mode: number }> = [];
  const previews: number[] = [];
  const scrolls: any[] = [];
  const cutKeys = new Set<string>();
  let scroller: any = null;

  const ctx: SelectionCtx = {
    colors: () => COLORS,
    uiStyle: () => "solid",
    byId,
    setIconState: (spec: any, mode: number) => { if (spec) iconEvents.push({ key: spec.__key, mode }); },
    isCutKey: (k: string) => cutKeys.has(k),
    scroller: () => scroller,
    viewH: () => 4,
    rowHInit: () => 3,
    renderPreview: () => { previews.push(1); },
  };
  const sel = makeSelection(ctx);

  const addTile = (key: string, isDir = false, withIconSpec = true): void => {
    const tileId = `tile:${key}`;
    const labelId = `label:${key}`;
    nodes.set(tileId, { id: tileId });
    nodes.set(labelId, { id: labelId });
    const ref: SelTileRef = {
      selected: false,
      baseFg: COLORS.sidebarFg,
      tileId,
      labelId,
      isDir,
      ...(withIconSpec ? { iconSpec: { __key: key } } : { iconSlotId: `slot:${key}` }),
    };
    if (!withIconSpec) nodes.set(`slot:${key}`, { id: `slot:${key}`, opacity: 1 });
    sel.tileRefs.set(key, ref);
  };

  return { sel, ctx, nodes, iconEvents, previews, scrolls, cutKeys, addTile, setScroller: (s: any) => { scroller = s; } };
};

describe("selectTileAt", () => {
  test("selects the tile, moves focus, requests a preview", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => { h.addTile(k); });
    expect(h.sel.selectTileAt(1)).toBe(true);
    expect(h.sel.focusIdx()).toBe(1);
    expect(h.sel.tileRefs.get("b")!.selected).toBe(true);
    expect(h.sel.tileRefs.get("a")!.selected).toBe(false);
    expect(h.previews.length).toBe(1);
    expect(h.iconEvents.some((e) => e.key === "b" && e.mode === 2)).toBe(true);
  });

  test("out-of-bounds is a no-op that keeps the current selection", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b"]);
    h.addTile("a"); h.addTile("b");
    h.sel.selectTileAt(0);
    expect(h.sel.selectTileAt(5)).toBe(false);
    expect(h.sel.tileRefs.get("a")!.selected).toBe(true);
    expect(h.sel.focusIdx()).toBe(0);
  });
});

describe("moveFocus", () => {
  test("starts at tile 0 from an unfocused grid", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => { h.addTile(k); });
    expect(h.sel.moveFocus(0, 1)).toBe(true);
    expect(h.sel.focusIdx()).toBe(0);
  });

  test("pages by colsAtBuild and clamps at both ends", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d", "e", "f"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => { h.addTile(k); });
    h.sel.setCols(3);
    h.sel.selectTileAt(1);
    h.sel.moveFocus(0, 1); // 1 -> 4
    expect(h.sel.focusIdx()).toBe(4);
    h.sel.moveFocus(0, 1); // 4 -> 7 clamped to 5
    expect(h.sel.focusIdx()).toBe(5);
    h.sel.moveFocus(1, 0); // clamped
    expect(h.sel.focusIdx()).toBe(5);
    h.sel.moveFocus(0, -1); // 5 -> 2
    expect(h.sel.focusIdx()).toBe(2);
    h.sel.moveFocus(-1, 0); // 2 -> 1
    expect(h.sel.focusIdx()).toBe(1);
  });

  test("moving with nowhere to go returns false", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a"]);
    h.addTile("a");
    h.sel.selectTileAt(0);
    expect(h.sel.moveFocus(-1, 0)).toBe(false);
    expect(h.sel.moveFocus(0, 1)).toBe(false);
  });

  test("empty grid never moves", () => {
    const h = makeHarness();
    expect(h.sel.moveFocus(0, 1)).toBe(false);
  });
});

describe("selectRange / selectAll / clearTileSelection", () => {
  test("range is inclusive, cleared first, clamped to the grid", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d", "e"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => { h.addTile(k); });
    h.sel.selectTileAt(0);
    h.sel.selectRange(4, 1); // reversed args select 1..4
    expect(h.sel.tileRefs.get("a")!.selected).toBe(false);
    for (const k of ["b", "c", "d", "e"]) expect(h.sel.tileRefs.get(k)!.selected).toBe(true);

    h.sel.selectRange(-5, 2);
    for (const k of ["a", "b", "c"]) expect(h.sel.tileRefs.get(k)!.selected).toBe(true);
    for (const k of ["d", "e"]) expect(h.sel.tileRefs.get(k)!.selected).toBe(false);
  });

  test("selPaths carries isDir; selectAll marks everything; clear empties", () => {
    const h = makeHarness();
    const keys = ["d1/", "f.txt"];
    h.sel.setFocusKeys(keys);
    h.addTile("d1/", true); h.addTile("f.txt");
    h.sel.selectAll();
    const paths = h.sel.selPaths();
    expect(paths.map((p) => p.path).sort()).toEqual(["d1/", "f.txt"]);
    expect(paths.find((p) => p.path === "d1/")!.isDir).toBe(true);
    h.sel.clearTileSelection();
    expect(h.sel.selPaths()).toEqual([]);
  });
});

describe("setTileVisual", () => {
  test("unknown tile key is a no-op", () => {
    const h = makeHarness();
    expect(() => h.sel.setTileVisual("ghost", 2)).not.toThrow();
  });

  test("mode 0 over a cut key paints the cut state (dimmed slot, muted label)", () => {
    const h = makeHarness();
    h.addTile("thumb.png", false, false); // thumbnail slot: no iconSpec
    h.cutKeys.add("thumb.png");
    h.sel.setTileVisual("thumb.png", 0);
    // setIconState guards !spec (ui-slots.ts) — thumbnails signal cut via opacity
    expect(h.iconEvents).toEqual([]);
    expect(h.nodes.get("slot:thumb.png").opacity).toBe(0.45);
    expect(h.nodes.get("label:thumb.png").fg).toBe(COLORS.sidebarFgMuted);
  });

  test("selected mode tints the label accent and fills the tile", () => {
    const h = makeHarness();
    h.addTile("a");
    h.sel.setTileVisual("a", 2);
    expect(h.nodes.get("label:a").fg).toBe(COLORS.accent);
    expect(h.nodes.get("tile:a").backgroundColor).toBe(COLORS.accentBg);
  });
});

describe("refreshCutVisuals", () => {
  test("repaints only unselected tiles, tracking the clipboard", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b"]);
    h.addTile("a"); h.addTile("b");
    h.cutKeys.add("a");
    h.sel.selectTileAt(0); // select "a"
    h.iconEvents.length = 0;
    h.sel.refreshCutVisuals();
    // "a" is selected -> untouched; "b" is not cut -> plain rest paint
    expect(h.iconEvents).toEqual([{ key: "b", mode: 0 }]);
  });
});

describe("updateSelectionStatusReal", () => {
  test("empty selection clears the status line", () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "stale" });
    h.sel.updateSelectionStatusReal();
    expect(h.nodes.get("tfm-status-label").content).toBe("");
  });

  test("single file reports its size", async () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sel-"));
    try {
      const f = path.join(dir, "f.bin");
      writeFileSync(f, "abc"); // 3 bytes -> "3 B"
      h.sel.setFocusKeys([f]);
      h.addTile(f);
      h.sel.selectTileAt(0);
      h.sel.updateSelectionStatusReal();
      const status = h.nodes.get("tfm-status-label");
      await settleUntil(() => status.content === "1 selected · 3 B");
      expect(status.content).toBe("1 selected · 3 B");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("single dir reports its contained item count", async () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sel-"));
    try {
      mkdirSync(path.join(dir, "sub"));
      writeFileSync(path.join(dir, "sub", "x"), "x");
      writeFileSync(path.join(dir, "sub", "y"), "y");
      h.sel.setFocusKeys([path.join(dir, "sub")]);
      h.addTile(path.join(dir, "sub"), true);
      h.sel.selectTileAt(0);
      h.sel.updateSelectionStatusReal();
      const status = h.nodes.get("tfm-status-label");
      await settleUntil(() => status.content === "1 selected · 2 items");
      expect(status.content).toBe("1 selected · 2 items");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a newer status request wins over a still-in-flight older one", async () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sel-"));
    try {
      mkdirSync(path.join(dir, "slowdir"));
      const f = path.join(dir, "quick.txt");
      writeFileSync(f, "ab");
      h.addTile(path.join(dir, "slowdir"), true);
      h.addTile(f);
      h.sel.setFocusKeys([path.join(dir, "slowdir"), f]);

      h.sel.selectTileAt(0); // dir -> async stat path
      h.sel.updateSelectionStatusReal();
      h.sel.selectTileAt(1); // file -> newer generation
      h.sel.updateSelectionStatusReal();
      const status = h.nodes.get("tfm-status-label");
      await settleUntil(() => status.content === "1 selected · 2 B");
      expect(status.content).toBe("1 selected · 2 B");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("tileStates", () => {
  test("dim swaps the normal fg for the muted one; index 3 is the cut state", () => {
    const h = makeHarness();
    const norm = h.sel.tileStates(false);
    const dim = h.sel.tileStates(true);
    expect(norm[0]!.fg).toBe(COLORS.sidebarFg);
    expect(dim[0]!.fg).toBe(COLORS.sidebarFgMuted);
    expect(norm[3]!.fg).toBe(COLORS.sidebarFgMuted);
    expect(norm[2]!.bg).toBe(COLORS.accentBg);
  });
});

describe("keyboard scrolling", () => {
  test("selectTileAt scrolls down when the row falls below the viewport", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d", "e", "f"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => { h.addTile(k); });
    h.sel.setCols(3);
    h.sel.setRowH(3);
    const scroller: any = { scrollTop: 0, scrollTo: (o: any) => h.scrolls.push(o) };
    h.setScroller(scroller);
    h.sel.selectTileAt(5); // row 1 (6/3): (1+1)*3=6 > 0+4 -> scroll to y=2
    expect(h.scrolls).toEqual([{ x: 0, y: 2 }]);
  });

  test("selectTileAt scrolls up when the row is above the viewport", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d", "e", "f"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => { h.addTile(k); });
    h.sel.setCols(3);
    h.sel.setRowH(3);
    const scroller: any = { scrollTop: 6, scrollTo: (o: any) => h.scrolls.push(o) };
    h.setScroller(scroller);
    h.sel.selectTileAt(0); // row 0: 0 < 6 -> scroll to y=0
    expect(h.scrolls).toEqual([{ x: 0, y: 0 }]);
  });
});
