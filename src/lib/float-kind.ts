// --- The floating-layer vocabulary.
//
// The kinds of layer the floats stack can hold, and which of them host a
// focused TEXT INPUT. A pure list (no behavior, no imports) so the ui layer
// (the floats stack itself) and the key router (which must NOT mark an
// editor's keys handled) can both read it without importing each other.

export type FloatKind = "filemenu" | "props" | "conflict" | "yesno" | "escmenu" | "pick" | "prompt" | "bulkrename";

// Float kinds whose surface hosts a focused text INPUT: the key router
// DELEGATES their keys instead of marking them handled (the Input receives
// the typing natively). A new editor-ish float that misses this list
// DEAD-LETTERS every typed character — the symptom is "typing does nothing
// in the overlay". The key router switches over this list with a `never`
// exhaustiveness check, so a new kind is a COMPILE error there until the
// router knows how to ask about it.
export const EDITOR_FLOAT_KINDS = ["pick", "prompt", "bulkrename"] as const satisfies readonly FloatKind[];

export type EditorFloatKind = (typeof EDITOR_FLOAT_KINDS)[number];
