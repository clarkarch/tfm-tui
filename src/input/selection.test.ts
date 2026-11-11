import { describe, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeSelection, type SelTileRef, type SelectionCtx } from "./selection";
import { fmtBytes } from "../fs/propsinfo";
import { TileVisual } from "./grid-input";
import type { IconSpec } from "../lib/icon-state";

const COLORS: any = {
  bg: "#111111",
  hoverBg: "#222222",
  accent: "#7aa2f7",
  accentBg: "#333333",
  sidebarFg: "#aaaaaa",
  sidebarFgMuted: "#666666",
  white: "#ffffff",
};

// input/ may not import the ui/ PAINT layer — that is the whole point of the
// ctx.paintTile seam (the surface RULES live in ui/style.ts, input/ only
// knows the four visual states). So this file mirrors the production painter's
// OBSERVABLE contract locally (wiring/grid-foundation.ts -> ui/style.ts's
// tileSurface + applySurface): rest/cut paint the canvas bg, hover the hover
// bg, selected the accent bg, and transparent-bg force clears the rest/cut
// fill so the terminal shows through. The assertions below read BOTH the
// surface the fake applies and the state the seam received, so a drift in
// either is visible.
const TILE_BG = {
  rest: COLORS.bg as string,
  hover: COLORS.hoverBg as string,
  selected: COLORS.accentBg as string,
  cut: COLORS.bg as string,
};
type TilePaintState = keyof typeof TILE_BG;

const fakeTileBg = (state: TilePaintState, forceTransparent: boolean): string =>
  forceTransparent && (state === "rest" || state === "cut") ? "transparent" : TILE_BG[state];

const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(10);
};

// Let every pending microtask finish (the async status body runs on the
// microtask queue). The next event-loop turn is a DETERMINISTIC barrier —
// not a sleep, so it cannot flake under load.
const flushTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const makeHarness = () => {
  const nodes = new Map<string, any>();
  const byId = (id: string): any => nodes.get(id);
  const iconEvents: Array<{ key: string; mode: number }> = [];
  const previews: number[] = [];
  const scrolls: any[] = [];
  const cutKeys = new Set<string>();
  let scroller: any = null;
  // the real painter's transparent-bg knob is flipped by a test AFTER the ctx
  // is built, so the fake reads it live through the same seam
  let forceTransparent = false;
  // what the ctx.paintTile seam was handed, per call — the seam contract
  // (the visual state) is part of what selection.ts owns
  const paintCalls: Array<{ id: string; state: TilePaintState; bg: string }> = [];
  // the pane's activity: a FALSE pane must not drive the shared status label
  let active = true;
  // the directory reader behind the "N items" count — a test can take it
  // over so the stale-async guard is decided by the test, not by an fs race
  let dirReader: ((dir: string) => Promise<string[]>) | null = null;

  const ctx: SelectionCtx = {
    colors: () => COLORS,
    byId,
    setText: (id, text) => {
      const n = nodes.get(id);
      if (n) n.content = text;
    },
    setIconState: (spec: any, mode: number) => {
      if (spec) iconEvents.push({ key: spec.__key, mode });
      return true;
    },
    isCutKey: (k: string) => cutKeys.has(k),
    scroller: () => scroller,
    viewH: () => 4,
    rowHInit: () => 3,
    renderPreview: () => {
      previews.push(1);
    },
    // the active pane owns the (global) status label and the plugin
    // selection events
    isActive: () => active,
    readDir: (dir: string) => (dirReader ? dirReader(dir) : readdir(dir)),
    // mirror the PRODUCTION painter (wiring/grid-foundation): these tests
    // assert the tile's background/fill, so a no-op fake would make the
    // selection INVISIBLE to the assertion
    paintTile: (node, state) => {
      const bg = fakeTileBg(state, forceTransparent);
      paintCalls.push({ id: node?.id ?? "", state, bg });
      if (node) node.backgroundColor = bg;
    },
  };
  const sel = makeSelection(ctx);

  // `mounted` = the ref's nodes are LIVE. A windowed grid registers a ref for
  // EVERY entry up front (the selection contract is window-blind) and a row
  // that slides out of the window is REAPED — its nodes are destroyed while
  // the ref keeps the dead icon spec and the dead node ids.
  const addTile = (key: string, isDir = false, withIconSpec = true, mounted = true): void => {
    const tileId = `tile:${key}`;
    const labelId = `label:${key}`;
    // an unmounted ref names nodes that no longer exist
    if (mounted) {
      nodes.set(tileId, { id: tileId });
      nodes.set(labelId, { id: labelId });
      if (!withIconSpec) nodes.set(`slot:${key}`, { id: `slot:${key}`, opacity: 1 });
    }
    const ref: SelTileRef = {
      mounted,
      selected: false,
      baseFg: COLORS.sidebarFg,
      tileId,
      labelId,
      isDir,
      ...(withIconSpec
        ? // a marker spec: the test only asserts identity, not the icon surface
          { iconSpec: { __key: key } as unknown as IconSpec<"select"> }
        : { iconSlotId: `slot:${key}` }),
    };
    sel.tileRefs.set(key, ref);
  };

  return {
    sel,
    ctx,
    nodes,
    iconEvents,
    previews,
    scrolls,
    cutKeys,
    paintCalls,
    addTile,
    // flipped by the transparent-bg test to drive the fake painter
    set forceTransparent(v: boolean) {
      forceTransparent = v;
    },
    // the pane switch: the OLD pane goes inactive and the NEW pane owns the
    // shared status label
    set active(v: boolean) {
      active = v;
    },
    // take over the directory reader (the async "N items" count)
    set dirReader(fn: ((dir: string) => Promise<string[]>) | null) {
      dirReader = fn;
    },
    setScroller: (s: any) => {
      scroller = s;
    },
  };
};

describe("selectTileAt", () => {
  test("selects the tile, moves focus, requests a preview", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => {
      h.addTile(k);
    });
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
    h.addTile("a");
    h.addTile("b");
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
    ["a", "b", "c"].forEach((k) => {
      h.addTile(k);
    });
    expect(h.sel.moveFocus(0, 1)).toBe(true);
    expect(h.sel.focusIdx()).toBe(0);
  });

  test("pages by colsAtBuild and clamps at both ends", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d", "e", "f"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => {
      h.addTile(k);
    });
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

  test("plain moves re-anchor so a later extend starts at the focus", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(1);
    expect(h.sel.anchorPath()).toBe("b");
    h.sel.moveFocus(0, 1); // plain nav 1 -> 2
    expect(h.sel.focusIdx()).toBe(2);
    // extend now measures from the moved focus (was 1, jumping to 2..3)
    expect(h.sel.anchorPath()).toBe("c");
    h.sel.selectRange(h.sel.ensureAnchor(), 3);
    expect(h.sel.selPaths().map((p) => p.path)).toEqual(["c", "d"]);
    // range-extend keeps its own origin across the focus jump
    h.sel.selectTileAt(0, true);
    expect(h.sel.anchorPath()).toBe("c");
  });
});

describe("selectRange / selectAll / clearTileSelection", () => {
  test("range is inclusive, cleared first, clamped to the grid", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c", "d", "e"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => {
      h.addTile(k);
    });
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
    h.addTile("d1/", true);
    h.addTile("f.txt");
    h.sel.selectAll();
    const paths = h.sel.selPaths();
    expect(paths.map((p) => p.path).sort()).toEqual(["d1/", "f.txt"]);
    expect(paths.find((p) => p.path === "d1/")!.isDir).toBe(true);
    h.sel.clearTileSelection();
    expect(h.sel.selPaths()).toEqual([]);
  });
});

describe("toggleFocused / invertSelection", () => {
  test("toggleFocused flips only the focused tile, focus stays put", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(1);
    expect(h.sel.toggleFocused()).toBe(true);
    expect(h.sel.tileRefs.get("b")!.selected).toBe(false);
    expect(h.sel.focusIdx()).toBe(1);
    expect(h.sel.toggleFocused()).toBe(true);
    expect(h.sel.tileRefs.get("b")!.selected).toBe(true);
    expect(h.sel.selPaths().map((p) => p.path)).toEqual(["b"]);
  });

  test("toggleFocused with no focus is a no-op", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a"]);
    h.addTile("a");
    expect(h.sel.toggleFocused()).toBe(false);
    expect(h.sel.selPaths()).toEqual([]);
  });

  test("invertSelection flips every tile", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(0);
    h.sel.invertSelection();
    expect(
      h.sel
        .selPaths()
        .map((p) => p.path)
        .sort(),
    ).toEqual(["b", "c"]);
    h.sel.invertSelection();
    expect(h.sel.selPaths().map((p) => p.path)).toEqual(["a"]);
  });
});

// --- the focus state: ONE explicit record, no magic sentinels ---
//
// The focus used to be an INDEX into an array that is replaced wholesale on
// every rebuild, plus a SECOND sentinel (a null anchor) with TWO different
// "no anchor yet" policies. The focus and the range origin are now PATHS —
// stable identities that survive a re-sort — and the navigable index is
// DERIVED from them, so it can never point past the end of the listing.

describe("the focus state", () => {
  test("emptying the focus keys clears the focus (no index into a dead listing)", () => {
    const h = makeHarness();
    const keys = ["a", "b", "c"];
    h.sel.setFocusKeys(keys);
    keys.forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(2);
    expect(h.sel.focusIdx()).toBe(2);
    // the listing is replaced by an empty one (the loading/empty/error panes
    // do exactly this) — the focus must not keep pointing into it
    h.sel.setFocusKeys([]);
    expect(h.sel.focusIdx()).toBe(-1);
    // ... and the focus is CLEARED, not just left dangling: a rebuild's
    // restore must be able to put a focus back
    expect(h.sel.focusState().kind).toBe("none");
    expect(h.sel.focusPath()).toBeNull();
  });

  test("the anchor follows its FILE, not its index, when the listing is replaced", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(0); // focus a
    h.sel.setAnchorPath("c"); // the range origin is c
    // the listing comes back in a different order (a re-sort): an index-based
    // anchor would now point at a DIFFERENT file
    h.sel.setFocusKeys(["c", "b", "a"]);
    expect(h.sel.anchorPath()).toBe("c");
    expect(h.sel.anchorIdx()).toBe(0);
    expect(h.sel.focusPath()).toBe("a");
    expect(h.sel.focusIdx()).toBe(2);
  });

  test("the anchor is dropped when its file disappears", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(0);
    h.sel.setAnchorPath("c");
    h.sel.setFocusKeys(["a", "b"]); // c vanished
    expect(h.sel.anchorPath()).toBeNull();
    // the focus survives — it is its own file
    expect(h.sel.focusPath()).toBe("a");
    expect(h.sel.focusIdx()).toBe(0);
  });

  test("one anchor default: the anchor, else the focus, else the first tile", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => {
      h.addTile(k);
    });
    // nothing focused, no anchor → the range starts at the first tile
    expect(h.sel.ensureAnchor()).toBe(0);
    expect(h.sel.anchorPath()).toBe("a");
    // a focus with no anchor → the focus IS the anchor (ONE rule, every site)
    h.sel.setFocusPath("b");
    h.sel.setAnchorPath(null);
    expect(h.sel.ensureAnchor()).toBe(1);
    expect(h.sel.anchorPath()).toBe("b");
    // an explicit anchor wins
    h.sel.setAnchorPath("c");
    expect(h.sel.ensureAnchor()).toBe(2);
  });

  test("a rebuild restores the focus when nothing else claimed it", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b"]);
    ["a", "b"].forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(0);
    const snap = h.sel.captureFocus();
    // the loading placeholder replaces the listing with an empty one — the
    // focus is dropped with it
    h.sel.setFocusKeys([]);
    expect(h.sel.focusIdx()).toBe(-1);
    // the real listing arrives...
    h.sel.setFocusKeys(["a", "b"]);
    // ... and the restore puts the focus back
    expect(h.sel.restoreFocus(snap)).toBe(true);
    expect(h.sel.focusPath()).toBe("a");
    expect(h.sel.focusIdx()).toBe(0);
  });

  test("a focus claimed during the rebuild is NOT overwritten by the restore", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b"]);
    ["a", "b"].forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(0);
    const snap = h.sel.captureFocus();
    h.sel.setFocusKeys([]);
    // a click during the rebuild's await claims the focus
    h.sel.setFocusPath("b");
    expect(h.sel.restoreFocus(snap)).toBe(false);
    expect(h.sel.focusPath()).toBe("b");
  });

  test("the restore is refused when the focused file vanished", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b"]);
    ["a", "b"].forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectTileAt(0);
    const snap = h.sel.captureFocus();
    h.sel.setFocusKeys(["b"]); // a vanished
    expect(h.sel.restoreFocus(snap)).toBe(false);
    expect(h.sel.focusPath()).toBeNull();
  });
});

describe("setTileVisual", () => {
  test("unknown tile key is a no-op", () => {
    const h = makeHarness();
    expect(() => h.sel.setTileVisual("ghost", TileVisual.Selected)).not.toThrow();
  });

  test("Rest over a cut key paints the cut state (dimmed slot, muted label)", () => {
    const h = makeHarness();
    h.addTile("thumb.png", false, false); // thumbnail slot: no iconSpec
    h.cutKeys.add("thumb.png");
    h.sel.setTileVisual("thumb.png", TileVisual.Rest);
    // setIconState guards !spec (ui-slots.ts) — thumbnails signal cut via opacity
    expect(h.iconEvents).toEqual([]);
    expect(h.nodes.get("slot:thumb.png").opacity).toBe(0.45);
    expect(h.nodes.get("label:thumb.png").fg).toBe(COLORS.sidebarFgMuted);
    // the seam got the CUT state (not "rest") and the canvas fill
    expect(h.paintCalls).toEqual([{ id: "tile:thumb.png", state: "cut", bg: COLORS.bg }]);
  });

  test("selected mode tints the label accent and fills the tile", () => {
    const h = makeHarness();
    h.addTile("a");
    h.sel.setTileVisual("a", TileVisual.Selected);
    expect(h.nodes.get("label:a").fg).toBe(COLORS.accent);
    expect(h.nodes.get("tile:a").backgroundColor).toBe(COLORS.accentBg);
    // the seam got the SELECTED state and the accent fill
    expect(h.paintCalls).toEqual([{ id: "tile:a", state: "selected", bg: COLORS.accentBg }]);
  });

  test("transparent-bg force clears the rest fill (terminal shows through)", () => {
    const h = makeHarness();
    h.forceTransparent = true;
    h.addTile("a");
    h.sel.setTileVisual("a", TileVisual.Rest);
    expect(h.nodes.get("tile:a").backgroundColor).toBe("transparent");
    // selection keeps its fill under force
    h.sel.setTileVisual("a", TileVisual.Selected);
    expect(h.nodes.get("tile:a").backgroundColor).toBe(COLORS.accentBg);
    // the fake painter saw the force knob live: rest cleared, selected kept
    expect(h.paintCalls).toEqual([
      { id: "tile:a", state: "rest", bg: "transparent" },
      { id: "tile:a", state: "selected", bg: COLORS.accentBg },
    ]);
  });

  test("a reaped row is not painted", () => {
    const h = makeHarness();
    // a BUILT tile: the icon state and the surface paint happen
    h.addTile("live");
    h.sel.setTileVisual("live", TileVisual.Selected);
    expect(h.iconEvents).toEqual([{ key: "live", mode: 2 }]);
    expect(h.paintCalls).toHaveLength(1);

    // a REAPED row (the window slide destroyed its nodes): the ref still holds
    // the dead icon spec and the dead node ids. Painting it would name a dead
    // spec and write to destroyed renderables.
    h.addTile("reaped", false, true, false);
    h.iconEvents.length = 0;
    h.paintCalls.length = 0;
    h.sel.setTileVisual("reaped", TileVisual.Selected);
    expect(h.iconEvents).toEqual([]);
    expect(h.paintCalls).toEqual([]);
  });
});

describe("refreshCutVisuals", () => {
  test("repaints only unselected tiles, tracking the clipboard", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b"]);
    h.addTile("a");
    h.addTile("b");
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("onSelection fires on change and dedupes repeats (rubber-band spam)", () => {
    const h = makeHarness();
    const seen: string[][] = [];
    (h.ctx as { onSelection?: (paths: string[]) => void }).onSelection = (paths) => seen.push(paths);
    h.addTile("/a");
    h.sel.setFocusKeys(["/a"]);
    h.sel.selectTileAt(0);
    h.sel.updateSelectionStatusReal();
    // the FIRST observation is emitted, even when the selection is empty:
    // "nothing has been emitted yet" is not "the empty selection was
    // emitted", so the stream starts with the state it is actually in
    expect(seen).toEqual([[], ["/a"]]);
    // rebuilds/rubber-band moves re-call with unchanged paths — silent
    h.sel.updateSelectionStatusReal();
    h.sel.updateSelectionStatusReal();
    expect(seen).toEqual([[], ["/a"]]);
    // real changes fire (selectTileAt clears first — the empty intermediate
    // is a genuine change, not spam)
    h.addTile("/b");
    h.sel.setFocusKeys(["/a", "/b"]);
    h.sel.selectTileAt(1);
    h.sel.updateSelectionStatusReal();
    expect(seen).toEqual([[], ["/a"], [], ["/b"]]);
  });

  test("link+target total is on-disk cost (link bytes, not double target)", async () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sel-"));
    try {
      const f = path.join(dir, "f.bin");
      writeFileSync(f, "hello world"); // 11 bytes
      const link = path.join(dir, "l.bin");
      symlinkSync(f, link);
      // on-disk cost: file bytes + the link's own bytes (transfer preserves links)
      const total = lstatSync(f).size + lstatSync(link).size;
      h.sel.setFocusKeys([f, link]);
      h.addTile(f);
      h.addTile(link);
      h.sel.selectAll();
      h.sel.updateSelectionStatusReal();
      const status = h.nodes.get("tfm-status-label");
      await settleUntil(() => status.content === `2 selected · ${fmtBytes(total)}`);
      expect(status.content).toBe(`2 selected · ${fmtBytes(total)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hardlink pair counts shared bytes once (inode dedupe)", async () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "" });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sel-"));
    try {
      const f = path.join(dir, "f.bin");
      writeFileSync(f, "hello world"); // 11 bytes
      const g = path.join(dir, "g.bin");
      linkSync(f, g); // same inode, two names
      h.sel.setFocusKeys([f, g]);
      h.addTile(f);
      h.addTile(g);
      h.sel.selectAll();
      h.sel.updateSelectionStatusReal();
      const status = h.nodes.get("tfm-status-label");
      await settleUntil(() => status.content === `2 selected · ${fmtBytes(lstatSync(f).size)}`);
      expect(status.content).toBe(`2 selected · ${fmtBytes(lstatSync(f).size)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- the stale-async status guard ---
  //
  // The status label ("tfm-status-label") is GLOBAL — both panes share it —
  // and the "N items" count of a directory selection is ASYNC. A write can
  // therefore land long after the request that asked for it: if the pane
  // lost the focus in between, the stale count would paint over the NEW
  // pane's status.

  test("a status write after a pane switch is dropped", async () => {
    const h = makeHarness();
    h.nodes.set("tfm-status-label", { id: "tfm-status-label", content: "" });
    // take over the directory reader: the count lands only when the test
    // says so, so the pane switch happens while the count is in flight
    let releaseDirs!: (names: string[]) => void;
    const pending = new Promise<string[]>((resolve) => {
      releaseDirs = resolve;
    });
    h.dirReader = () => pending;

    const dir = path.join(os.tmpdir(), "tfm-sel-pane");
    h.addTile(dir, true);
    h.sel.setFocusKeys([dir]);
    h.sel.selectTileAt(0);
    h.sel.updateSelectionStatusReal(); // the async dir count starts

    // the user switches panes: the old pane loses the focus and the new
    // pane owns the shared status label
    h.nodes.get("tfm-status-label").content = "new pane";
    h.active = false;

    releaseDirs(["a", "b"]); // the in-flight count lands
    await flushTurn(); // let the async body finish

    expect(h.nodes.get("tfm-status-label").content).toBe("new pane");
  });

  test("the first empty selection is emitted (never-emitted is not the empty selection)", () => {
    const h = makeHarness();
    const seen: string[][] = [];
    (h.ctx as { onSelection?: (paths: string[]) => void }).onSelection = (paths) => seen.push(paths);
    // nothing is selected and NOTHING has been emitted yet: the empty
    // selection is a real state (the plugin stream has to learn it), so the
    // first observation of it fires. The old "" initial value made it look
    // like a repeat of an already-emitted empty selection.
    h.sel.updateSelectionStatusReal();
    expect(seen).toEqual([[]]);
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
    keys.forEach((k) => {
      h.addTile(k);
    });
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
    keys.forEach((k) => {
      h.addTile(k);
    });
    h.sel.setCols(3);
    h.sel.setRowH(3);
    const scroller: any = { scrollTop: 6, scrollTo: (o: any) => h.scrolls.push(o) };
    h.setScroller(scroller);
    h.sel.selectTileAt(0); // row 0: 0 < 6 -> scroll to y=0
    expect(h.scrolls).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("selectPaths (plugin api.select)", () => {
  test("selects the listed paths, ignores unknown ones, focuses the first match", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a", "b", "c"]);
    ["a", "b", "c"].forEach((k) => {
      h.addTile(k);
    });
    h.sel.selectPaths(["c", "/nope", "a"]);
    expect(h.sel.tileRefs.get("a")!.selected).toBe(true);
    expect(h.sel.tileRefs.get("c")!.selected).toBe(true);
    expect(h.sel.tileRefs.get("b")!.selected).toBe(false);
    expect(h.sel.focusIdx()).toBe(0); // first match in focus order
    expect(
      h.sel
        .selPaths()
        .map((s) => s.path)
        .sort(),
    ).toEqual(["a", "c"]);
  });

  test("an all-unknown list clears the selection", () => {
    const h = makeHarness();
    h.sel.setFocusKeys(["a"]);
    h.addTile("a");
    h.sel.selectTileAt(0);
    h.sel.selectPaths(["/nope"]);
    expect(h.sel.tileRefs.get("a")!.selected).toBe(false);
    expect(h.sel.selPaths()).toEqual([]);
  });
});
