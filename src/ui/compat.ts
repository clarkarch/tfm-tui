// --- compat mode: Linux console / dumb-terminal fallback ---
// Leaf (no imports from src): the console has neither kitty graphics nor the
// Nerd-Font PUA, so the kitty raster AND the Nerd glyph both miss. Compat
// forces list view + ASCII glyphs + no rasters/thumbs/anims (wired in
// wiring/core + wiring/grid + wiring/chrome + ui-retheme); this module only
// decides WHEN (TERM prefix) and renders WHAT (ASCII table).
export type CompatMode = "auto" | "on" | "off";

// linux* = the console (gpm.ts uses the same prefix); vt*/dumb = no graphics
// either. Everything else (xterm*, kitty, tmux, ghostty, wezterm…) is modern.
export const isCompatTerm = (term?: string | null): boolean => {
  if (!term) return false;
  return term === "dumb" || term.startsWith("linux") || term.startsWith("vt");
};

export const resolveCompat = (mode: CompatMode | string, term?: string | null): boolean => {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return isCompatTerm(term ?? process.env.TERM);
};

// ASCII fallbacks for the icon names glyphs.ts can emit. Console fonts carry
// the basic Latin set only — every value here is < 0x80 by construction
// (pinned by compat.test.ts). Unknown names degrade to the file marker.
const ASCII_GLYPHS: Record<string, string> = {
  folder: "D",
  home: "H",
  star: "*",
  clock: "o",
  bookmark: "B",
  "trash-can": "T",
  harddisk: "d",
  usb: "u",
  network: "N",
  eject: "E",
  search: "?",
  file: "-",
  "chevron-left": "<",
  "chevron-right": ">",
  "desktop-tower": "M",
  cog: "c",
  power: "P",
  "power-plug": "P",
  eye: "e",
  "eye-off": "x",
  "content-copy": "C",
  "content-paste": "p",
  "content-cut": "X",
  information: "i",
  pencil: "/",
  "folder-plus": "+",
  "select-all": "A",
  sort: "S",
  "checkbox-marked": "[x]",
  "checkbox-blank": "[ ]",
  pause: "|",
  play: ">",
  close: "x",
  check: "v",
  terminal: "$",
  plus: "+",
  disc: "O",
  "cog-box": "c",
  package: "K",
  "file-font": "F",
  "book-open": "W",
  database: "Q",
  certificate: "!",
  cube: "#",
  email: "@",
  magnet: "U",
  android: "R",
  "border-vertical": "|",
  "arrow-up": "^",
  "arrow-down": "v",
};

export const asciiGlyphFor = (name: string): string => ASCII_GLYPHS[name] ?? "-";
