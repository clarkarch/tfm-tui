import { defaultConfig, type Theme } from "./config-schema";
import { mixHex, shadeHex } from "./color";

// --- System (terminal-adaptive) theme: build a tfm Theme out of the
// terminal's OWN colors (OSC 10/11 fg/bg + OSC 4 palette + cursor), so tfm
// melts into whatever theme the user runs. Pure leaf — the renderer query
// (getPalette/waitForThemeMode) lives in ui/ui-system-theme; this only maps. ---

export type TerminalThemeMode = "dark" | "light";

// the palette/query subset system-theme needs (mirrors @opentui/core's
// TerminalColors fields it reads — Hex = string | null)
export type TerminalPaletteInput = {
  palette: Array<string | null>;
  defaultForeground: string | null;
  defaultBackground: string | null;
  cursorColor: string | null;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// terminal replies are already #rrggbb or null; anything else is unusable
const usable = (v: string | null | undefined, fallback: string): string =>
  typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim() : fallback;

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000;
};

// same >128 split OpenTUI's own renderer-theme-mode uses to call light/dark
export const inferModeFromBg = (bg: string): TerminalThemeMode =>
  HEX_RE.test(bg.trim()) && luminance(bg.trim()) > 128 ? "light" : "dark";

// --- contrast guards: terminal palettes are arbitrary (solarized,
// low-contrast customs, cursor==bg), but the surface seam paints fixed
// fg-on-bg pairs (style.ts roles). These keep author values when readable
// and repair only the failing pairs — never invalid hex out. ---

// WCAG relative luminance (exported for relationship assertions in tests)
export const relLum = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 0xff) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff);
};

export const contrastRatio = (a: string, b: string): number => {
  if (!HEX_RE.test(a.trim()) || !HEX_RE.test(b.trim())) return 1;
  const [hi, lo] = [relLum(a.trim()), relLum(b.trim())].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

// first candidate readable on EVERY bg (>= minRatio), else the one with the
// best worst-case ratio — author order wins, so sane palettes keep their
// values and only failing pairs move
export const pickReadable = (candidates: string[], bgs: string[], minRatio = 3): string => {
  const valid = candidates.filter((c) => HEX_RE.test(c.trim())).map((c) => c.trim());
  // destructure once so the empties are handled by real guards (the tail below
  // always has a value to fall back to) instead of non-null assertions
  const [firstValid] = valid;
  if (firstValid === undefined) return candidates[0] ?? "#ffffff";
  const targets = bgs.filter((b) => HEX_RE.test(b.trim())).map((b) => b.trim());
  if (!targets.length) return firstValid;
  const worst = (c: string): number => Math.min(...targets.map((b) => contrastRatio(c, b)));
  return valid.find((c) => worst(c) >= minRatio) ?? valid.slice().sort((x, y) => worst(y) - worst(x))[0] ?? firstValid;
};

// push a bg-shade outward until fg reads on it (>= minRatio): preferred dir
// first (lighter on dark terminals, darker on light ones), then the opposite
// dir, then the strongest shade tried — fills stay close to bg when readable.
// Grey-only fallback for terminals whose hues can't carry a fill.
export const shadeUntil = (bg: string, fg: string, dir: 1 | -1, minRatio: number, start: number): string => {
  const ladder = (d: 1 | -1): string[] => {
    const out: string[] = [];
    for (let m = start; m <= 0.9 + 1e-9; m += 0.05) out.push(shadeHex(bg, d * m));
    return out;
  };
  for (const c of [...ladder(dir), ...ladder(dir === 1 ? -1 : 1)]) {
    if (contrastRatio(fg, c) >= minRatio) return c;
  }
  return shadeHex(bg, (dir === 1 ? -1 : 1) * 0.9);
};

// tint bg toward the terminal hue until fg reads on it: fills carry the
// theme's hue (blue selection in a blue terminal) instead of shadeHex's
// neutral grey. Amount grows only as far as readability demands; a hue that
// can't carry the fill (hue≈bg) falls back to the grey shadeUntil ladder.
export const tintUntil = (
  bg: string,
  hue: string,
  fg: string,
  dir: 1 | -1,
  minRatio: number,
  start: number,
): string => {
  const hueOk = HEX_RE.test(hue.trim());
  for (let m = start; m <= 0.9 + 1e-9; m += 0.05) {
    const c = hueOk ? mixHex(bg, hue.trim(), m) : shadeHex(bg, dir * m);
    if (contrastRatio(fg, c) >= minRatio) return c;
  }
  return shadeUntil(bg, fg, dir, minRatio, start);
};

// outline rings follow the tokyo philosophy: a whisper above bg, not a
// neon frame. Tokyo's own ring sits ~0.017 luminance over bg, so the floor
// here is 0.02 — visible against bg, muted everywhere else. The ladder only
// climbs past the start amount for terminals whose hues can't separate.
const ringUntil = (bg: string, hue: string, dir: 1 | -1, start: number): string => {
  if (!HEX_RE.test(bg.trim()) || !HEX_RE.test(hue.trim())) return shadeHex(bg, dir * 0.55);
  const base = relLum(bg.trim());
  for (let m = start; m <= 0.95 + 1e-9; m += 0.05) {
    const c = mixHex(bg, hue.trim(), m);
    if (Math.abs(relLum(c) - base) >= 0.02) return c;
  }
  return mixHex(bg, hue.trim(), 0.95);
};

export const deriveSystemTheme = (input: TerminalPaletteInput, mode: TerminalThemeMode | null): Theme => {
  const d = defaultConfig.theme;
  const bg = usable(input.defaultBackground, d.bg);
  const fg = usable(input.defaultForeground, d.white);
  const dark = (mode ?? inferModeFromBg(bg)) === "dark";
  const ansi = (i: number, fallback: string): string => usable(input.palette[i] ?? null, fallback);
  // sidebar is panel IDENTITY: always a step below bg (like the tokyo
  // default), never chased across sides for a ratio — pushing it lighter to
  // satisfy a dark muted produced a glowing grey panel in a dark theme
  // (verified live: kitty tokyo bg + dark ansi8). The TEXT adapts instead.
  const sidebarBg = shadeHex(bg, dark ? -0.35 : -0.12);
  // muted metadata adapts to the panel: ansi8, then terminal fg, then a
  // guaranteed extreme. Threshold 2.5, not 3 — even tokyo's own muted pair
  // sits ~2.9, so 3 would swap every sane palette's muted gratuitously.
  const muted = pickReadable(
    [ansi(8, ""), fg, dark ? "#ffffff" : "#000000", dark ? "#000000" : "#ffffff", d.sidebarFgMuted].filter(Boolean),
    [sidebarBg],
    2.5,
  );
  // hue anchor for fills + rings: palette blue first (the selection family
  // across most themes), then cursor, then the default theme's accent — the
  // anchor always comes from a theme, never a hardcoded hex, and never grey
  // by default, or the whole chrome drains to greyscale (verified live)
  const hue = usable(input.palette[4] ?? null, "") || usable(input.cursorColor, "") || d.accent;
  // selection/highlight fills step from bg toward the hue in tokyo-like
  // proportions (small moves: tokyo's accentBg is one step over bg) and grow
  // only until their text reads — a highlight must be visible, so moving it
  // (unlike the sidebar) is right
  const up = dark ? 1 : -1;
  const accentBg = tintUntil(bg, hue, fg, up, 3, 0.22);
  const hoverBg = tintUntil(bg, hue, fg, up, 3, 0.12);
  // accent must read on bg (titles, links) AND on accentBg (selected tile
  // text, selected sidebar icons/labels): cursor first, then palette blue,
  // then terminal fg, then a guaranteed extreme — author order wins
  const accent = pickReadable(
    [
      usable(input.cursorColor, ""),
      ansi(4, ""),
      fg,
      dark ? "#ffffff" : "#000000",
      dark ? "#000000" : "#ffffff",
      d.accent,
    ].filter(Boolean),
    [bg, accentBg],
  );
  // rings start as the smallest visible tint step, like tokyo's border
  const border = ringUntil(bg, hue, up, 0.25);
  // divider sits between ring and bg — structural, can never converge with
  // the border even when the tint ladder bottoms out (grey-on-grey terms)
  const divider = mixHex(border, bg, 0.4);
  return {
    bg,
    sidebarBg,
    sidebarFg: fg,
    sidebarFgMuted: muted,
    accent,
    accentBg,
    hoverBg,
    border,
    divider,
    white: fg,
    syntaxString: ansi(2, d.syntaxString),
    syntaxNumber: ansi(3, d.syntaxNumber),
    syntaxType: ansi(6, d.syntaxType),
    syntaxFunction: ansi(4, d.syntaxFunction),
    syntaxOperator: ansi(5, d.syntaxOperator),
    syntaxProperty: ansi(6, d.syntaxProperty),
    ansi0: ansi(0, d.ansi0),
    ansi1: ansi(1, d.ansi1),
    ansi2: ansi(2, d.ansi2),
    ansi3: ansi(3, d.ansi3),
    ansi4: ansi(4, d.ansi4),
    ansi5: ansi(5, d.ansi5),
    ansi6: ansi(6, d.ansi6),
    ansi7: ansi(7, d.ansi7),
    ansi8: ansi(8, d.ansi8),
    ansi9: ansi(9, d.ansi9),
    ansi10: ansi(10, d.ansi10),
    ansi11: ansi(11, d.ansi11),
    ansi12: ansi(12, d.ansi12),
    ansi13: ansi(13, d.ansi13),
    ansi14: ansi(14, d.ansi14),
    ansi15: ansi(15, d.ansi15),
  };
};
