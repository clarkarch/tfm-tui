import { describe, expect, test } from "bun:test";
import { bumpHex, deriveColors, mixHex, shadeHex } from "./color";

describe("bumpHex", () => {
  test("bumps blue channel by one", () => {
    expect(bumpHex("#1a1b26")).toBe("#1a1b27");
  });

  test("carries into green when blue overflows", () => {
    expect(bumpHex("#001fff")).toBe("#002000");
  });

  test("carries into red when green+blue overflow", () => {
    expect(bumpHex("#01ffff")).toBe("#020000");
  });

  test("saturates at white instead of overflowing", () => {
    expect(bumpHex("#ffffff")).toBe("#ffffff");
  });

  test("preserves zero padding", () => {
    expect(bumpHex("#000000")).toBe("#000001");
  });

  test("handles short hex form by parsing what slice gives it", () => {
    // "#abc" parses as 0xabc -> padded to 6 digits
    expect(bumpHex("#abc")).toBe("#000abd");
  });

  test("returns input unchanged when unparseable", () => {
    expect(bumpHex("#nothex")).toBe("#nothex");
    expect(bumpHex("#zzzzzz")).toBe("#zzzzzz");
    expect(bumpHex("")).toBe("");
  });

  test("quirk: treats everything after char 0 as hex, not just #rrggbb", () => {
    // "red".slice(1) === "ed" -> parseInt(_,16) === 237. Only ever fed
    // well-formed #rrggbb internally, but the guard is parseFloat-based.
    expect(bumpHex("red")).toBe("#0000ee");
  });
});

describe("shadeHex", () => {
  test("positive amt mixes toward white", () => {
    expect(shadeHex("#000000", 1)).toBe("#ffffff");
    expect(shadeHex("#1a1b26", 0.5)).toBe("#8d8d93");
  });

  test("negative amt mixes toward black", () => {
    expect(shadeHex("#ffffff", -1)).toBe("#000000");
    expect(shadeHex("#ffffff", -0.35)).toBe("#a6a6a6");
  });

  test("zero amt is identity, amt clamps to [-1, 1]", () => {
    expect(shadeHex("#1a1b26", 0)).toBe("#1a1b26");
    expect(shadeHex("#123456", 5)).toBe("#ffffff");
    expect(shadeHex("#123456", -5)).toBe("#000000");
  });

  test("unparseable input comes back unchanged", () => {
    expect(shadeHex("junk", 0.5)).toBe("junk");
    expect(shadeHex("#abc", 0.5)).toBe("#abc");
  });
});

describe("mixHex", () => {
  test("endpoints are identity", () => {
    expect(mixHex("#1a1b26", "#7aa2f7", 0)).toBe("#1a1b26");
    expect(mixHex("#1a1b26", "#7aa2f7", 1)).toBe("#7aa2f7");
  });

  test("midpoint blends per channel", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#1a1b26", "#7aa2f7", 0.35)).toBe("#3c4a6f");
  });

  test("t clamps to [0, 1]", () => {
    expect(mixHex("#000000", "#ffffff", 5)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", -2)).toBe("#000000");
  });

  test("unparseable side returns a unchanged", () => {
    expect(mixHex("junk", "#ffffff", 0.5)).toBe("junk");
    expect(mixHex("#000000", "junk", 0.5)).toBe("#000000");
  });
});

describe("deriveColors", () => {
  const theme = { bg: "#1a1b26", fg: "#c0caf5", accent: "#7aa2f7" };

  test("opaque mode (transparentBg=false) nudges bg so it can never equal the terminal default", () => {
    expect(deriveColors(theme, false).bg).toBe("#1a1b27");
  });

  test("transparent mode keeps the theme faithful", () => {
    expect(deriveColors(theme, true).bg).toBe("#1a1b26");
  });

  test("every other color survives the copy", () => {
    const c = deriveColors(theme, false);
    expect(c.fg).toBe("#c0caf5");
    expect(c.accent).toBe("#7aa2f7");
  });

  test("the source theme is never mutated (config stores RAW hex)", () => {
    deriveColors(theme, false);
    expect(theme.bg).toBe("#1a1b26");
  });

  test("the result is a fresh object, not the input", () => {
    expect(deriveColors(theme, true)).not.toBe(theme);
  });
});
