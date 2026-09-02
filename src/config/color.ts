// Nudge a #rrggbb color up by one unit of blue so it can never byte-equal
// another swatch (kitty composites any cell whose bg equals the terminal's
// default background — an off-by-one avoids SGR 49 see-through gaps).
export const bumpHex = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  return `#${Math.min(0xffffff, n + 1)
    .toString(16)
    .padStart(6, "0")}`;
};

// Terminals with background_opacity (kitty etc.) composite only their DEFAULT
// background; OpenTUI leaves unpainted cells on SGR 49, so those go
// see-through. transparentBg=false forces an opaque UI by nudging bg one step
// so it can never byte-equal the terminal's default color; true keeps the
// theme faithful. The nudge is runtime-only — config stores RAW hex.
export const deriveColors = <T extends { bg: string }>(theme: T, transparentBg: boolean): T =>
  transparentBg ? { ...theme } : { ...theme, bg: bumpHex(theme.bg) };
