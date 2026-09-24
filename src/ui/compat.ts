// --- compat mode: Linux console / dumb-terminal fallback ---
// Leaf (no imports from src): the console has neither kitty graphics nor the
// Nerd-Font PUA, so the kitty raster AND the Nerd glyph both miss. Compat
// forces list view + ASCII glyphs + no rasters/thumbs (wired in wiring/core +
// wiring/grid + wiring/chrome + ui-retheme); text-cell anims stay enabled
// (they need no graphics protocol). The palette is a STATIC 16-color console
// theme (dark/light by configured-bg brightness) — the VT ignores 48;2
// truecolor, so user hues would collapse into one cell. This module decides
// WHEN (TERM prefix) and renders WHAT (ASCII + static palette).
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

// rebuild signature over everything that decides raster vs glyph. Grid AND
// sidebar key off this through their own `rasterSig` ctx fields, and both
// wirings must call THIS (never an inline JSON) so the two surfaces cannot
// drift into disagreeing about what a graphics-mode flip rebuilds.
export const rasterSigOf = (icons: string, compat: boolean, forceGlyph: boolean): string =>
  JSON.stringify([icons, compat, forceGlyph]);

// --- 16-color console palettes ---
// OpenTUI emits 48;2/38;2 truecolor unconditionally (ansi.ts), which the Linux
// VT ignores — subtle theme shades collapse into one cell and bg/hover look
// dead. So compat mode IGNORES the user's [theme] hues entirely and paints one
// of two hand-tuned static palettes (dark/light picked by the configured bg's
// brightness): every value is a classic VGA16 slot, and the surface roles are
// designed distinct instead of repaired after the fact.
// Design idiom: grey canvas with DARK-BLUE panels (blue sidebar/preview/menus
// carrying white text — the classic look), black grid text on grey, black
// selection bar, bright-blue hover (carries both text colors), red hairlines.
// Text roles are split by surface: `white` paints panels + selection + hover,
// `sidebarFg` paints the grid. Dark syntax is green/yellow/cyan/white on blue.
// Light: white canvas + grey sidebar + cyan selection bar carrying dark text
// + blue brand accents.
// Role constraints (verified against the widgets): `white`, `accent` AND
// `sidebarFg` all paint on `accentBg` (menus / sidebar rows / grid tiles),
// and `white` also paints on `hoverBg` (tab X, settings hover) and on
// `sidebarBg` (props titles) — so the selection bar must carry every text
// role at once.
export const ANSI16: string[] = [
  "#000000",
  "#aa0000",
  "#00aa00",
  "#aa5500",
  "#0000aa",
  "#aa00aa",
  "#00aaaa",
  "#aaaaaa",
  "#555555",
  "#ff5555",
  "#55ff55",
  "#ffff55",
  "#5555ff",
  "#ff55ff",
  "#55ffff",
  "#ffffff",
];

// Full Theme key set (10 chrome + 6 syntax + 16 ansi), kept as plain records
// so this leaf stays import-free. Selected-label text is `white` on
// `accentBg` (see ui-menu/ui-settings-panel) and `accent` never paints on top
// of `accentBg`, so accent==blue is never required — both palettes still keep
// every fill/text role pairwise distinct.
export const COMPAT_DARK_THEME: Record<string, string> = {
  bg: "#aaaaaa",
  sidebarBg: "#0000aa",
  sidebarFg: "#000000",
  sidebarFgMuted: "#555555",
  accent: "#ffffff",
  accentBg: "#000000",
  hoverBg: "#5555ff",
  border: "#aa0000",
  divider: "#aa0000",
  white: "#ffffff",
  syntaxString: "#55ff55",
  syntaxNumber: "#ffff55",
  syntaxType: "#55ffff",
  syntaxFunction: "#ffffff",
  syntaxOperator: "#aaaaaa",
  syntaxProperty: "#55ffff",
  ansi0: "#000000",
  ansi1: "#aa0000",
  ansi2: "#00aa00",
  ansi3: "#aa5500",
  ansi4: "#0000aa",
  ansi5: "#aa00aa",
  ansi6: "#00aaaa",
  ansi7: "#aaaaaa",
  ansi8: "#555555",
  ansi9: "#ff5555",
  ansi10: "#55ff55",
  ansi11: "#ffff55",
  ansi12: "#5555ff",
  ansi13: "#ff55ff",
  ansi14: "#55ffff",
  ansi15: "#ffffff",
};

export const COMPAT_LIGHT_THEME: Record<string, string> = {
  bg: "#ffffff",
  sidebarBg: "#aaaaaa",
  sidebarFg: "#000000",
  sidebarFgMuted: "#555555",
  accent: "#0000aa",
  accentBg: "#55ffff",
  hoverBg: "#555555",
  border: "#555555",
  divider: "#555555",
  white: "#000000",
  syntaxString: "#00aa00",
  syntaxNumber: "#aa5500",
  syntaxType: "#0000aa",
  syntaxFunction: "#aa0000",
  syntaxOperator: "#555555",
  syntaxProperty: "#00aaaa",
  ansi0: "#000000",
  ansi1: "#aa0000",
  ansi2: "#00aa00",
  ansi3: "#aa5500",
  ansi4: "#0000aa",
  ansi5: "#aa00aa",
  ansi6: "#00aaaa",
  ansi7: "#aaaaaa",
  ansi8: "#555555",
  ansi9: "#ff5555",
  ansi10: "#55ff55",
  ansi11: "#ffff55",
  ansi12: "#5555ff",
  ansi13: "#ff55ff",
  ansi14: "#55ffff",
  ansi15: "#ffffff",
};

const hexRgb = (hex: string): [number, number, number] | null => {
  const group = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())?.[1];
  if (group === undefined) return null;
  const n = Number.parseInt(group, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

export const isDark = (hex: string): boolean => {
  const rgb = hexRgb(hex);
  if (!rgb) return true;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5;
};

// Effective console palette: the user's [theme] hues are ignored, only the
// configured bg's brightness picks dark vs light. Returns a FRESH copy every
// call — callers Object.assign/spread it into live colors, never mutate the
// frozen consts. Generic over Record (not Theme) so this leaf stays
// import-free; idempotent by construction, so repeated applyConfig runs are
// stable.
export const compatStaticTheme = <T extends Record<string, string>>(userTheme: { bg?: string }): T =>
  ({ ...(isDark(userTheme.bg ?? "#000000") ? COMPAT_DARK_THEME : COMPAT_LIGHT_THEME) }) as T;

// ASCII fallbacks for the icon names glyphs.ts can emit. Console fonts carry
// the basic Latin set only, so every value here is < 0x80 by construction
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
