// --- Nerd Font glyphs: FALLBACK ONLY ---
// Used when no SVG rasterizer is installed (resvg/rsvg-convert) or a raster
// hasn't drained yet.
// Codepoints verified against the MesloLGLDZ Nerd Font Mono cmap — never
// paste guessed ones (see AGENTS.md "Icons").
//
// Two styles ([ui] icon-style): every slot keeps its filled codepoint under
// the base name, and slots with an MDI outline sibling carry it under
// `<name>-outline` (same suffix as the outline SVG assets, so the coverage
// test sees both). Slots with no outline sibling (power, sort, pause,
// content-*, chevrons, …) have no -outline entry and resolve filled.
// close/check stay filled-only deliberately: their MDI "outline" variants
// are different busy icons (multi-X, double-check), not hollow versions.
import type { IconStyle } from "../config/config-schema";

// The generic file glyph, NAMED rather than looked up: every file-type category
// falls back to it (and ensureGlyphFallbacks fills the table from it), so it
// needs to be a value the type system knows is present, not a Record lookup.
export const FILE_GLYPH = "\u{F0214}";

export const glyph: Record<string, string> = {
  home: "\u{F02DC}",
  star: "\u{F04CE}",
  clock: "\u{F0954}",
  bookmark: "\u{F00C6}",
  "trash-can": "\u{F0A79}",
  folder: "\u{F024B}",
  harddisk: "\u{F02CA}",
  usb: "\u{F0553}",
  network: "\u{F059F}",
  eject: "\u{F01EA}",
  search: "\u{F0349}",
  file: FILE_GLYPH,
  "chevron-left": "\u{F0141}",
  "chevron-right": "\u{F0142}",
  "desktop-tower": "\u{F01C5}",
  cog: "\u{F0493}",
  power: "\u{F0425}",
  "power-plug": "\u{F06A5}",
  eye: "\u{F0208}",
  "eye-off": "\u{F0209}",
  "content-copy": "\u{F018F}",
  "content-paste": "\u{F0192}",
  "content-cut": "\u{F0190}",
  // md-content_duplicate (fontTools-verified): the Duplicate entry's own
  // icon (it shared content-copy's before the icon-style toggle)
  "content-duplicate": "\u{F0191}",
  // filled (not outline): information F02FC = md-information,
  // help F02D7 = md-help_circle (both fontTools-verified)
  information: "\u{F02FC}",
  help: "\u{F02D7}",
  pencil: "\u{F03EB}",
  "folder-plus": "\u{F0770}",
  "select-all": "\u{F0478}",
  sort: "\u{F04BA}",
  "checkbox-marked": "\u{F0132}",
  "checkbox-blank": "\u{F012E}",
  pause: "\u{F03E4}",
  play: "\u{F040A}",
  close: "\u{F0156}",
  check: "\u{F012C}",
  terminal: "\u{F120}",
  plus: "\u{F0415}",
  disc: "\u{F05EE}",
  "cog-box": "\u{F0494}",
  package: "\u{F03D3}",
  "file-font": "\u{F06D6}",
  "book-open": "\u{F00BD}",
  database: "\u{F01BC}",
  certificate: "\u{F0124}",
  cube: "\u{F01A6}",
  email: "\u{F01EE}",
  magnet: "\u{F0347}",
  android: "\u{F0032}",
  // md-border_vertical (fontTools-verified): the "open in new pane" divider
  "border-vertical": "\u{F00D2}",
  // settings categories, filled base: keyboard F030C = md-keyboard,
  // palette F03D8 = md-palette, lightning-bolt F140B = md-lightning_bolt
  // (all fontTools-verified against the MesloLGLDZ Nerd Font Mono cmap)
  keyboard: "\u{F030C}",
  palette: "\u{F03D8}",
  "lightning-bolt": "\u{F140B}",
  // outline siblings ([ui] icon-style = "outline"): one per MDI outline
  // asset, same `-outline` suffix (all fontTools-verified)
  "home-outline": "\u{F06A1}",
  "star-outline": "\u{F04D2}",
  "clock-outline": "\u{F0150}",
  "bookmark-outline": "\u{F00C3}",
  "trash-can-outline": "\u{F0A7A}",
  "folder-outline": "\u{F0256}",
  "eject-outline": "\u{F0B91}",
  "file-outline": "\u{F0224}",
  "cog-outline": "\u{F08BB}",
  "power-plug-outline": "\u{F1425}",
  "eye-outline": "\u{F06D0}",
  "eye-off-outline": "\u{F06D1}",
  "pencil-outline": "\u{F0CB6}",
  "checkbox-marked-outline": "\u{F0135}",
  "play-outline": "\u{F0F1B}",
  "plus-outline": "\u{F0705}",
  "folder-plus-outline": "\u{F0B9D}",
  "keyboard-outline": "\u{F097B}",
  "palette-outline": "\u{F0E0C}",
  "lightning-bolt-outline": "\u{F140C}",
  "information-outline": "\u{F02FD}",
  "help-outline": "\u{F0625}",
  "checkbox-blank-outline": "\u{F0131}",
  "book-open-outline": "\u{F0B63}",
  "database-outline": "\u{F1632}",
  "certificate-outline": "\u{F1188}",
  "cube-outline": "\u{F01A7}",
  "email-outline": "\u{F01F0}",
  "file-code-outline": "\u{F102B}",
  "file-document-outline": "\u{F09EE}",
  "file-image-outline": "\u{F0EB0}",
  "file-video-outline": "\u{F0E2C}",
  "file-music-outline": "\u{F0E2A}",
  "zip-box-outline": "\u{F0FFA}",
  // sort-direction arrows (menu hintIcon): standard Unicode arrows, NOT Nerd
  // PUA codepoints — U+2191/2193 ship in Meslo and virtually every monospace
  // font, so they render even where the Nerd patch is incomplete. Without
  // these the active sort column falls back to U+FFFD tofu in glyph mode.
  "arrow-up": "↑",
  "arrow-down": "↓",
};

export const glyphFor = (name: string, style: IconStyle = "filled"): string => {
  if (style === "outline") return glyph[`${name}-outline`] ?? glyph[name] ?? "\u{FFFD}";
  return glyph[name] ?? "\u{FFFD}";
};

// every file-type category the classifier can emit must have a glyph: fill
// unknown ones with the generic file glyph so a new filetype never renders □
export const ensureGlyphFallbacks = (names: Iterable<string>): void => {
  for (const n of names) if (!(n in glyph)) glyph[n] = FILE_GLYPH;
};
