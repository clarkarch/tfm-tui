// --- Mouse pointer styles: the subset of OpenTUI's MousePointerStyle tfm
// actually uses. A local union (not the upstream type) keeps pure modules
// (input/, fs/) free of @opentui/core imports; the wiring narrows it at the
// renderer boundary via makePointerSetter. Add a variant here when a new
// site needs one. ---
export type PointerStyle = "default" | "pointer" | "text" | "grabbing" | "not-allowed";
