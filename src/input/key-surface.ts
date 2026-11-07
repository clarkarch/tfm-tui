// The ONE ordered table of keyboard surfaces.
//
// Every dispatcher that has to answer "who owns this key?" asks this
// resolver — the keypress router AND the command palette. The two used to
// carry SEPARATE copies of the precedence, and they had already drifted:
// the palette's copy omitted the search, the path editor and the terminal,
// so the same action behaved differently depending on how it was invoked
// (a palette "move down" moved the grid behind a focused terminal, while
// the same keypress did nothing).
//
// The order IS the transition table: FIRST match wins. Keep it in step
// with the keymap's module header. ---

/** Every surface that can own a keypress. */
export type KeySurface =
  // overlay modals — they swallow everything (the focused editor owns typing)
  | "prompt"
  | "bulkrename"
  | "conflict"
  | "yesno"
  | "rename"
  | "props"
  // the pick overlay (core command palette + api.ui.pick)
  | "pick"
  // the esc menu (a modal, but below the palette)
  | "escmenu"
  // focused editors that own the keyboard
  | "terminal"
  | "pathedit"
  // cursor popup + the search box
  | "filemenu"
  | "search"
  // the two navigation surfaces
  | "sidebar"
  | "grid";

/** The canonical precedence: FIRST match wins. */
export const KEY_SURFACE_ORDER: readonly KeySurface[] = [
  "prompt",
  "bulkrename",
  "conflict",
  "yesno",
  "rename",
  "props",
  "pick",
  "escmenu",
  "terminal",
  "pathedit",
  "filemenu",
  "search",
  "sidebar",
  "grid",
];

/** One reader per surface: "is this surface open / does it own the key?" */
export type SurfaceReaders = { readonly [K in KeySurface]: () => boolean };

/**
 * The active surface — the first open one in the canonical order.
 *
 * `beneath` skips one surface and resolves the one UNDERNEATH it: the
 * command palette asks "what is below me?" (the palette IS the pick
 * overlay, and it closes before its action runs — the skip makes the
 * intent explicit instead of relying on that ordering).
 */
export const resolveSurface = (readers: SurfaceReaders, opts?: { beneath?: KeySurface }): KeySurface => {
  let skip = opts?.beneath;
  for (const surface of KEY_SURFACE_ORDER) {
    if (surface === skip) {
      skip = undefined;
      continue;
    }
    if (readers[surface]()) return surface;
  }
  // "grid" is always open, so the loop always returns — the fallback is
  // only a safety net for a malformed reader table
  return "grid";
};

/** Is `surface` BELOW `other` in the canonical order? */
export const surfaceBelow = (surface: KeySurface, other: KeySurface): boolean =>
  KEY_SURFACE_ORDER.indexOf(surface) > KEY_SURFACE_ORDER.indexOf(other);
