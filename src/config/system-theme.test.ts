import { describe, expect, test } from "bun:test";
import { mixHex } from "./color";
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

  test("accent prefers palette blue, cursor is the fallback tail", () => {
    // user-directed preset kinship (accent==ansi4): palette blue beats even
    // a readable white cursor; cursor only wins when the blues are gone
    expect(deriveSystemTheme({ ...darkInput(), cursorColor: "#ffffff" }, "dark").accent).toBe("#7aa2f7");
    expect(deriveSystemTheme(darkInput(), "dark").accent).toBe("#7aa2f7");
    // without cursor AND blues, terminal fg carries it
    const noBlue = { ...darkInput(), cursorColor: null };
    noBlue.palette[4] = null;
    noBlue.palette[12] = null;
    expect(deriveSystemTheme(noBlue, "dark").accent).toBe("#c0caf5");
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
    // hover is a lighter touch than selection (neutral lift vs hue tint)
    expect(chan(t.hoverBg)[0]).toBeLessThanOrEqual(chan(t.accentBg)[0]);
    expect(t.hoverBg).not.toBe(t.accentBg);
  });

  test("syntax colors ride the palette by hue family", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    expect(t.syntaxString).toBe("#9ece6a"); // ansi2 green
    expect(t.syntaxNumber).toBe("#e0af68"); // ansi3 yellow
    expect(t.syntaxType).toBe("#7dcfff"); // ansi6 cyan
    expect(t.syntaxFunction).toBe("#7aa2f7"); // ansi4 blue
    expect(t.syntaxOperator).toBe("#bb9af7"); // ansi5 magenta
  });

  test("syntax property rides bright cyan, not base cyan (type/property split)", () => {
    // presets always distinguish type vs property; derive splits them
    // across the cyan family instead of collapsing both onto ansi6
    const palette = darkInput().palette.map((c, i) => (i === 14 ? "#5fd7ff" : c));
    const t = deriveSystemTheme({ ...darkInput(), palette }, "dark");
    expect(t.syntaxType).toBe("#7dcfff");
    expect(t.syntaxProperty).toBe("#5fd7ff");
  });

  test("a terminal that answered nothing derives absolute extremes, never preset hexes", () => {
    const t = deriveSystemTheme(
      { palette: new Array(16).fill(null), defaultForeground: null, defaultBackground: null, cursorColor: null },
      "dark",
    );
    // nothing pulled at all: the canvas is absolute black, text absolute white
    expect(t.bg).toBe("#000000");
    expect(t.white).toBe("#ffffff");
    expect(t.sidebarFg).toBe("#ffffff");
    expect(t.accent).toBe("#ffffff");
    // the 16-slot table still completes from the same extremes
    expect(t.ansi0).toBe(t.sidebarBg);
    expect(t.ansi8).toBe(t.sidebarFgMuted);
    for (const v of Object.values(t)) expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(contrastRatio(t.accent, t.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t.sidebarFgMuted, t.sidebarBg)).toBeGreaterThanOrEqual(2.5);
  });

  test("invalid hex entries are guessed from pulled colors, never leak through", () => {
    const input = darkInput();
    input.palette[2] = "not-a-color";
    const t = deriveSystemTheme({ ...input, defaultBackground: "junk" }, "dark");
    // ansi2 borrows its bright sibling ansi10 (same green in this fixture)
    expect(t.ansi2).toBe("#9ece6a");
    // junk bg falls back to the darkest pulled palette entry, not a preset
    expect(t.bg).toBe("#16161e");
  });

  test("bg/fg-only terminal guesses the whole table from two colors", () => {
    const t = deriveSystemTheme(
      {
        palette: new Array(16).fill(null),
        defaultForeground: "#c0caf5",
        defaultBackground: "#1a1b26",
        cursorColor: null,
      },
      "dark",
    );
    expect(t.bg).toBe("#1a1b26");
    expect(t.white).toBe("#c0caf5");
    // no hue anywhere in the answer: fills collapse onto bg-derived math,
    // and every syntax slot agrees with its ansi slot (same derivation)
    expect(t.syntaxString).toBe(t.ansi2);
    expect(t.syntaxFunction).toBe(t.ansi4);
    expect(t.syntaxProperty).toBe(t.ansi14);
    for (const v of Object.values(t)) expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("a missing bright borrows its base, a missing base borrows its bright", () => {
    const noBrights = { ...darkInput(), palette: darkInput().palette.map((c, i) => (i >= 8 ? null : c)) };
    const t = deriveSystemTheme(noBrights, "dark");
    expect(t.ansi10).toBe("#9ece6a"); // borrows ansi2
    expect(t.ansi12).toBe("#7aa2f7"); // borrows ansi4
    const noBases = { ...darkInput(), palette: darkInput().palette.map((c, i) => (i < 8 ? null : c)) };
    const u = deriveSystemTheme(noBases, "dark");
    expect(u.ansi2).toBe("#9ece6a"); // borrows ansi10
    expect(u.ansi4).toBe("#7aa2f7"); // borrows ansi12
  });

  test("a single-hue terminal tints fills with that hue, invents no other", () => {
    const palette = new Array(16).fill(null);
    palette[1] = "#ff0000";
    const t = deriveSystemTheme(
      { palette, defaultForeground: "#ffffff", defaultBackground: "#000000", cursorColor: null },
      "dark",
    );
    const chan = (hex: string): [number, number, number] => {
      const n = Number.parseInt(hex.slice(1), 16);
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    };
    const [r, , b] = chan(t.accentBg);
    expect(r).toBeGreaterThan(b);
  });

  test("a missing bg is picked from the pulled palette, mode-consistent", () => {
    const t = deriveSystemTheme({ ...darkInput(), defaultBackground: null }, "dark");
    // darkest pulled entry carries the dark canvas
    expect(t.bg).toBe("#16161e");
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
    expect(Object.keys(t).sort()).toEqual(
      [
        "bg",
        "sidebarBg",
        "sidebarFg",
        "sidebarFgMuted",
        "accent",
        "accentBg",
        "hoverBg",
        "border",
        "divider",
        "white",
        "syntaxString",
        "syntaxNumber",
        "syntaxType",
        "syntaxFunction",
        "syntaxOperator",
        "syntaxProperty",
        "ansi0",
        "ansi1",
        "ansi2",
        "ansi3",
        "ansi4",
        "ansi5",
        "ansi6",
        "ansi7",
        "ansi8",
        "ansi9",
        "ansi10",
        "ansi11",
        "ansi12",
        "ansi13",
        "ansi14",
        "ansi15",
      ].sort(),
    );
  });
});

describe("terminal selection + bright-blue completion", () => {
  test("readable highlightBackground is used verbatim as accentBg", () => {
    const t = deriveSystemTheme({ ...darkInput(), highlightBackground: "#283457" }, "dark");
    expect(t.accentBg).toBe("#283457");
  });

  test("unreadable highlightBackground falls back to the tint ladder", () => {
    const t = deriveSystemTheme({ ...darkInput(), highlightBackground: "#888888" }, "dark");
    expect(t.accentBg).not.toBe("#888888");
  });

  test("a readable-but-grey highlightBackground never steals selection from the hue", () => {
    // repro class: terminal reports a neutral selection (spread 0) that
    // READS on fg — readability alone must not paint it, or selection +
    // title chrome drains to grey while palette blue exists. Real hue
    // voices (tokyo's #283457, spread 47) still ride verbatim above.
    const t = deriveSystemTheme({ ...darkInput(), highlightBackground: "#3a3a4a" }, "dark");
    expect(t.accentBg).not.toBe("#3a3a4a");
    // falls back to the blue hue tint, not neutral grey
    const n = Number.parseInt(t.accentBg.slice(1), 16);
    expect(n & 0xff).toBeGreaterThan((n >> 16) & 0xff);
  });

  test("readable highlightForeground is preferred as accent", () => {
    const input = {
      ...darkInput(),
      cursorColor: null,
      highlightBackground: "#283457",
      highlightForeground: "#7dcfff",
    };
    const t = deriveSystemTheme(
      { ...input, palette: input.palette.map((c, i) => (i === 4 || i === 12 ? null : c)) },
      "dark",
    );
    expect(t.accent).toBe("#7dcfff");
  });

  test("muted keeps a readable ansi8 verbatim (terminal kinship)", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    expect(t.sidebarFgMuted).toBe("#565f89");
  });

  test("unreadable ansi8 falls back to dimmed pulled-white", () => {
    const palette = darkInput().palette.map((c, i) => (i === 8 ? "#333333" : c));
    const t = deriveSystemTheme({ ...darkInput(), palette }, "dark");
    expect(t.sidebarFgMuted).not.toBe("#333333");
    // on the fg→panel segment (channel tolerance: the ladder's 0.65-0.05k
    // float drift rounds ±1 vs literal-m math), reading on the panel but
    // dimmer than fg itself
    const fg = "#c0caf5";
    const dist = (a: string, b: string): number => {
      const n = (h: string): [number, number, number] => {
        const v = Number.parseInt(h.slice(1), 16);
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      };
      const [ar, ag, ab] = n(a);
      const [br, bg2, bb] = n(b);
      return Math.abs(ar - br) + Math.abs(ag - bg2) + Math.abs(ab - bb);
    };
    const seg = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65].map((m) => mixHex(fg, t.sidebarBg, m));
    expect(seg.some((s) => dist(s, t.sidebarFgMuted) <= 3)).toBe(true);
    expect(contrastRatio(t.sidebarFgMuted, t.sidebarBg)).toBeGreaterThanOrEqual(2.5);
    expect(contrastRatio(t.sidebarFgMuted, t.sidebarBg)).toBeLessThan(contrastRatio(fg, t.sidebarBg));
  });

  test("palette blue beats cursor (preset accent==ansi4 kinship)", () => {
    // user-directed: every preset's accent is its palette blue, not its
    // cursor — cursor drops to the fallback tail
    const t = deriveSystemTheme(darkInput(), "dark");
    expect(t.accent).toBe("#7aa2f7");
  });

  test("cursor beats highlightForeground when both read (cursor is theme identity)", () => {
    // highlight colors describe selection rendering in the terminal, not the
    // theme's identity — below the palette blues, the cursor is the accent
    // voice. Blues are nulled to pin the fallback order beneath them.
    const input = { ...darkInput(), cursorColor: "#ff9e64", highlightForeground: "#7dcfff" };
    input.palette[4] = null;
    input.palette[12] = null;
    const t = deriveSystemTheme(input, "dark");
    expect(t.accent).toBe("#ff9e64");
  });

  test("highlightForeground still serves when blues and cursor are gone", () => {
    const input = { ...darkInput(), cursorColor: null, highlightForeground: "#7dcfff" };
    input.palette[4] = null;
    input.palette[12] = null;
    const t = deriveSystemTheme(input, "dark");
    expect(t.accent).toBe("#7dcfff");
  });

  test("a grey highlightForeground never steals the title accent from palette blue", () => {
    // repro: many terminals report a grey/white highlightForeground
    // (selected text). It must not wash the sidebar title (accent on
    // sidebarBg) to grey while a readable palette blue exists.
    const t = deriveSystemTheme({ ...darkInput(), highlightForeground: "#888888" }, "dark");
    expect(t.accent).toBe("#7aa2f7");
    expect(contrastRatio(t.accent, t.sidebarBg)).toBeGreaterThanOrEqual(3);
  });

  test("bright blue anchors hue/accent when base blue and cursor are missing", () => {
    const input = { ...darkInput(), cursorColor: null };
    input.palette[4] = null;
    const brightBlue = input.palette[12] ?? "";
    const t = deriveSystemTheme(input, "dark");
    // palette[12] is the same blue family in this fixture — survives verbatim
    expect(t.accent).toBe(brightBlue);
  });
});

describe("sidebar follows the terminal panel", () => {
  test("tokyo terminal resolves its own panel (ansi0) verbatim", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    expect(t.sidebarBg).toBe("#16161e");
  });

  test("light-side panel resolves light-side (Nord-style direction)", () => {
    const palette = darkInput().palette.map((c, i) => (i === 0 ? "#3b4252" : c));
    const t = deriveSystemTheme({ ...darkInput(), defaultBackground: "#2e3440", palette }, "dark");
    expect(t.sidebarBg).toBe("#3b4252");
    expect(relLum(t.sidebarBg)).toBeGreaterThan(relLum(t.bg));
  });

  test("hueless terminal selects on its panel (Aura-style kinship)", () => {
    // no palette hue, no cursor, no highlight: nothing carries a hue, so the
    // selection sits on the panel instead of a grey tint invention
    const t = deriveSystemTheme(
      {
        palette: new Array(16).fill(null),
        defaultForeground: "#c0caf5",
        defaultBackground: "#1a1b26",
        cursorColor: null,
      },
      "dark",
    );
    expect(t.accentBg).toBe(t.sidebarBg);
  });

  test("far-off ansi0 falls back to the shade step, never verbatim", () => {
    const palette = darkInput().palette.map((c, i) => (i === 0 ? "#ff0000" : c));
    const t = deriveSystemTheme({ ...darkInput(), palette }, "dark");
    expect(t.sidebarBg).not.toBe("#ff0000");
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
  // every PRIMARY fg-on-bg pair the surface seam can paint (bar: 3).
  // Muted has its own test below at its own bar (2.5 — the codebase muted
  // standard: this suite's tail arg, the ansi8 fixtures, tokyo's own ~2.9):
  // accent on bg (titles) + on accentBg (selected icons), white on accentBg
  // (active menu rows, inputs, toast body — muted never paints on the
  // island, see toastLevelMeta), sidebarFg on hoverBg, bg-text on accent
  // (drag ghost label)
  const pairsOf = (t: ReturnType<typeof deriveSystemTheme>): Array<[string, string, string]> => [
    [t.accent, t.bg, "accent/bg"],
    [t.accent, t.accentBg, "accent/accentBg"],
    [t.white, t.accentBg, "white/accentBg"],
    [t.sidebarFg, t.hoverBg, "sidebarFg/hoverBg"],
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

  test("muted pairs read at the muted bar (2.5) on the panel", () => {
    // secondary text keeps the codebase muted standard, not the primary
    // bar — tokyo's own pair sits ~2.9 and three witnesses (the tail arg,
    // the ansi8 fixtures, the derived-panel math) agree on 2.5
    for (const [name, input] of fixtures) {
      const t = deriveSystemTheme(input, null);
      expect(contrastRatio(t.sidebarFgMuted, t.sidebarBg), `${name} muted/sidebarBg`).toBeGreaterThanOrEqual(2.5);
    }
  });

  test("sane palettes keep author values (no gratuitous swaps)", () => {
    const t = deriveSystemTheme(darkInput(), "dark");
    // palette blue is the accent (preset kinship beats cursor convention —
    // user-directed); everything else below verbatim too
    expect(t.accent).toBe("#7aa2f7");
    expect(t.white).toBe("#c0caf5");
    // muted keeps readable ansi8 verbatim (preset kinship — user-directed);
    // the dimmed-white ladder only serves terms whose ansi8 can't read
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

  test("divider equals border (every preset equates them)", () => {
    // user-directed preset parity: the old distinct-divider rule was a
    // system-theme invention — gen-themes emits divider=border for all
    // presets and Tokyo defaults agree. The 0.008 ring floor still keeps
    // rings off bg so dividers never vanish into the canvas.
    for (const [, input] of fixtures) {
      const t = deriveSystemTheme(input, null);
      expect(t.divider).toBe(t.border);
      expect(t.border).not.toBe(t.bg);
    }
  });

  test("selection islands never vanish into bg (toast/tiles stay visible)", () => {
    for (const [name, input] of fixtures) {
      const t = deriveSystemTheme(input, null);
      expect(t.accentBg, `${name} accentBg`).not.toBe(t.bg);
      expect(t.hoverBg, `${name} hoverBg`).not.toBe(t.bg);
    }
  });

  test("rings are dimmer than a tokyo whisper, barely noticeable", () => {
    // user-directed: outline rings stay barely visible, below tokyo's own
    // ~0.017 band. The floor keeps border≠bg so the divider math can't
    // converge; the cap can't apply to light terms — any visible tint on
    // near-white is a big move, and there is no light-tokyo reference;
    // degenerate grey terms excluded.
    for (const [name, input, mode, floor, cap] of [
      ["dark", darkInput(), "dark", 0.005, 0.015],
      ["light", { ...darkInput(), defaultForeground: "#333333", defaultBackground: "#fafafa" }, "light", 0.005, 0.3],
    ] as Array<[string, TerminalPaletteInput, "dark" | "light", number, number]>) {
      const t = deriveSystemTheme(input, mode);
      const gap = Math.abs(relLum(t.border) - relLum(t.bg));
      expect(gap, `${name} ring gap`).toBeGreaterThanOrEqual(floor);
      expect(gap, `${name} ring gap`).toBeLessThan(cap);
    }
  });

  test("dark fills step outward like tokyo (sidebar ≤ bg ≤ hover ≤ accent; ring barely above bg)", () => {
    // relationships, not values: sidebar dips below bg, hover/accent rise
    // toward the hue. The ring no longer caps the ladder — user-directed
    // dimmer rings sit just above bg, below the fills — so the ordering is
    // asserted in two parts plus ring-subtler-than-fills.
    const t = deriveSystemTheme(darkInput(), "dark");
    const lums = [t.sidebarBg, t.bg, t.hoverBg, t.accentBg, t.border].map(relLum);
    for (let i = 1; i < 4; i++) {
      expect(lums[i]).toBeGreaterThanOrEqual(lums[i - 1]! - 1e-9);
    }
    expect(lums[4]).toBeGreaterThanOrEqual(lums[1]! - 1e-9);
    expect(lums[4]).toBeLessThan(lums[3]!);
  });
});
