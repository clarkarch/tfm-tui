// --- compat-mode detection (linux console / dumb terminals) ---
// Pure leaf: TERM prefix decides, no fs/renderer. `auto` follows the terminal,
// `on`/`off` override it for weird ssh terms or patched console fonts.
import { describe, expect, test } from "bun:test";
import {
  ANSI16,
  COMPAT_DARK_THEME,
  COMPAT_LIGHT_THEME,
  asciiGlyphFor,
  compatStaticTheme,
  isCompatTerm,
  rasterSigOf,
  resolveCompat,
} from "./compat";

describe("isCompatTerm", () => {
  test("linux console terms are compat", () => {
    expect(isCompatTerm("linux")).toBe(true);
    expect(isCompatTerm("linux-16color")).toBe(true);
  });
  test("dumb/vt terms are compat", () => {
    expect(isCompatTerm("dumb")).toBe(true);
    expect(isCompatTerm("vt220")).toBe(true);
    expect(isCompatTerm("vt100")).toBe(true);
  });
  test("modern terminals are not compat", () => {
    expect(isCompatTerm("xterm-256color")).toBe(false);
    expect(isCompatTerm("xterm-kitty")).toBe(false);
    expect(isCompatTerm("tmux-256color")).toBe(false);
    expect(isCompatTerm("")).toBe(false);
    expect(isCompatTerm(undefined)).toBe(false);
  });
});

describe("resolveCompat", () => {
  test("on/off override the terminal", () => {
    expect(resolveCompat("on", "xterm-kitty")).toBe(true);
    expect(resolveCompat("off", "linux")).toBe(false);
  });
  test("auto follows the terminal", () => {
    expect(resolveCompat("auto", "linux")).toBe(true);
    expect(resolveCompat("auto", "xterm-kitty")).toBe(false);
  });
  test("unknown mode strings fall back to auto behavior, never throw", () => {
    expect(resolveCompat("gibberish" as never, "linux")).toBe(true);
    expect(resolveCompat("gibberish" as never, "xterm-kitty")).toBe(false);
  });
});

describe("rasterSigOf", () => {
  test("any raster-affecting knob moves the signature", () => {
    const base = rasterSigOf("opaque", false, false);
    expect(rasterSigOf("transparent", false, false)).not.toBe(base);
    expect(rasterSigOf("opaque", true, false)).not.toBe(base);
    expect(rasterSigOf("opaque", false, true)).not.toBe(base);
    expect(rasterSigOf("opaque", false, false)).toBe(base);
  });
});

describe("asciiGlyphFor", () => {
  test("every result is plain ASCII (linux console has no Nerd PUA)", () => {
    for (const name of ["folder", "file", "home", "star", "trash-can", "search", "chevron-left", "no-such-icon"]) {
      const g = asciiGlyphFor(name);
      expect(g.length).toBeGreaterThan(0);
      for (const ch of g) expect(ch.charCodeAt(0)).toBeLessThan(128);
    }
  });
  test("folders and files are distinguishable", () => {
    expect(asciiGlyphFor("folder")).not.toBe(asciiGlyphFor("file"));
  });
});

describe("compat static themes", () => {
  test("every value is a 16-color slot (the VT ignores 48;2 truecolor)", () => {
    for (const theme of [COMPAT_DARK_THEME, COMPAT_LIGHT_THEME]) {
      for (const v of Object.values(theme as Record<string, string>)) expect(ANSI16).toContain(v);
    }
  });
  test("surface roles stay pairwise distinct so bg/hover/selected read apart", () => {
    for (const theme of [COMPAT_DARK_THEME, COMPAT_LIGHT_THEME]) {
      expect(theme.bg).not.toBe(theme.hoverBg);
      expect(theme.bg).not.toBe(theme.accentBg);
      expect(theme.hoverBg).not.toBe(theme.accentBg);
      expect(theme.accent).not.toBe(theme.accentBg);
      expect(theme.sidebarFg).not.toBe(theme.sidebarFgMuted);
      expect(theme.border).not.toBe(theme.bg);
      expect(theme.divider).not.toBe(theme.bg);
    }
  });
  test("dark: grey canvas, dark-blue panels, split text roles", () => {
    // classic look: black grid text on grey, white panel text on blue;
    // black selection bar, teal hover, red hairlines
    expect(COMPAT_DARK_THEME.bg).toBe("#aaaaaa");
    expect(COMPAT_DARK_THEME.sidebarBg).toBe("#0000aa");
    expect(COMPAT_DARK_THEME.sidebarFg).toBe("#000000");
    expect(COMPAT_DARK_THEME.white).toBe("#ffffff");
    expect(COMPAT_DARK_THEME.accentBg).toBe("#000000");
    expect(COMPAT_DARK_THEME.accent).toBe("#ffffff");
    expect(COMPAT_DARK_THEME.hoverBg).toBe("#5555ff"); // doubles as the rubber-band outline
    expect(COMPAT_DARK_THEME.border).toBe("#aa0000");
    expect(COMPAT_DARK_THEME.divider).toBe("#aa0000");
    for (const [k, v] of Object.entries(COMPAT_DARK_THEME as Record<string, string>)) {
      if (k.startsWith("ansi")) continue; // embedded-terminal palette stays verbatim
      expect([
        "#aaaaaa",
        "#0000aa",
        "#000000",
        "#ffffff",
        "#5555ff",
        "#aa0000",
        "#ffff55",
        "#55ff55",
        "#55ffff",
        "#555555",
      ]).toContain(v);
    }
    expect(COMPAT_LIGHT_THEME.bg).toBe("#ffffff");
    expect(COMPAT_LIGHT_THEME.accentBg).toBe("#55ffff");
    expect(COMPAT_LIGHT_THEME.accent).toBe("#0000aa");
    // white reads on the black selection bar (dark) / cyan bar (light)
    expect(COMPAT_DARK_THEME.white).toBe("#ffffff");
    expect(COMPAT_LIGHT_THEME.white).toBe(COMPAT_LIGHT_THEME.sidebarFg);
  });
  test("white panels separate from the grey canvas (both themes)", () => {
    expect(COMPAT_DARK_THEME.sidebarBg).not.toBe(COMPAT_DARK_THEME.bg);
    expect(COMPAT_DARK_THEME.accentBg).not.toBe(COMPAT_DARK_THEME.bg);
    expect(COMPAT_DARK_THEME.hoverBg).not.toBe(COMPAT_DARK_THEME.bg);
    expect(COMPAT_DARK_THEME.hoverBg).not.toBe(COMPAT_DARK_THEME.accentBg);
    expect(COMPAT_LIGHT_THEME.sidebarBg).not.toBe(COMPAT_LIGHT_THEME.bg);
  });
  test("both statics cover the same full key set (every Theme role)", () => {
    const darkKeys = Object.keys(COMPAT_DARK_THEME).sort();
    expect(darkKeys).toEqual(Object.keys(COMPAT_LIGHT_THEME).sort());
    expect(darkKeys.length).toBe(32); // 10 chrome + 6 syntax + 16 ansi
  });
  test("dark and light are different palettes", () => {
    expect(COMPAT_DARK_THEME.bg).not.toBe(COMPAT_LIGHT_THEME.bg);
    expect(COMPAT_DARK_THEME.bg).toBe("#aaaaaa");
    expect(COMPAT_LIGHT_THEME.bg).toBe("#ffffff");
  });
  test("syntax roles use distinct hues within each palette", () => {
    for (const theme of [COMPAT_DARK_THEME, COMPAT_LIGHT_THEME]) {
      const roles = [theme.syntaxString, theme.syntaxNumber, theme.syntaxType, theme.syntaxFunction];
      expect(new Set(roles).size).toBe(roles.length);
    }
  });
});

describe("compatStaticTheme", () => {
  test("dark user theme maps to the dark static (hues discarded, brightness kept)", () => {
    const out = compatStaticTheme({ bg: "#1a1b26" });
    expect(out).toEqual(COMPAT_DARK_THEME);
  });
  test("light user theme maps to the light static", () => {
    const out = compatStaticTheme({ bg: "#e1e2e7" });
    expect(out).toEqual(COMPAT_LIGHT_THEME);
  });
  test("unparseable bg falls back to dark (consoles are dark)", () => {
    expect(compatStaticTheme({ bg: "transparent" })).toEqual(COMPAT_DARK_THEME);
  });
  test("returns a fresh copy — callers can Object.assign without corrupting the const", () => {
    const out = compatStaticTheme({ bg: "#000000" });
    expect(out).not.toBe(COMPAT_DARK_THEME);
    out.bg = "#ffffff";
    expect(COMPAT_DARK_THEME.bg).toBe("#aaaaaa");
  });
});
