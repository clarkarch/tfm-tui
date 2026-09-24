import { describe, expect, test } from "bun:test";
import type { MaybeNode } from "../lib/node-like";
import {
  applySurface,
  btnSurface,
  chromeSurface,
  floatSurface,
  iconTransparent,
  islandSurface,
  rowSurface,
  sideInnerWidth,
  slotBg,
  tileSurface,
} from "./style";
import type { Theme } from "../config/config";
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

  test("slotBg: chrome rasters flatten onto the canvas bg under outline styles", () => {
    expect(slotBg("outline", theme, theme.sidebarBg)).toBe("#1a1b26");
    expect(slotBg("solid", theme, theme.sidebarBg)).toBe("#16161e");
  });

  test("slotBg: the float role keeps the float's own fill in every style", () => {
    // floats are painted in solid AND outline-partial (floatSurface), so the
    // chrome rule would bake a canvas-colored square into the dialog — the
    // props/notify icon-bg regression this role exists to prevent
    for (const style of ["solid", "outline", "outline-partial"] as const) {
      expect(slotBg(style, theme, theme.sidebarBg, "float")).toBe("#16161e");
      expect(slotBg(style, theme, theme.accentBg, "float")).toBe("#29a37a");
    }
    // the chrome role is untouched by the float branch
    expect(slotBg("outline-partial", theme, theme.sidebarBg, "chrome")).toBe("#1a1b26");
  });

  test("islandSurface: an always-filled float island never clears its rest fill", () => {
    // toasts keep accentBg in every ui-style, so their buttons stay filled at
    // rest unlike btnSurface's outline branch
    expect(islandSurface(theme, false, theme.accentBg)).toEqual({ backgroundColor: "#29a37a" });
    expect(islandSurface(theme, true, theme.accentBg)).toEqual({ backgroundColor: "#292e42" });
    expect(btnSurface("outline", theme, false, theme.accentBg)).toEqual({});
  });

  test("floatSurface: only pure outline floats border-only; solid + outline-partial fill", () => {
    // outline-partial = outline chrome, SOLID floats (readable over a live
    // grid / transparent terminal bg); solid + outline behavior is frozen
    expect(floatSurface("outline", theme, theme.sidebarBg)).toEqual({
      border: true,
      borderStyle: "rounded",
      borderColor: "#3b4261",
    });
    expect(floatSurface("solid", theme, theme.sidebarBg)).toEqual({ backgroundColor: "#16161e" });
    expect(floatSurface("outline-partial", theme, theme.sidebarBg)).toEqual({ backgroundColor: "#16161e" });
  });

  test("outline-partial matches outline on every background-chrome seam", () => {
    expect(sideInnerWidth("outline-partial", 28)).toBe(sideInnerWidth("outline", 28));
    expect(chromeSurface("outline-partial", theme, theme.sidebarBg)).toEqual(
      chromeSurface("outline", theme, theme.sidebarBg),
    );
    expect(tileSurface("outline-partial", theme, "rest")).toEqual(tileSurface("outline", theme, "rest"));
    expect(rowSurface("outline-partial", theme, "rest")).toEqual(rowSurface("outline", theme, "rest"));
    expect(btnSurface("outline-partial", theme, false)).toEqual(btnSurface("outline", theme, false));
    expect(slotBg("outline-partial", theme, theme.sidebarBg)).toBe(slotBg("outline", theme, theme.sidebarBg));
  });
});

describe("iconTransparent", () => {
  test("opaque never keeps alpha; transparent always does", () => {
    expect(iconTransparent("opaque", false)).toBe(false);
    expect(iconTransparent("opaque", true)).toBe(false);
    expect(iconTransparent("transparent", false)).toBe(true);
    expect(iconTransparent("transparent", true)).toBe(true);
  });

  test("transparent-partial flattens only inside floating layers", () => {
    expect(iconTransparent("transparent-partial", false)).toBe(true);
    expect(iconTransparent("transparent-partial", true)).toBe(false);
  });
});

describe("applySurface", () => {
  test("paints every provided option onto the node", () => {
    const node: Record<string, any> = {};
    applySurface(node as unknown as MaybeNode, chromeSurface("outline", theme, theme.sidebarBg));
    expect(node.backgroundColor).toBe("transparent");
    expect(node.border).toBe(true);
    expect(node.borderStyle).toBe("rounded");
    expect(node.borderColor).toBe("#3b4261");
  });

  test("a missing fill clears to transparent", () => {
    const node: Record<string, any> = { backgroundColor: "#ff0000" };
    applySurface(node as unknown as MaybeNode, tileSurface("outline", theme, "rest"));
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

  test("power-plug maps to the verified nerd-font codepoint (esc-menu Plugins entry)", () => {
    // U+F06A5 = md-power_plug in MesloLGLDZ Nerd Font Mono (checked via
    // fontTools getBestCmap — never guess codepoints, a wrong one renders
    // an unrelated glyph with no error)
    expect(glyphFor("power-plug")).toBe("\u{F06A5}");
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
