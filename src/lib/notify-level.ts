// --- Toast severity: the single level vocabulary for notify() and every sink
// that reports through it. Lives here (not ui/notify) so fs/app/input/dnd
// type-imports stay out of ui/ — same layering rule as ./uiutil. ---
export type NotifyLevel = "info" | "success" | "error";
