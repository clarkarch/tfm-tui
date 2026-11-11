// --- Icon slot state vocabulary. Pure data, no ui/imports.
//
// These two lived in ui/ui-slots.ts, which forced input/selection.ts to
// import UP into ui/ for a 5-key constant and a 2-field record. ui/ is above
// input/, so that was a layering inversion — and a latent cycle the day
// ui/ui-slots.ts wanted anything from input/.
//
// A leaf here keeps the dependency pointing the right way: input/ and ui/ both
// depend on lib/, never on each other for this vocabulary.

export type IconState = { fg: string; bg: string };

// The slot FAMILIES. Each family owns its OWN index space.
//
// The old vocabulary was ONE numeric space (IconStateIdx) with three
// meanings: index 1 was "on" for a toggle, "disabled" for a nav button and
// "hover" for a tile, and the hover OFFSET was the same constant as
// "selected". A nav slot painted with a toggle index compiled fine and
// showed the WRONG palette — the numbers were shared, the meanings were not.
//
// The family is a TYPE, not a runtime tag: an index carries it as a brand,
// so the state seam refuses another family's index at compile time. The
// runtime value stays a plain number — the raster pipeline indexes the
// palette by POSITION, and the positions did not move.
export type IconFamily = "select" | "toggle" | "nav" | "active" | "plain";

declare const iconIndexBrand: unique symbol;

/** A palette index, branded with the family that owns the palette. */
export type IconIndex<F extends IconFamily> = number & { readonly [iconIndexBrand]: F };

export type SelectIndex = IconIndex<"select">;
export type ToggleIndex = IconIndex<"toggle">;
export type NavIndex = IconIndex<"nav">;
export type ActiveIndex = IconIndex<"active">;
export type PlainIndex = IconIndex<"plain">;

// select family — tiles + sidebar rows: rest / hover / selected / cut
export const SelectIdx = {
  Rest: 0 as SelectIndex,
  Hover: 1 as SelectIndex,
  Selected: 2 as SelectIndex,
  Cut: 3 as SelectIndex,
} as const;

// toggle family — star, bookmark, tab close, crumbs, hover buttons, esc hint:
// off / on / off-hover / on-hover. The hover states are their OWN positions:
// the old "HoverOffset" arithmetic added 2 to a base index, and in the shared
// space that made the hover offset the SAME constant as "selected".
export const ToggleIdx = {
  Off: 0 as ToggleIndex,
  On: 1 as ToggleIndex,
  OffHover: 2 as ToggleIndex,
  OnHover: 3 as ToggleIndex,
} as const;

// nav family — back/fwd: enabled / disabled / enabled-hover / disabled-hover.
// The INVERSE sense of a toggle (enabled is the resting state), which is why
// it is a family of its own and not a toggle with flipped flags.
export const NavIdx = {
  Enabled: 0 as NavIndex,
  Disabled: 1 as NavIndex,
  EnabledHover: 2 as NavIndex,
  DisabledHover: 3 as NavIndex,
} as const;

// active family — settings category/root icons + menu entry icons:
// rest / active
export const ActiveIdx = {
  Rest: 0 as ActiveIndex,
  Active: 1 as ActiveIndex,
} as const;

// plain family — a slot with ONE palette entry (the About logo, a toast icon,
// the properties hero): nothing switches its state.
export const PlainIdx = {
  Rest: 0 as PlainIndex,
} as const;

// The raster's phase — a TAG, not a boolean:
//   - "pending": the slot was never rastered (or the attempt is in flight);
//   - "ready": the raster landed;
//   - "failed": the attempt did not land (the slot keeps its fallback glyph
//     until the next RESET re-arms it).
// The old optional `done` boolean could not tell "ready" from "failed": a
// failed raster was marked done, so the spec looked finished and the drain
// never retried it.
export type IconPhase = "pending" | "ready" | "failed";

export type IconSpec<F extends IconFamily = IconFamily> = {
  slotId: string;
  name: string;
  heightCells: number;
  states: IconState[];
  // slots that survive renderAll rebuilds (nav/search/sort) must derive fresh
  // state colors on every re-raster, or a runtime theme swap leaves them stale
  statesFactory?: () => IconState[];
  // the CURRENT palette position, branded with the slot's family — the seam
  // refuses another family's index
  initialState: IconIndex<F>;
  phase: IconPhase;
  // faithful brand art (the About logo): drains through brandPng (no fg tint)
  // instead of iconPng. States still carry fg/bg for the glyph fallback.
  faithful?: boolean;
};

// The state seam — ONE spelling for every ctx that takes it.
//
// The family is inferred from the SPEC alone (NoInfer keeps the state
// argument out of the inference), so a state index from another family does
// not type-check. Without NoInfer the two arguments could agree on a union
// family and the check would be void.
//
// The return says whether the paint LANDED: false when the spec is missing
// or the slot is not mounted (the caller gets no visible change).
export type SetIconState = <F extends IconFamily>(
  spec: IconSpec<F> | undefined,
  state: IconIndex<NoInfer<F>>,
) => boolean;
