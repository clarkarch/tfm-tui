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

// Icon raster indices shared by every slot. Three slot families share one
// index space:
// - select slots (tiles, sidebar rows): Rest/Hover/Selected (+ Cut for tiles)
// - toggle slots (star, crumbs, hover buttons): Off/On + HoverOffset
// - nav slots (back/fwd): Enabled/Disabled + HoverOffset (note: Enabled=0,
//   Disabled=1 — the inverse sense of a toggle, hence the separate helper)
export const IconStateIdx = { Rest: 0, Active: 1, Selected: 2, Cut: 3, HoverOffset: 2 } as const;

export type IconSpec = {
  slotId: string;
  name: string;
  heightCells: number;
  states: IconState[];
  // slots that survive renderAll rebuilds (nav/search/sort) must derive fresh
  // state colors on every re-raster, or a runtime theme swap leaves them stale
  statesFactory?: () => IconState[];
  initialState: number;
  done?: boolean;
  // faithful brand art (the About logo): drains through brandPng (no fg tint)
  // instead of iconPng. States still carry fg/bg for the glyph fallback.
  faithful?: boolean;
};
