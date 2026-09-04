// --- Shared sort mode: canonical owner for the name/size/mtime/type sort
// key. Lives in lib/ so fs/ (listing) and app/ (nav) don't depend on ui/
// (menu-entries) for a pure data type. menu-entries re-exports it for
// backwards compatibility. ---

export type SortMode = "name" | "size" | "mtime" | "type";
