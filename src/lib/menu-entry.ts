// --- One floating-list row shape. Pure data, no ui/imports.
//
// The type lived in ui/ui-menu.ts and was imported by eight files across three
// layers (input/, ui/, wiring/). input/grid-input.ts importing it from ui/
// was a layering inversion, and ui/ is above input/ — a latent cycle the day
// ui/ui-menu.ts wanted anything from input/.
//
// A leaf here keeps the dependency pointing the right way.

export type ListEntry = {
  icon?: string;
  label: string;
  hint?: string;
  hintIcon?: string;
  action: () => void;
  sep?: boolean;
  // nested flyout items; a parent row stays directly clickable (its action
  // fires on click/enter, the flyout opens on hover / →)
  submenu?: ListEntry[];
};
