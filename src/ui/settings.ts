import type { ThemePreset } from "../config/themes";
import { UI_SCHEMA, type UiConfig } from "../config/config-schema";

// --- Settings model: declarative rows drive both rendering and key/mouse
// input. This module owns the row TYPE and the pure row semantics (adjust /
// flatten / theme-preset lookup); the get/set closures that wire rows to
// config/state live in ./settings-model, the panel in ./ui-settings-panel. ---

export type SettingRow =
  // `repaint` rows (theme / ui-style / transparent-bg) change the panel's own
  // colors — their adjust re-renders the panel; other value rows update their
  // value text by id (targeted, no rebuild — see the OOM note in AGENTS.md)
  | { kind: "toggle"; label: string; repaint?: boolean; get: () => boolean; set: (v: boolean) => void }
  | {
      kind: "stepper";
      label: string;
      repaint?: boolean;
      min: number;
      max: number;
      step: number;
      fmt: (v: number) => string;
      get: () => number;
      set: (v: number) => void;
    }
  | {
      kind: "cycle";
      label: string;
      repaint?: boolean;
      names: string[];
      getIdx: () => number;
      setIdx: (i: number) => void;
    }
  // key rows are enter/click-driven (capture flow in ui-settings), not adjustable
  | { kind: "keybind"; label: string; get: () => string[]; set: (v: string[]) => void }
  | { kind: "action"; label: string; keepOpen?: boolean; run: () => void };

export type SettingGroup = { header?: string; rows: SettingRow[] };

export const flattenRows = (groups: SettingGroup[]): SettingRow[] => groups.flatMap((g) => g.rows);

// apply one left/right adjustment to a row; false = nothing happened (action
// rows, steppers pinned at min/max)
export const applyAdjust = (row: SettingRow, dir: number): boolean => {
  switch (row.kind) {
    case "toggle":
      row.set(!row.get());
      return true;
    case "stepper": {
      const next = Math.max(row.min, Math.min(row.max, row.get() + dir * row.step));
      if (next !== row.get()) {
        row.set(next);
        return true;
      }
      return false;
    }
    case "cycle": {
      const n = row.names.length;
      const cur = row.getIdx();
      const next = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
      row.setIdx(next);
      return true;
    }
    default:
      return false;
  }
};

// index of the preset whose theme round-trips byte-equal to the live one
// (JSON compare — config stores/compares RAW hex, the transparent-bg nudge is
// runtime-only), or -1 when customized
export const themePresetIdx = (presets: ThemePreset[], theme: unknown): number =>
  presets.findIndex((p) => JSON.stringify(p.theme) === JSON.stringify(theme));

// zoom step for the zoomIn/zoomOut keybinds (ctrl+= / ctrl+-): grid view
// scales tile W/H plus the icon cells so tiles and glyphs grow together;
// list view scales the row height instead. Bounds/steps come from the schema
// int rows (single source — same numbers the layout steppers use); saturated
// axes hold their bound so zooming at min/max is a no-op patch.
type ZoomProp = "tileWidth" | "tileHeight" | "iconCells" | "listRowHeight";

const zoomStep = (ui: UiConfig, prop: ZoomProp, dir: number): number => {
  const row = UI_SCHEMA.find((r) => r.prop === prop);
  if (row?.kind !== "int") return ui[prop];
  return Math.max(row.min, Math.min(row.max, ui[prop] + dir * row.step));
};

export const zoomUiPatch = (ui: UiConfig, dir: number): Partial<UiConfig> =>
  ui.viewMode === "list"
    ? { listRowHeight: zoomStep(ui, "listRowHeight", dir) }
    : {
        tileWidth: zoomStep(ui, "tileWidth", dir),
        tileHeight: zoomStep(ui, "tileHeight", dir),
        iconCells: zoomStep(ui, "iconCells", dir),
      };
