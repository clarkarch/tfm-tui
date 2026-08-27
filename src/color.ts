// Nudge a #rrggbb color up by one unit of blue so it can never byte-equal
// another swatch (kitty composites any cell whose bg equals the terminal's
// default background — an off-by-one avoids SGR 49 see-through gaps).
export const bumpHex = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  return `#${Math.min(0xffffff, n + 1).toString(16).padStart(6, "0")}`;
};
