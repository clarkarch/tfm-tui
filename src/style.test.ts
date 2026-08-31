import { describe, expect, test } from "bun:test";
import { applySurface, btnSurface, chromeSurface, rowSurface, sideInnerWidth, slotBg, tileSurface } from "./style";
import type { Theme } from "./config";
import { glyph, ensureGlyphFallbacks, glyphFor } from "./glyphs";

const theme = {
  bg: "#1a1b26",
  sidebarBg: "#16161e",
  hoverBg: "#292e42",
  accentBg: "#29a37a",
  border: "#3b4261",
} as unknown as Theme;

describe("sideInnerWidth", () => {
  test("solid mode gives children the full sidebar width", () => {
    expect(sideInnerWidth("solid", 28)).toBe(28);
  });

  test("outline mode loses one cell per side to the border ring", () => {
    expect(sideInnerWidth("outline", 28)).toBe(26);
  });
});

describe("surface builders", () => {
  test("chromeSurface: solid fills, outline draws a rounded border", () => {
    expect(chromeSurface("solid", theme, theme.sidebarBg)).toEqual({ backgroundColor: "#16161e" });
    expect(chromeSurface("outline", theme, theme.sidebarBg)).toEqual({
      border: true,
      borderStyle: "rounded",
      borderColor: "#3b4261",
    });
  });

  test("tileSurface: outline rest is bare, interaction states keep fills", () => {
    expect(tileSurface("outline", theme, "rest")).toEqual({});
    expect(tileSurface("outline", theme, "hover")).toEqual({ backgroundColor: "#292e42" });
    expect(tileSurface("outline", theme, "selected")).toEqual({ backgroundColor: "#29a37a" });
    expect(tileSurface("solid", theme, "rest")).toEqual({ backgroundColor: "#1a1b26" });
  });

  test("rowSurface: outline rest loses the fill only", () => {
    expect(rowSurface("outline", theme, "rest")).toEqual({});
    expect(rowSurface("outline", theme, "selected")).toEqual({ backgroundColor: "#29a37a" });
    expect(rowSurface("solid", theme, "rest")).toEqual({ backgroundColor: "#16161e" });
  });

  test("btnSurface: outline hovers only when hovered; rest bg honored", () => {
    expect(btnSurface("outline", theme, false)).toEqual({});
    expect(btnSurface("outline", theme, true)).toEqual({ backgroundColor: "#292e42" });
    expect(btnSurface("solid", theme, false, "#16161e")).toEqual({ backgroundColor: "#16161e" });
    expect(btnSurface("solid", theme, false)).toEqual({ backgroundColor: "#1a1b26" });
  });

  test("slotBg: outline rasters flatten onto the canvas bg, not the panel bg", () => {
    expect(slotBg("outline", theme, theme.sidebarBg)).toBe("#1a1b26");
    expect(slotBg("solid", theme, theme.sidebarBg)).toBe("#16161e");
  });
});

describe("applySurface", () => {
  test("paints every provided option onto the node", () => {
    const node: Record<string, any> = {};
    applySurface(node, chromeSurface("outline", theme, theme.sidebarBg));
    expect(node.backgroundColor).toBe("transparent");
    expect(node.border).toBe(true);
    expect(node.borderStyle).toBe("rounded");
    expect(node.borderColor).toBe("#3b4261");
  });

  test("a missing fill clears to transparent", () => {
    const node: Record<string, any> = { backgroundColor: "#ff0000" };
    applySurface(node, tileSurface("outline", theme, "rest"));
    expect(node.backgroundColor).toBe("transparent");
  });

  test("null node is a no-op", () => {
    expect(() => applySurface(null, { backgroundColor: "#000" })).not.toThrow();
  });

  test("throwing setters are swallowed (proxied VNodes no-op)", () => {
    const hostile: any = {};
    Object.defineProperty(hostile, "backgroundColor", {
      set() {
        throw new Error("nope");
      },
    });
    expect(() => applySurface(hostile, { backgroundColor: "#000", border: true })).not.toThrow();
  });
});

describe("glyph fallbacks", () => {
  test("glyphFor returns the mapped glyph or the replacement char", () => {
    expect(glyphFor("folder")).toBe("\u{F024B}");
    expect(glyphFor("definitely-not-a-glyph")).toBe("\u{FFFD}");
  });

  test("ensureGlyphFallbacks fills unknown categories with the file glyph", () => {
    ensureGlyphFallbacks(["zz-test-category"]);
    expect(glyph["zz-test-category"]).toBe(glyph.file);
  });

  test("existing entries are never overwritten", () => {
    const before = glyph.folder;
    ensureGlyphFallbacks(["folder"]);
    expect(glyph.folder).toBe(before);
  });
});
