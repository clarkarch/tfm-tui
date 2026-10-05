import type { Theme } from "./config-schema";
import { mixHex, shadeHex } from "./color";

// --- System (terminal-adaptive) theme: build a tfm Theme out of the
// terminal's OWN colors (OSC 10/11 fg/bg + OSC 4 palette + cursor +
// highlight selection colors), so tfm melts into whatever theme the user
// runs. Pure leaf — the renderer query (getPalette/waitForThemeMode) lives
// in ui/ui-system-theme; this only maps. Terminal-only: every fill is
// derived from the pulled colors via shadeHex/mixHex math; missing entries
// are guessed from colors that DID arrive (darkest/lightest palette entry,
// base<->bright counterpart, most-saturated hue, bg-derived extremes) and
// the only literals are the absolute #000000/#ffffff last resort when the
// terminal answered nothing at all. No preset/theme defaults anywhere. ---

export type TerminalThemeMode = "dark" | "light";

// the palette/query subset system-theme needs (mirrors @opentui/core's
// TerminalColors fields it reads — Hex = string | null)
export type TerminalPaletteInput = {
  palette: Array<string | null>;
  defaultForeground: string | null;
  defaultBackground: string | null;
  cursorColor: string | null;
  highlightBackground?: string | null;
  highlightForeground?: string | null;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// terminal replies are already #rrggbb or null; anything else is unusable
const valid = (v: string | null | undefined): string | null =>
  typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim() : null;

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
  if (hi === undefined || lo === undefined) return 1;
  return (hi + 0.05) / (lo + 0.05);
};

// first candidate readable on EVERY bg (>= minRatio), else the one with the
// best worst-case ratio — author order wins, so sane palettes keep their
// values and only failing pairs move
export const pickReadable = (candidates: string[], bgs: string[], minRatio = 3): string => {
  const valids = candidates.filter((c) => HEX_RE.test(c.trim())).map((c) => c.trim());
  // destructure once so the empties are handled by real guards (the tail below
  // always has a value to fall back to) instead of non-null assertions
  const [firstValid] = valids;
  if (firstValid === undefined) return candidates[0] ?? "";
  const targets = bgs.filter((b) => HEX_RE.test(b.trim())).map((b) => b.trim());
  if (!targets.length) return firstValid;
  const worst = (c: string): number => Math.min(...targets.map((b) => contrastRatio(c, b)));
  return (
    valids.find((c) => worst(c) >= minRatio) ?? valids.slice().sort((x, y) => worst(y) - worst(x))[0] ?? firstValid
  );
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

// outline rings sit at the theme weight (tokyo's own ~0.017 band): the
// smallest mix step off bg reaching it. The floor keeps border≠bg so the
// divider math can't converge; the ladder only climbs past the start amount
// for terminals whose hues can't separate.
const ringUntil = (bg: string, hue: string, dir: 1 | -1, start: number): string => {
  if (!HEX_RE.test(bg.trim()) || !HEX_RE.test(hue.trim())) return shadeHex(bg, dir * 0.55);
  const base = relLum(bg.trim());
  for (let m = start; m <= 0.95 + 1e-9; m += 0.01) {
    const c = mixHex(bg, hue.trim(), m);
    if (Math.abs(relLum(c) - base) >= 0.012) return c;
  }
  return mixHex(bg, hue.trim(), 0.95);
};

// channel spread = cheap saturation: max-min over RGB. Grey/white paint sits
// near 0, tokyo's own selection #283457 spreads 47 — the gate below (24)
// admits real hue voices and rejects neutral terminal paint.
const channelSpread = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const chans = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return Math.max(...chans) - Math.min(...chans);
};

// most saturated pulled color, or null when the pool is all grey/nothing —
// saturation needs no color theory beyond max-min channel spread
const mostSaturated = (colors: string[]): string | null => {
  let best: string | null = null;
  let bestSat = 0;
  for (const c of colors) {
    const sat = channelSpread(c);
    if (sat > bestSat) {
      bestSat = sat;
      best = c;
    }
  }
  return best;
};

export const deriveSystemTheme = (input: TerminalPaletteInput, mode: TerminalThemeMode | null): Theme => {
  const at = (i: number): string | null => valid(input.palette[i] ?? null);
  const raw: Array<string | null> = Array.from({ length: 16 }, (_, i) => at(i));
  const pool = raw.filter((c): c is string => c !== null);
  const byLum = [...pool].sort((a, b) => luminance(a) - luminance(b));
  const darkest = byLum[0] ?? null;
  const lightest = byLum[byLum.length - 1] ?? null;

  const bgHit = valid(input.defaultBackground);
  const fgHit = valid(input.defaultForeground);
  // mode: explicit > bg brightness > fg inverse (bright fg implies a dark
  // room) > dark (terminals default dark)
  let dark = true;
  if (mode !== null) dark = mode === "dark";
  else if (bgHit !== null) dark = inferModeFromBg(bgHit) === "dark";
  else if (fgHit !== null) dark = luminance(fgHit) > 128;

  const up = dark ? 1 : -1;
  // bg: terminal bg verbatim; missing → darkest/lightest pulled entry so the
  // canvas still belongs to the terminal; nothing pulled → absolute extremes
  const bg = bgHit ?? (dark ? (darkest ?? "#000000") : (lightest ?? "#ffffff"));
  // fg: terminal fg verbatim; missing → opposite extreme from the pool (never
  // bg itself); nothing usable → absolute opposite of bg
  const otherEnd = dark ? lightest : darkest;
  const fg = fgHit ?? (otherEnd !== null && otherEnd !== bg ? otherEnd : dark ? "#ffffff" : "#000000");
  // readable extremes are shadeHex-derived steps around the terminal's own
  // bg — the guaranteed-readable tail of each chain below
  const hi = shadeHex(bg, 0.9);
  const lo = shadeHex(bg, -0.9);
  const extreme = dark ? hi : lo;
  const otherExtreme = dark ? lo : hi;
  // sidebar is panel IDENTITY: the terminal's own panel color (ansi0)
  // verbatim when it sits a panel-like step off bg in EITHER direction —
  // terminals run both darker and lighter panels, and the direction comes
  // from the terminal, never an assumption. Far-off ansi0 falls back to the
  // shade step; the TEXT adapts to the panel, never the reverse (pushing the
  // panel across sides for a ratio produced a glowing grey panel in a dark
  // theme — verified live: kitty tokyo bg + dark ansi8).
  const panel = at(0);
  // a shade of an already-extreme bg (black in dark mode) lands back on bg
  // itself — flip direction so the panel never vanishes into the canvas
  let sidebarBg =
    panel !== null && panel !== bg && Math.abs(relLum(panel) - relLum(bg)) <= 0.06
      ? panel
      : shadeHex(bg, dark ? -0.35 : -0.12);
  if (sidebarBg === bg) sidebarBg = shadeHex(bg, dark ? 0.35 : 0.12);
  // muted metadata: a readable terminal bright-black survives verbatim, else
  // the dimmed pulled-white ladder, else the bg-derived extremes. The bar is
  // 2.5 throughout: the codebase's muted standard — primary text keeps 3,
  // secondary keeps 2.5.
  const muteWhite = (): string | null => {
    for (let m = 0.65; m >= 0.25 - 1e-9; m -= 0.05) {
      const c = mixHex(fg, sidebarBg, m);
      if (contrastRatio(c, sidebarBg) >= 2.5) return c;
    }
    return null;
  };
  const raw8 = at(8);
  const muted =
    (raw8 !== null && contrastRatio(raw8, sidebarBg) >= 2.5 ? raw8 : null) ??
    muteWhite() ??
    pickReadable(
      [raw8, fg, extreme, otherExtreme].filter((c): c is string => c !== null),
      [sidebarBg],
      2.5,
    );
  // hue anchor for fills + rings: palette blue first, then bright blue, then
  // cursor, then the most saturated pulled color, then terminal fg — always a
  // terminal color, never grey by default, or the whole chrome drains to
  // greyscale (verified live)
  const hue = at(4) ?? at(12) ?? valid(input.cursorColor) ?? mostSaturated(pool) ?? fg;
  // selection fill steps from bg toward the hue and grows only until its text
  // reads — a highlight must be visible, so moving it (unlike the sidebar) is
  // right. The terminal's own selection bg wins when it reads as a real step
  // around bg (never bg itself — invisible) AND carries a hue: a grey/white
  // selection is neutral terminal paint, not an identity voice, and taking
  // it verbatim drained selection + title to grey while a palette hue
  // existed. Saturated selections (tokyo's own #283457) still ride verbatim.
  // NOTE: only primary text is required here — muted body copy was moved off
  // the island to white (toastLevelMeta), because one fill cannot serve both
  // bright and dim text (proved: the dual requirement drove accentBg darker
  // than bg itself).
  const hlBg = valid(input.highlightBackground ?? null);
  const hlBgHue = hlBg !== null && channelSpread(hlBg) >= 24 ? hlBg : null;
  // hueless terminals (no palette blues, no cursor, all-grey pool) carry no
  // hue family, so a hue tint would invent one — the selection sits on the
  // panel instead, provided primary text reads on it
  const hasTermHue = hue !== fg;
  const accentBg =
    hlBgHue !== null && hlBgHue !== bg && contrastRatio(fg, hlBgHue) >= 3
      ? hlBgHue
      : !hasTermHue && contrastRatio(fg, sidebarBg) >= 3
        ? sidebarBg
        : tintUntil(bg, hue, fg, up, 3, 0.18);
  // hover is a neutral lift toward fg (every hand-built theme builds it as a
  // small neutral step off bg), grown only until primary text reads on it
  const hoverBg = tintUntil(bg, fg, fg, up, 3, 0.1);
  // accent must read on bg (titles, links), on accentBg (selected tile text,
  // selected sidebar icons/labels) AND on sidebarBg (the sidebar title paints
  // accent-on-panel): palette blue first, then bright blue, then cursor, then
  // the terminal's highlighted text, then terminal fg, then bg-derived
  // extremes — author order wins. Highlight colors sit behind the palette on
  // purpose: they describe selection rendering in the terminal, not the
  // theme's identity, and a grey/white highlight first washed the whole
  // chrome (incl. the title) to grey while a readable palette blue existed.
  const accent = pickReadable(
    [
      at(4),
      at(12),
      valid(input.cursorColor),
      valid(input.highlightForeground ?? null),
      fg,
      extreme,
      otherExtreme,
    ].filter((c): c is string => c !== null),
    [bg, accentBg, sidebarBg],
  );
  // rings start as the smallest theme-weight tint step off bg
  const border = ringUntil(bg, hue, up, 0.05);
  // divider equals border — one ring color for all chrome dividers
  const divider = border;
  // complete the 16-slot table from pulled colors only: present entries ride
  // verbatim; a missing slot borrows its base<->bright sibling (same hue
  // family); ansi0 falls back to the panel, ansi8 to muted, anything left to
  // the hue anchor or a bg-derived extreme. The embedded terminal (OSC 4)
  // needs all 16, and every fallback here is terminal math.
  const ansi: string[] = [];
  for (let i = 0; i < 16; i++) {
    const sib = raw[i ^ 8] ?? null;
    ansi[i] = raw[i] ?? sib ?? (i === 0 ? sidebarBg : i === 8 ? muted : hue !== fg ? hue : extreme);
  }
  const slot = (i: number): string => ansi[i] ?? fg;
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
    syntaxString: slot(2),
    syntaxNumber: slot(3),
    syntaxType: slot(6),
    syntaxFunction: slot(4),
    syntaxOperator: slot(5),
    syntaxProperty: slot(14),
    ansi0: slot(0),
    ansi1: slot(1),
    ansi2: slot(2),
    ansi3: slot(3),
    ansi4: slot(4),
    ansi5: slot(5),
    ansi6: slot(6),
    ansi7: slot(7),
    ansi8: slot(8),
    ansi9: slot(9),
    ansi10: slot(10),
    ansi11: slot(11),
    ansi12: slot(12),
    ansi13: slot(13),
    ansi14: slot(14),
    ansi15: slot(15),
  };
};
