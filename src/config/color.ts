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

// Mix a #rrggbb color toward black (amt < 0) or white (amt > 0) by amt
// (-1..1, clamped). Unparseable input comes back unchanged — callers use it
// for derived surfaces (sidebar/hover/border) that must never be invalid hex.
export const shadeHex = (hex: string, amt: number): string => {
  // the capture is read through `?.[1]` and guarded rather than asserted: a
  // failed match and a missing group are the same "not a color" outcome
  const group = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())?.[1];
  if (group === undefined) return hex;
  const n = Number.parseInt(group, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const t = amt < 0 ? 0 : 255;
  const p = Math.min(1, Math.max(0, Math.abs(amt)));
  const mix = (c: number): number => Math.round(c + (t - c) * p);
  const out = (mix(r) << 16) | (mix(g) << 8) | mix(b);
  return `#${out.toString(16).padStart(6, "0")}`;
};
// Mix two #rrggbb colors by t (0 = a, 1 = b, clamped). Either side
// unparseable → a unchanged. Used for hue-carrying fills (selection,
// hover, rings): mixing bg toward the terminal accent keeps the theme's
// hue instead of shadeHex's neutral grey.
export const mixHex = (a: string, b: string, t: number): string => {
  const ga = /^#([0-9a-fA-F]{6})$/.exec(a.trim())?.[1];
  const gb = /^#([0-9a-fA-F]{6})$/.exec(b.trim())?.[1];
  if (ga === undefined || gb === undefined) return a;
  const na = Number.parseInt(ga, 16);
  const nb = Number.parseInt(gb, 16);
  const p = Math.min(1, Math.max(0, t));
  const mix = (ca: number, cb: number): number => Math.round(ca + (cb - ca) * p);
  const out =
    (mix((na >> 16) & 0xff, (nb >> 16) & 0xff) << 16) |
    (mix((na >> 8) & 0xff, (nb >> 8) & 0xff) << 8) |
    mix(na & 0xff, nb & 0xff);
  return `#${out.toString(16).padStart(6, "0")}`;
};
// Terminals with background_opacity (kitty etc.) composite only their DEFAULT
// background; OpenTUI leaves unpainted cells on SGR 49, so those go
// see-through. transparentBg=false forces an opaque UI by nudging bg one step
// so it can never byte-equal the terminal's default color; true keeps the
// theme faithful. The nudge is runtime-only — config stores RAW hex.
export const deriveColors = <T extends { bg: string }>(theme: T, transparentBg: boolean): T =>
  transparentBg ? { ...theme } : { ...theme, bg: bumpHex(theme.bg) };
