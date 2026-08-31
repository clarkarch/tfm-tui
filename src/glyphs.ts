// --- Nerd Font glyphs: FALLBACK ONLY ---
// Used when rsvg-convert is missing or a raster hasn't drained yet.
// Codepoints verified against the MesloLGLDZ Nerd Font Mono cmap — never
// paste guessed ones (see AGENTS.md "Icons").

export const glyph: Record<string, string> = {
  home: "\u{F02DC}",
  star: "\u{F04CE}",
  clock: "\u{F0954}",
  bookmark: "\u{F00C6}",
  "trash-can": "\u{F0A79}",
  folder: "\u{F024B}",
  harddisk: "\u{F02CA}",
  usb: "\u{F0553}",
  eject: "\u{F01EA}",
  search: "\u{F002}",
  file: "\u{F0214}",
  "chevron-left": "\u{F0141}",
  "chevron-right": "\u{F0142}",
  "desktop-tower": "\u{F01C5}",
  cog: "\u{F0493}",
  power: "\u{F0425}",
  eye: "\u{F0208}",
  "eye-off": "\u{F0209}",
  "content-copy": "\u{F018F}",
  "content-paste": "\u{F0192}",
  "content-cut": "\u{F0190}",
  information: "\u{F02FD}",
  pencil: "\u{F03EB}",
  "folder-plus": "\u{F0770}",
  "select-all": "\u{F0478}",
  sort: "\u{F04BA}",
  "checkbox-marked": "\u{F0132}",
  "checkbox-blank": "\u{F0131}",
  pause: "\u{F03E4}",
  play: "\u{F040A}",
  close: "\u{F0156}",
  terminal: "\u{F120}",
  plus: "\u{F0415}",
};

export const glyphFor = (name: string): string => glyph[name] ?? "\u{FFFD}";

// every file-type category the classifier can emit must have a glyph: fill
// unknown ones with the generic file glyph so a new filetype never renders □
export const ensureGlyphFallbacks = (names: Iterable<string>): void => {
  for (const n of names) if (!(n in glyph)) glyph[n] = glyph.file!;
};
