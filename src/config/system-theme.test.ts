import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config-schema";
import { contrastRatio, deriveSystemTheme, inferModeFromBg, relLum, type TerminalPaletteInput } from "./system-theme";

const hexes = (base: number): Array<string | null> =>
  Array.from({ length: 16 }, (_, i) => `#${(base + i).toString(16).padStart(6, "0")}`);

const darkInput = (): TerminalPaletteInput => ({
  palette: [
    "#16161e",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
    "#565f89",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
  ],
  defaultForeground: "#c0caf5",
  defaultBackground: "#1a1b26",
  cursorColor: "#ff9e64",
});

describe("deriveSystemTheme", () => {
  test("maps terminal bg/fg/ansi through verbatim (dark)", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    expect(t.bg).toBe("#1a1b26");
    expect(t.white).toBe("#c0caf5");
    expect(t.sidebarFg).toBe("#c0caf5");
    expect(t.ansi0).toBe("#16161e");
    expect(t.ansi4).toBe("#7aa2f7");
    expect(t.ansi15).toBe("#c0caf5");
  });

  test("accent prefers a readable cursor, else the most readable candidate", () => {
    // white cursor reads everywhere — survives verbatim
    expect(deriveSystemTheme({ ...darkInput(), cursorColor: "#ffffff" }, "dark").accent).toBe("#ffffff");
    // orange cursor scores ~4.3 on the blue-tinted selection fill (and high
    // on bg) — survives verbatim now that fills carry hue, not grey
    expect(deriveSystemTheme(darkInput(), "dark").accent).toBe("#ff9e64");
    // without a cursor, palette blue reads on bg and scores ~3.5 on the
    // blue-tinted selection fill — survives honestly
    expect(deriveSystemTheme({ ...darkInput(), cursorColor: null }, "dark").accent).toBe("#7aa2f7");
  });

  test("fills carry the terminal hue instead of draining to grey", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    const chan = (hex: string): [number, number, number] => {
      const n = Number.parseInt(hex.slice(1), 16);
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    };
    // tokyo hue is blue: every fill's blue channel leads its red
    for (const [label, c] of [
      ["accentBg", t.accentBg],
      ["hoverBg", t.hoverBg],
      ["border", t.border],
      ["divider", t.divider],
    ] as Array<[string, string]>) {
      const [r, , b] = chan(c);
      expect(b, label).toBeGreaterThan(r);
    }
    // hover is a lighter touch than selection (nested amounts)
    expect(chan(t.hoverBg)[0]).toBeLessThan(chan(t.accentBg)[0]);
  });

  test("syntax colors ride the palette by hue family", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    expect(t.syntaxString).toBe("#9ece6a"); // ansi2 green
    expect(t.syntaxNumber).toBe("#e0af68"); // ansi3 yellow
    expect(t.syntaxType).toBe("#7dcfff"); // ansi6 cyan
    expect(t.syntaxFunction).toBe("#7aa2f7"); // ansi4 blue
    expect(t.syntaxOperator).toBe("#bb9af7"); // ansi5 magenta
  });

  test("null palette entries fall back to the bundled defaults, never null", () => {
    const t = deriveSystemTheme(
      { palette: new Array(16).fill(null), defaultForeground: null, defaultBackground: null, cursorColor: null },
      "dark",
    );
    const d = defaultConfig.theme;
    expect(t.bg).toBe(d.bg);
    expect(t.white).toBe(d.white);
    // accent does NOT round-trip the fallback here: palette blue scores ~1.5
    // on accentBg (selected icons), so the guard honestly swaps to fg
    expect(t.accent).toBe(d.white);
    expect(t.ansi0).toBe(d.ansi0);
    expect(t.ansi15).toBe(d.ansi15);
    expect(t.syntaxString).toBe(d.syntaxString);
  });

  test("invalid hex entries fall back instead of leaking through", () => {
    const input = darkInput();
    input.palette[2] = "not-a-color";
    const t = deriveSystemTheme({ ...input, defaultBackground: "junk" }, "dark");
    expect(t.ansi2).toBe(defaultConfig.theme.ansi2);
    expect(t.bg).toBe(defaultConfig.theme.bg);
  });

  test("null mode is inferred from the background brightness", () => {
    expect(deriveSystemTheme(darkInput(), null).bg).toBe("#1a1b26");
    const light = deriveSystemTheme(
      { ...darkInput(), defaultBackground: "#ffffff", defaultForeground: "#333333" },
      null,
    );
    // light bg must shade the sidebar DOWN (darker), dark bg shades surfaces UP
    expect(light.bg).toBe("#ffffff");
    expect(light.sidebarBg).not.toBe("#ffffff");
  });

  test("derived surfaces stay distinct from bg in both modes", () => {
    const dark = deriveSystemTheme(darkInput(), "dark");
    expect(dark.sidebarBg).not.toBe(dark.bg);
    expect(dark.hoverBg).not.toBe(dark.bg);
    expect(dark.border).not.toBe(dark.bg);
    const light = deriveSystemTheme(
      {
        palette: hexes(0xeeeeee - 15),
        defaultForeground: "#333333",
        defaultBackground: "#fafafa",
        cursorColor: null,
      },
      "light",
    );
    expect(light.sidebarBg).not.toBe(light.bg);
    expect(light.hoverBg).not.toBe(light.bg);
  });

  test("result is a complete Theme with no nulls", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    for (const [k, v] of Object.entries(t)) {
      expect(typeof v, k).toBe("string");
      expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(Object.keys(t).sort()).toEqual(Object.keys(defaultConfig.theme).sort());
  });
});

describe("inferModeFromBg", () => {
  test("dark bg infers dark, light bg infers light", () => {
    expect(inferModeFromBg("#1a1b26")).toBe("dark");
    expect(inferModeFromBg("#fafafa")).toBe("light");
  });

  test("unparseable bg infers dark (terminals default dark)", () => {
    expect(inferModeFromBg("junk")).toBe("dark");
  });
});

describe("contrast guards", () => {
  // every fg-on-bg pair the surface seam can paint (style.ts roles):
  // accent on bg (titles) + on accentBg (selected icons), white on accentBg
  // (active menu rows, inputs), sidebarFg on hoverBg, muted on sidebarBg,
  // bg-text on accent (drag ghost label)
  const pairsOf = (t: ReturnType<typeof deriveSystemTheme>): Array<[string, string, string]> => [
    [t.accent, t.bg, "accent/bg"],
    [t.accent, t.accentBg, "accent/accentBg"],
    [t.white, t.accentBg, "white/accentBg"],
    [t.sidebarFg, t.hoverBg, "sidebarFg/hoverBg"],
    [t.sidebarFgMuted, t.sidebarBg, "muted/sidebarBg"],
    [t.bg, t.accent, "bg/accent"],
  ];
  const lowContrast: TerminalPaletteInput = {
    palette: new Array(16).fill("#888888"),
    defaultForeground: "#888888",
    defaultBackground: "#777777",
    cursorColor: "#777777", // == bg: must never survive as accent
  };
  const light: TerminalPaletteInput = {
    ...darkInput(),
    defaultForeground: "#333333",
    defaultBackground: "#fafafa",
    cursorColor: "#0066cc",
  };
  const fixtures: Array<[string, TerminalPaletteInput]> = [
    ["dark", darkInput()],
    ["light", light],
    ["low-contrast", lowContrast],
    [
      "all-null",
      {
        palette: new Array(16).fill(null),
        defaultForeground: null,
        defaultBackground: null,
        cursorColor: null,
      },
    ],
  ];

  test("every guarded pair meets ratio >= 3 across fixtures", () => {
    for (const [name, input] of fixtures) {
      const t = deriveSystemTheme(input, null);
      for (const [fg, bg, pair] of pairsOf(t)) {
        expect(contrastRatio(fg, bg), `${name} ${pair}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("sane palettes keep author values (no gratuitous swaps)", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    // orange cursor reads on bg and on the blue-tinted selection fill —
    // verbatim; everything else below verbatim too
    expect(t.accent).toBe("#ff9e64");
    expect(t.white).toBe("#c0caf5");
    expect(t.sidebarFgMuted).toBe("#565f89");
  });

  test("cursor matching bg is rejected as accent", () => {
    const t = deriveSystemTheme(lowContrast, null);
    expect(t.accent).not.toBe("#777777");
  });

  test("dark ansi8 never flips the sidebar light (verified live)", () => {
    // kitty tokyo bg + near-black bright-black: darkening the panel can never
    // reach ratio 3 for the muted text, and the old opposite-side fallback
    // answered with a glowing #98989d panel. The panel stays dark-side and
    // the TEXT moves instead.
    const lum = (hex: string): number => {
      const n = Number.parseInt(hex.slice(1), 16);
      return ((((n >> 16) & 0xff) * 299 + (((n >> 8) & 0xff) * 587 + (n & 0xff) * 114)) / 1000) | 0;
    };
    const t = deriveSystemTheme(
      { ...darkInput(), palette: darkInput().palette.map((c, i) => (i === 8 ? "#333333" : c)) },
      "dark",
    );
    expect(lum(t.sidebarBg)).toBeLessThanOrEqual(lum(t.bg));
    expect(contrastRatio(t.sidebarFgMuted, t.sidebarBg)).toBeGreaterThanOrEqual(2.5);
  });

  test("border and divider are distinct surfaces", () => {
    for (const [, input] of fixtures) {
      const t = deriveSystemTheme(input, null);
      expect(t.border).not.toBe(t.divider);
      expect(t.border).not.toBe(t.bg);
    }
  });

  test("rings are a tokyo-like whisper, not a neon frame", () => {
    // tokyo's own ring sits ~0.017 luminance over bg: visible, muted. The
    // derived ring must live in the same band on dark terms (the cap can't
    // apply to light terms — any visible tint on near-white is a big move,
    // and there is no light-tokyo reference; degenerate grey terms excluded).
    for (const [name, input, mode, cap] of [
      ["dark", darkInput(), "dark", 0.06],
      ["light", { ...darkInput(), defaultForeground: "#333333", defaultBackground: "#fafafa" }, "light", 0.3],
    ] as Array<[string, TerminalPaletteInput, "dark" | "light", number]>) {
      const t = deriveSystemTheme(input, mode);
      const gap = Math.abs(relLum(t.border) - relLum(t.bg));
      expect(gap, `${name} ring gap`).toBeGreaterThanOrEqual(0.015);
      expect(gap, `${name} ring gap`).toBeLessThan(cap);
    }
  });

  test("dark fills step outward like tokyo (sidebar ≤ bg ≤ hover ≤ accent ≤ ring)", () => {
    // relationships, not values: sidebar dips below bg, hover/accent rise
    // toward the hue, the ring caps the ladder — the tokyo ordering
    const t = deriveSystemTheme(darkInput(), "dark");
    const lums = [t.sidebarBg, t.bg, t.hoverBg, t.accentBg, t.border].map(relLum);
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i]).toBeGreaterThanOrEqual(lums[i - 1]! - 1e-9);
    }
  });
});
