// --- compat-mode detection (linux console / dumb terminals) ---
// Pure leaf: TERM prefix decides, no fs/renderer. `auto` follows the terminal,
// `on`/`off` override it for weird ssh terms or patched console fonts.
import { describe, expect, test } from "bun:test";
import { ANSI16, asciiGlyphFor, compatTheme, isCompatTerm, nearestAnsi16, rasterSigOf, resolveCompat } from "./compat";

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

describe("nearestAnsi16", () => {
  test("primaries snap to their exact slot", () => {
    expect(nearestAnsi16("#000000")).toBe("#000000");
    expect(nearestAnsi16("#ffffff")).toBe("#ffffff");
    expect(nearestAnsi16("#ff0000")).toBe("#aa0000");
  });
  test("unparseable input comes back unchanged, never throws", () => {
    expect(nearestAnsi16("transparent")).toBe("transparent");
    expect(nearestAnsi16("")).toBe("");
  });
});

// tokyo-night-ish dark theme: bg/hover/accentBg are near-neighbours that all
// collapse to black on a 16-color console without role repair
const DARK = {
  bg: "#1a1b26",
  sidebarBg: "#16161e",
  sidebarFg: "#c0caf5",
  sidebarFgMuted: "#565f89",
  accent: "#7aa2f7",
  accentBg: "#283457",
  hoverBg: "#292e42",
  border: "#3b4261",
  divider: "#3b4261",
  white: "#ffffff",
  syntaxString: "#9ece6a",
  syntaxNumber: "#ff9e64",
};

const LIGHT = {
  bg: "#e1e2e7",
  sidebarBg: "#d0d3de",
  sidebarFg: "#3760bf",
  sidebarFgMuted: "#848cb5",
  accent: "#2e7de9",
  accentBg: "#2e7de9",
  hoverBg: "#c4c8da",
  border: "#b4b8d0",
  divider: "#b4b8d0",
  white: "#ffffff",
  syntaxString: "#587539",
  syntaxNumber: "#b15c00",
};

describe("compatTheme", () => {
  test("every emitted hex is a 16-color slot (the VT ignores 48;2 truecolor)", () => {
    for (const theme of [DARK, LIGHT]) {
      const out = compatTheme(theme);
      for (const v of Object.values(out)) expect(ANSI16).toContain(v);
    }
  });
  test("surface roles stay pairwise distinct so bg/hover/selected read apart", () => {
    for (const theme of [DARK, LIGHT]) {
      const out = compatTheme(theme);
      expect(out.bg).not.toBe(out.hoverBg);
      expect(out.bg).not.toBe(out.accentBg);
      expect(out.hoverBg).not.toBe(out.accentBg);
      expect(out.accent).not.toBe(out.accentBg); // selected label readable
      expect(out.sidebarFg).not.toBe(out.sidebarFgMuted);
    }
  });
  test("mapping is idempotent (applyConfig re-runs must be stable)", () => {
    expect(compatTheme(compatTheme(DARK))).toEqual(compatTheme(DARK));
    expect(compatTheme(compatTheme(LIGHT))).toEqual(compatTheme(LIGHT));
  });
  test("non-hex values pass through and the input is never mutated", () => {
    const src = { ...DARK, bg: "transparent" };
    const out = compatTheme(src);
    expect(out.bg).toBe("transparent");
    expect(src.bg).toBe("transparent");
    expect(DARK.bg).toBe("#1a1b26");
  });
});
