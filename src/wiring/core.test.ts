// --- Wiring-level pin for core.ts's CONSTRUCTION ORDER.
//
// The modal dim (applyModalDim) shades the icon rasters through
// `slots.setRasterDim`, and the floats layer calls it on every modal
// open/close. If the slot factory were built AFTER the floats layer, that
// call would sit in the TDZ — and the dim's try/catch swallows the
// ReferenceError, so the failure is a SILENT "the rasters stay bright behind
// the modal", not a crash. The order is invisible in the types (both are
// plain consts), so it is pinned structurally: the slot factory must be
// built first.
import { describe, expect, test } from "bun:test";

describe("core wiring construction order", () => {
  test("the slot factory is built BEFORE the floats layer", async () => {
    const src = (await Bun.file(`${import.meta.dir}/core.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const slots = src.indexOf("makeSlots(");
    const floats = src.indexOf("makeFloats(");
    expect(slots).toBeGreaterThan(-1);
    expect(floats).toBeGreaterThan(-1);
    expect(slots).toBeLessThan(floats);
  });
});
