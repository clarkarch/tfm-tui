// --- compat mode: Linux console / dumb-terminal fallback ---
// Leaf (no imports from src): the console has neither kitty graphics nor the
// Nerd-Font PUA, so the kitty raster AND the Nerd glyph both miss. Compat
// forces list view + ASCII glyphs + no rasters/thumbs (wired in wiring/core +
// wiring/grid + wiring/chrome + ui-retheme); text-cell anims stay enabled
// (they need no graphics protocol). Palette is snapped to ANSI16 below: the
// VT ignores 48;2 truecolor, so unquantized theme hexes collapse into one
// cell. This module decides WHEN (TERM prefix) and renders WHAT (ASCII +
// palette).
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

// --- 16-color console palette ---
// OpenTUI emits 48;2/38;2 truecolor unconditionally (ansi.ts), which the Linux
// VT ignores — subtle theme shades collapse into one cell and bg/hover look
// dead. In compat mode every emitted hex is snapped to the classic VGA 16 so
// fills survive; surface roles are then REPAIRED pairwise distinct (a plain
// nearest-neighbor maps bg/hoverBg/accentBg all to black on dark themes).
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

const hexRgb = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

export const nearestAnsi16 = (hex: string): string => {
  const rgb = hexRgb(hex);
  if (!rgb) return hex;
  let best: string = ANSI16[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const slot of ANSI16) {
    const s = hexRgb(slot)!;
    const d = (rgb[0] - s[0]) ** 2 + (rgb[1] - s[1]) ** 2 + (rgb[2] - s[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = slot;
    }
  }
  return best;
};

const isDark = (hex: string): boolean => {
  const rgb = hexRgb(hex);
  if (!rgb) return true;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5;
};

// Snap a whole theme to ANSI16 with the surface roles repaired distinct.
// Generic over Record (not Theme) so this leaf stays import-free; idempotent
// (slots map to themselves) so repeated applyConfig runs are stable.
export const compatTheme = <T extends Record<string, string>>(theme: T): T => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme)) out[k] = nearestAnsi16(v);
  const dark = isDark(theme.bg ?? "#000000");
  const dim = dark ? "#555555" : "#aaaaaa";
  if (out.hoverBg === out.bg) out.hoverBg = dim;
  if (out.sidebarBg === out.bg) out.sidebarBg = dim;
  if (out.accentBg === out.bg || out.accentBg === out.hoverBg || out.accentBg === out.sidebarBg) {
    out.accentBg = out.bg === "#0000aa" || out.hoverBg === "#0000aa" ? "#aa00aa" : "#0000aa";
  }
  // selected-label fg must read on the (now blue/magenta) accentBg
  if (out.accent === out.accentBg) out.accent = "#ffff55";
  if (out.sidebarFgMuted === out.sidebarFg) out.sidebarFgMuted = dim;
  if (out.border === out.bg) out.border = dim;
  if (out.divider === out.bg) out.divider = dim;
  return out as T;
};

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
