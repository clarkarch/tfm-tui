// --- One floating-list row shape. Pure data, no ui/imports.
//
// The type lived in ui/ui-menu.ts and was imported by eight files across three
// layers (input/, ui/, wiring/). input/grid-input.ts importing it from ui/
// was a layering inversion, and ui/ is above input/ — a latent cycle the day
// ui/ui-menu.ts wanted anything from input/.
//
// A leaf here keeps the dependency pointing the right way.
//
// The row's KIND is ONE tag. The old shape spelled it as parallel optional
// flags (`sep?: boolean` + an optional `submenu`) with a REQUIRED `action`:
// a row could be BOTH a separator and a flyout (illegal), and every
// separator carried a dummy `action: () => {}` that existed only because the
// kind was not tagged. The tag makes the illegal combinations
// unrepresentable — a separator has no action and no flyout.
//
// The fields a separator does NOT have are marked `?: undefined` rather than
// omitted, so a consumer that reads a field on the WHOLE union still gets an
// honest `string | undefined` (not a "property does not exist" error), and
// the narrowing by `kind` is what turns it back into the exact type. ---

export type ListEntryBase = {
  icon?: string;
  label: string;
  hint?: string;
  hintIcon?: string;
};

// a row that runs an action when it is activated
export type ListItem = ListEntryBase & { kind: "item"; action: () => void };

// a row that runs an action AND opens a flyout with its variants (the parent
// row stays directly clickable — its action fires on click/enter, the flyout
// opens on hover / →)
export type ListFlyout = ListEntryBase & { kind: "flyout"; action: () => void; submenu: ListEntry[] };

// a separator: a GAP between groups. No label, no action, no flyout.
export type ListSep = {
  kind: "sep";
  icon?: undefined;
  label?: undefined;
  hint?: undefined;
  hintIcon?: undefined;
  action?: undefined;
  submenu?: undefined;
};

export type ListEntry = ListItem | ListFlyout | ListSep;

// the rows that can be ACTIVATED (everything but a separator)
export type ListActionable = ListItem | ListFlyout;

// a separator is a GAP — it is not actionable; every other row is
export const isActionEntry = (entry: ListEntry): entry is ListActionable => entry.kind !== "sep";
