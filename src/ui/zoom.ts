// --- The grid zoom (ctrl+= / ctrl+-): ONE proportional scale over the three
// grid knobs, walked as an explicit ladder.
//
// The old zoom stepped EVERY axis on its own (+1 cell per axis, each clamped
// at its own schema bound). Two things broke:
//
//   - the axes saturated at DIFFERENT steps, so the tile width could keep
//     growing to 40 while the icon was already maxed (a squat, "too big"
//     tile) — and the other way round, a 1-row icon in a wide tile;
//   - a zoom-in followed by a zoom-out did NOT return to the starting look:
//     every axis that had clamped on the way in stayed clamped on the way
//     out (the icon lost a cell it never gained).
//
// The ladder fixes both: every level scales ALL THREE knobs by ONE rational
// factor (5/4 up, 4/5 down), a level that would push any knob past its
// schema bound ENDS the ladder (the zoom stops as one unit — no axis runs on
// alone), and the zoom's position is a LEVEL IN THE LADDER, so walking back
// lands on the exact triple it started from.
//
// The list view zooms the row height, which is ONE knob: an int step is
// exactly reversible on its own, so it needs no ladder. ---

import { UI_SCHEMA, type UiConfig } from "../config/config-schema";

/** the three grid knobs the zoom scales together */
export type GridTriple = {
  tileWidth: number;
  tileHeight: number;
  iconCells: number;
};

type GridProp = keyof GridTriple;

const GRID_PROPS: readonly GridProp[] = ["tileWidth", "tileHeight", "iconCells"];

// the scale: 5/4 up, 4/5 down. A rational factor (not 1.25 / 0.8) so the
// integer rounding never lands on a .5 boundary inside the schema's ranges —
// a .5 rounds UP and would make a level gain a cell it never lost.
const ZOOM_UP = { num: 5, den: 4 } as const;
const ZOOM_DOWN = { num: 4, den: 5 } as const;

type IntBounds = { min: number; max: number; step: number };

// the schema rows are the ONE source of the bounds: the settings steppers and
// the zoom must agree on where a knob ends.
const intRow = (prop: GridProp | "listRowHeight"): IntBounds => {
  const row = UI_SCHEMA.find((r) => r.prop === prop);
  if (row?.kind !== "int") return { min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 };
  return { min: row.min, max: row.max, step: row.step };
};

const scaleTriple = (t: GridTriple, num: number, den: number): GridTriple => ({
  tileWidth: Math.round((t.tileWidth * num) / den),
  tileHeight: Math.round((t.tileHeight * num) / den),
  iconCells: Math.round((t.iconCells * num) / den),
});

export const sameTriple = (a: GridTriple, b: GridTriple): boolean =>
  a.tileWidth === b.tileWidth && a.tileHeight === b.tileHeight && a.iconCells === b.iconCells;

const withinBounds = (t: GridTriple): boolean =>
  GRID_PROPS.every((p) => {
    const b = intRow(p);
    return t[p] >= b.min && t[p] <= b.max;
  });

/**
 * The ladder around a base triple: level 0 is the base, the levels above
 * grow, the levels below shrink. A level that would leave ANY knob outside
 * its schema bounds ends the ladder — the zoom stops as one unit, so the
 * three knobs never drift apart at the ends.
 */
export const gridZoomLadder = (base: GridTriple): GridTriple[] => {
  const levels: GridTriple[] = [base];
  for (;;) {
    const last = levels[levels.length - 1];
    if (!last) break;
    const next = scaleTriple(last, ZOOM_UP.num, ZOOM_UP.den);
    if (!withinBounds(next) || sameTriple(next, last)) break;
    levels.push(next);
  }
  for (;;) {
    const first = levels[0];
    if (!first) break;
    const next = scaleTriple(first, ZOOM_DOWN.num, ZOOM_DOWN.den);
    if (!withinBounds(next) || sameTriple(next, first)) break;
    levels.unshift(next);
  }
  return levels;
};

export type ZoomDeps = {
  /** the live view mode: the grid zoom and the list zoom are different scales */
  viewMode: () => "grid" | "list";
  /** the live grid knobs (tile width / height / icon cells) */
  grid: () => GridTriple;
  /** the live list row height */
  listRowHeight: () => number;
};

/**
 * The zoom owner. ONE record says where the zoom stands: the ladder it
 * walks and the level it is on. The ladder is REBUILT when the live knobs
 * stop matching the level (the settings steppers, a config reload), so the
 * zoom starts from the current geometry instead of walking a stale ladder.
 */
export const makeZoom = (deps: ZoomDeps) => {
  let ladder: GridTriple[] | null = null;
  let level = 0;

  const currentLadder = (): GridTriple[] => {
    const live = deps.grid();
    const at = ladder?.[level];
    if (!ladder || !at || !sameTriple(at, live)) {
      // the ladder is built AROUND its base, so the base sits in the middle:
      // the level is the base's index, not 0
      ladder = gridZoomLadder(live);
      level = Math.max(
        0,
        ladder.findIndex((l) => sameTriple(l, live)),
      );
    }
    return ladder;
  };

  /** the config patch for one zoom step; empty when the zoom is at its limit */
  const patch = (dir: number): Partial<UiConfig> => {
    if (deps.viewMode() === "list") {
      // ONE knob: an int step is exactly reversible, so no ladder here
      const row = intRow("listRowHeight");
      const live = deps.listRowHeight();
      const next = Math.max(row.min, Math.min(row.max, live + dir * row.step));
      return next === live ? {} : { listRowHeight: next };
    }
    const levels = currentLadder();
    const next = Math.max(0, Math.min(levels.length - 1, level + dir));
    if (next === level) return {}; // at the ladder's end: no axis runs on alone
    level = next;
    const t = levels[next];
    if (!t) return {};
    return { tileWidth: t.tileWidth, tileHeight: t.tileHeight, iconCells: t.iconCells };
  };

  return { patch };
};
