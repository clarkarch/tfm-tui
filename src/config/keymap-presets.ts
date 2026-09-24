// --- Keymap presets: named full-[keys] tables applied as one batch (Settings
// → keys → preset row, or future `tfm keys` CLI). Applying OVERWRITES every
// action's binds like manual remaps — nothing is stashed. Tables are the
// source of truth for their preset; re-selecting "tfm" restores canonical
// defaults. Pure module: no fs, no renderer. ---
import { defaultConfig, type Config, type KeyAction } from "./config-schema";

type KeysConfig = Config["keys"];

export const KEYMAP_PRESET_NAMES = ["tfm", "yazi"] as const;
export type KeymapPreset = (typeof KEYMAP_PRESET_NAMES)[number];

// the preset's [ui] type-to-search flip (yazi binds bare j/k/h/l… so the auto
// filter must be off or late-group bare binds get swallowed by the catch-all)
export const PRESET_TYPE_TO_SEARCH: Record<KeymapPreset, boolean> = { tfm: true, yazi: false };

// the preset's view flip: yazi's hjkl is 1D list navigation, unusable on the
// 2D grid — yazi forces list, tfm forces grid back. Manual override anytime
// via ctrl+g (row then reads "custom", like any hand edit).
export const PRESET_VIEW_MODE: Record<KeymapPreset, "grid" | "list"> = { tfm: "grid", yazi: "list" };

// canonical tfm binds = schema defaults (fresh clone per call)
export const tfmKeys = (): KeysConfig => structuredClone(defaultConfig.keys);

// yazi [mgr]+[confirm]+[help] mapped onto tfm actions. One row steers every
// context, so arrows keep their spatial grid meaning (no Left→parent:
// moveLeft owns "left") and h/l cover yazi leave/enter. Chords (gg/g h/t t/
// c c/, s) have no engine — those commands stay unbound. D (permanent
// delete) deliberately maps to trash: same confirm flow, no surprise loss.
export const yaziKeys = (): KeysConfig => ({
  ...structuredClone(defaultConfig.keys),
  quit: ["ctrl+q", "q"],
  openMenu: ["escape", "~", "f1"],
  toggleHidden: ["ctrl+h", "."],
  reloadPlaces: [],
  newTab: ["ctrl+t"],
  closeTab: ["ctrl+w", "ctrl+c"],
  nextTab: ["ctrl+tab", "]"],
  prevTab: ["ctrl+shift+tab", "["],
  selectAll: ["ctrl+a"],
  trash: ["delete", "d"],
  renameOrRestore: ["f2", "r"],
  copy: ["y"],
  cut: ["x"],
  duplicate: [],
  paste: ["p", "shift+p"],
  undo: ["ctrl+z"],
  redo: ["ctrl+y", "ctrl+shift+z"],
  parentDir: ["backspace", "h"],
  histBack: ["alt+left", "shift+h"],
  histForward: ["alt+right", "shift+l"],
  showProps: ["alt+enter"],
  newFolder: ["ctrl+shift+n"],
  newFile: ["ctrl+alt+n", "a"],
  pathEdit: ["ctrl+l"],
  togglePreview: ["f9"],
  openTerminal: ["f4"],
  connectServer: ["ctrl+shift+s"],
  toggleView: ["ctrl+g"],
  zoomIn: ["ctrl+="],
  zoomOut: ["ctrl+-"],
  toggleDualPane: ["ctrl+shift+d"],
  switchPane: ["tab"],
  copyToOtherPane: ["f5"],
  moveToOtherPane: ["f6"],
  moveUp: ["up", "k"],
  moveDown: ["down", "j"],
  moveLeft: ["left"],
  moveRight: ["right"],
  openSelected: ["return", "l", "o"],
  pageUp: ["pageup", "ctrl+b", "ctrl+u"],
  pageDown: ["pagedown", "ctrl+f", "ctrl+d"],
  firstItem: ["home"],
  lastItem: ["end", "shift+g"],
  startSearch: ["s", "/", "f"],
  extendUp: ["shift+up"],
  extendDown: ["shift+down"],
  extendLeft: ["shift+left"],
  extendRight: ["shift+right"],
  toggleFocused: ["space"],
  invertSelection: ["ctrl+r"],
});

export const presetKeys = (name: KeymapPreset): KeysConfig => (name === "yazi" ? yaziKeys() : tfmKeys());

const sameBinds = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const sb = [...b].sort();
  return [...a].sort().every((s, i) => s === sb[i]);
};

// 0 = tfm, 1 = yazi, -1 = hand-edited (settings row shows "custom")
export const keymapPresetIdx = (keys: Partial<Record<KeyAction, string[]>>): number => {
  const names: KeymapPreset[] = [...KEYMAP_PRESET_NAMES];
  // index + value from one iteration: no indexed read to assert
  for (const [i, name] of names.entries()) {
    const table = presetKeys(name);
    if ((Object.keys(table) as KeyAction[]).every((a) => sameBinds(keys[a] ?? [], table[a]))) return i;
  }
  return -1;
};
