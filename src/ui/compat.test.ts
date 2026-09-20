// --- compat-mode detection (linux console / dumb terminals) ---
// Pure leaf: TERM prefix decides, no fs/renderer. `auto` follows the terminal,
// `on`/`off` override it for weird ssh terms or patched console fonts.
import { describe, expect, test } from "bun:test";
import { asciiGlyphFor, isCompatTerm, resolveCompat } from "./compat";

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
