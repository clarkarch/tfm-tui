// --- Shared sort mode: canonical owner for the name/size/mtime/type sort
// key. Lives in lib/ so fs/ (listing) and app/ (nav) don't depend on ui/
// (menu-entries) for a pure data type. menu-entries re-exports it for
// backwards compatibility. ---

export type SortMode = "name" | "size" | "mtime" | "type";

// one-key sort cycling (nautilus convention, mirrors menu-entries: a new key
// sorts in its natural direction). Used by the cycleSort keybind.
const SORT_ORDER: SortMode[] = ["name", "size", "mtime", "type"];
const SORT_NATURAL_ASC: Record<SortMode, boolean> = { name: true, size: false, mtime: true, type: true };

export const cycleSortMode = (current: SortMode): { sortBy: SortMode; sortAsc: boolean } => {
  const next = SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length]!;
  return { sortBy: next, sortAsc: SORT_NATURAL_ASC[next] };
};
