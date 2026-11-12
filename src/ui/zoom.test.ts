import { describe, expect, test } from "bun:test";
import { defaultConfig, UI_SCHEMA } from "../config/config-schema";
import { gridZoomLadder, makeZoom, type GridTriple } from "./zoom";

// the grid knobs the zoom scales together
const def = (): GridTriple => ({
  tileWidth: defaultConfig.ui.tileWidth,
  tileHeight: defaultConfig.ui.tileHeight,
  iconCells: defaultConfig.ui.iconCells,
});

// a zoom owner over a live config the caller mutates — the wiring applies the
// patch to the config, so the owner must see the values it just produced
const harness = (over: Partial<GridTriple> = {}, viewMode: "grid" | "list" = "grid") => {
  const live = { ...def(), ...over };
  let rowHeight = defaultConfig.ui.listRowHeight;
  const zoom = makeZoom({
    viewMode: () => viewMode,
    grid: () => ({ ...live }),
    listRowHeight: () => rowHeight,
  });
  const apply = (dir: number) => {
    const patch = zoom.patch(dir);
    if (patch.tileWidth !== undefined) live.tileWidth = patch.tileWidth;
    if (patch.tileHeight !== undefined) live.tileHeight = patch.tileHeight;
    if (patch.iconCells !== undefined) live.iconCells = patch.iconCells;
    if (patch.listRowHeight !== undefined) rowHeight = patch.listRowHeight;
    return patch;
  };
  return { live, apply, zoom, rowHeight: () => rowHeight };
};

const bounds = (prop: string): { min: number; max: number } => {
  const row = UI_SCHEMA.find((r) => r.prop === prop);
  if (row?.kind !== "int") throw new Error(`no int row for ${prop}`);
  return { min: row.min, max: row.max };
};

describe("gridZoomLadder", () => {
  test("the ladder grows and shrinks around the base, one proportional step each", () => {
    const ladder = gridZoomLadder(def());
    // 5/4 up: 20→25, 5→6.25→6, 3→3.75→4 — and 4/5 down: 20→16, 5→4, 3→2.4→2
    expect(ladder).toContainEqual({ tileWidth: 25, tileHeight: 6, iconCells: 4 });
    expect(ladder).toContainEqual({ tileWidth: 31, tileHeight: 8, iconCells: 5 });
    expect(ladder).toContainEqual({ tileWidth: 16, tileHeight: 4, iconCells: 2 });
    // the base is a level of its own
    expect(ladder).toContainEqual(def());
  });

  test("every level stays inside the schema bounds (no knob runs past its own bound)", () => {
    for (const base of [
      def(),
      { tileWidth: 40, tileHeight: 10, iconCells: 5 },
      { tileWidth: 10, tileHeight: 3, iconCells: 1 },
    ]) {
      for (const level of gridZoomLadder(base)) {
        expect(level.tileWidth).toBeGreaterThanOrEqual(bounds("tileWidth").min);
        expect(level.tileWidth).toBeLessThanOrEqual(bounds("tileWidth").max);
        expect(level.tileHeight).toBeGreaterThanOrEqual(bounds("tileHeight").min);
        expect(level.tileHeight).toBeLessThanOrEqual(bounds("tileHeight").max);
        expect(level.iconCells).toBeGreaterThanOrEqual(bounds("iconCells").min);
        expect(level.iconCells).toBeLessThanOrEqual(bounds("iconCells").max);
      }
    }
  });

  test("the tile keeps its shape across the ladder (the zoom scales, it does not stretch)", () => {
    const base = def();
    const ratio = base.tileWidth / base.tileHeight;
    for (const level of gridZoomLadder(base)) {
      expect(Math.abs(level.tileWidth / level.tileHeight - ratio) / ratio).toBeLessThan(0.15);
    }
  });

  test("a base at a bound has no level beyond it (the zoom stops as one unit)", () => {
    // the icon is already maxed: the ladder must NOT keep growing the width
    const ladder = gridZoomLadder({ tileWidth: 30, tileHeight: 8, iconCells: 5 });
    expect(ladder.at(-1)).toEqual({ tileWidth: 30, tileHeight: 8, iconCells: 5 });
    // the base is the TOP of the ladder here: the icon is at its bound, so no
    // level grows past it (the width alone never runs on)
    expect(ladder.at(-2)!.tileWidth).toBeLessThan(30);
  });
});

describe("makeZoom", () => {
  test("grid zoom scales the three knobs by ONE factor", () => {
    const h = harness();
    expect(h.apply(1)).toEqual({ tileWidth: 25, tileHeight: 6, iconCells: 4 });
  });

  test("the zoom stops as one unit — a knob at its bound stops the whole step", () => {
    // the icon is maxed: the old per-axis step grew the width to 38 anyway
    const h = harness({ tileWidth: 30, tileHeight: 8, iconCells: 5 });
    expect(h.apply(1)).toEqual({});
    expect(h.live.tileWidth).toBe(30);
  });

  test("zoom in then zoom out returns the EXACT starting look", () => {
    for (const base of [
      def(),
      { tileWidth: 25, tileHeight: 6, iconCells: 4 },
      { tileWidth: 16, tileHeight: 4, iconCells: 2 },
    ]) {
      const h = harness(base);
      h.apply(1);
      h.apply(-1);
      expect(h.live).toEqual(base);
    }
  });

  test("zoom out then zoom in returns the EXACT starting look", () => {
    for (const base of [
      def(),
      { tileWidth: 16, tileHeight: 4, iconCells: 2 },
      { tileWidth: 13, tileHeight: 3, iconCells: 2 },
    ]) {
      const h = harness(base);
      const out = h.apply(-1);
      // a zoom-out at the ladder's edge is a no-op (the geometry never leaves
      // the schema bounds) — there is nothing to come back from
      if (Object.keys(out).length === 0) continue;
      h.apply(1);
      expect(h.live).toEqual(base);
    }
  });

  test("a manual geometry change re-anchors the ladder (the zoom does not walk a stale one)", () => {
    const h = harness();
    h.apply(1); // 20/5/3 → 25/6/4
    // the settings steppers moved the tile width under the zoom's feet
    h.live.tileWidth = 33;
    h.apply(-1);
    // the ladder was rebuilt from 33/6/4, so the zoom-out lands BELOW that,
    // not back on the level it left
    expect(h.live.tileWidth).not.toBe(25);
    expect(h.live.tileWidth).toBeLessThan(33);
  });

  test("list zoom moves the row height only", () => {
    const h = harness({}, "list");
    expect(h.apply(1)).toEqual({ listRowHeight: defaultConfig.ui.listRowHeight + 1 });
    expect(h.live).toEqual(def()); // the grid knobs are untouched
  });

  test("list zoom is exactly reversible (one int knob)", () => {
    const h = harness({}, "list");
    h.apply(1);
    h.apply(-1);
    expect(h.rowHeight()).toBe(defaultConfig.ui.listRowHeight);
  });

  test("the list row height stops at its schema bound", () => {
    const h = harness({}, "list");
    for (let i = 0; i < 5; i++) h.apply(1);
    expect(h.rowHeight()).toBe(bounds("listRowHeight").max);
    for (let i = 0; i < 5; i++) h.apply(-1);
    expect(h.rowHeight()).toBe(bounds("listRowHeight").min);
  });
});
