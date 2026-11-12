import type { ThemePreset } from "../config/themes";
import type { SettingRow, SettingGroup } from "../config/config-schema";

// --- Settings model: declarative rows drive both rendering and key/mouse
// input. This module owns the row semantics (adjust / flatten / theme-preset
// lookup); the get/set closures that wire rows to config/state live in
// ./settings-model, the panel in ./ui-settings-panel. The row/group TYPES
// live in ./config/config-schema (a leaf) so the plugin api can reference
// them without importing ui/ — re-exported here for existing callers. ---

export type { SettingRow, SettingGroup };

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
      // an empty name list has no end to pick — the old path computed
      // n - 1 = -1 and handed setIdx(-1), which indexes names[-1]
      if (n === 0) return false;
      const sel = row.get();
      // a custom value (one that matches no name) starts from an end: forward
      // lands on the first name, backward on the last
      const cur = sel.kind === "index" ? sel.index : -1;
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

// nearest preset by shared key values (for the "~Name" custom label when the
// live theme matches no preset exactly). -1 when presets is empty.
export const themeNearestIdx = (presets: ThemePreset[], theme: unknown): number => {
  if (typeof theme !== "object" || theme === null) return -1;
  const t = theme as Record<string, unknown>;
  let best = -1,
    bestScore = -1;
  for (let i = 0; i < presets.length; i++) {
    const p = presets[i]?.theme as Record<string, unknown>;
    if (typeof p !== "object" || p === null) continue;
    let score = 0;
    for (const k of Object.keys(p)) if (t[k] === p[k]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
};

// NOTE: the zoomIn/zoomOut keybinds (ctrl+= / ctrl+-) do NOT live here — they
// are in ./zoom: the grid zoom scales the tile W/H plus the icon cells
// together as ONE proportional ladder (the old per-axis step let each axis
// saturate on its own, so the tile ran on to "too big" and a zoom-in/zoom-out
// round trip lost a cell it never gained); the list view scales the row
// height instead.
