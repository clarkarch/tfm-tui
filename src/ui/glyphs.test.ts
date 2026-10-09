import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { FILE_ICON_BY_EXT } from "../fs/filetype";
import { ensureGlyphFallbacks, glyph, glyphFor } from "./glyphs";

// every raster asset must resolve in glyph mode (no SVG rasterizer) — either
// statically or via the filetype fallback that maps unknown categories to
// the generic file glyph. Pinned after the sort arrows shipped as SVGs with
// no table entry and the active sort column showed U+FFFD tofu.
describe("glyph coverage", () => {
  test("every assets/icons/*.svg name resolves after the boot fallback, never tofu", () => {
    ensureGlyphFallbacks(Object.values(FILE_ICON_BY_EXT));
    const svgs = readdirSync(path.join(import.meta.dir, "..", "..", "assets", "icons"))
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.slice(0, -4));
    expect(svgs.length).toBeGreaterThan(0);
    const missing = svgs.filter((n) => glyphFor(n) === "�");
    expect(missing).toEqual([]);
  });

  test("sort arrows are plain Unicode arrows, not PUA guesses", () => {
    expect(glyph["arrow-up"]).toBe("↑");
    expect(glyph["arrow-down"]).toBe("↓");
  });
});
