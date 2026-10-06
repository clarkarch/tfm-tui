// --- Shared sort mode: canonical owner for the name/size/mtime/type sort
// key. Lives in lib/ so fs/ (listing) and app/ (nav) don't depend on ui/
// (menu-entries) for a pure data type. menu-entries re-exports it for
// backwards compatibility. ---

export type SortMode = "name" | "size" | "mtime" | "type";

// one-key sort cycling (nautilus convention, mirrors menu-entries: a new key
// sorts in its natural direction). Used by the cycleSort keybind.
const SORT_ORDER: SortMode[] = ["name", "size", "mtime", "type"];
const SORT_NATURAL_ASC: Record<SortMode, boolean> = { name: true, size: false, mtime: true, type: true };

// boot default direction for a mode (nav seeds sortAsc from the configured
// sort-mode; cycleSortMode below reuses it so the two can't drift)
export const naturalAscFor = (mode: SortMode): boolean => SORT_NATURAL_ASC[mode] ?? true;

export const cycleSortMode = (current: SortMode): { sortBy: SortMode; sortAsc: boolean } => {
  // the modulo keeps the index in range for the non-empty table, so `current`
  // is an unreachable-but-total fallback rather than a non-null assertion
  const next = SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length] ?? current;
  return { sortBy: next, sortAsc: naturalAscFor(next) };
};

// converge one pane's sort state onto the configured mode (the applyConfig
// hook): a mode change re-sorts in the new natural direction, mirroring the
// menu pick; an unchanged mode keeps a manual flip (same-key toggle, cycle
// landing) instead of snapping it back
export const syncSortState = (state: { sortBy: SortMode; sortAsc: boolean }, mode: SortMode): void => {
  if (state.sortBy !== mode) {
    state.sortBy = mode;
    state.sortAsc = naturalAscFor(mode);
  }
};
