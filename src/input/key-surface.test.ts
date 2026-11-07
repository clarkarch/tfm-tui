import { describe, expect, test } from "bun:test";
import { KEY_SURFACE_ORDER, resolveSurface, surfaceBelow, type KeySurface, type SurfaceReaders } from "./key-surface";

// The resolver is the ONE ordered table of keyboard surfaces: the keypress
// router and the command palette both ask it, so the two dispatchers can
// never drift apart.

const readersFor = (open: KeySurface): SurfaceReaders => {
  const readers = {} as Record<KeySurface, () => boolean>;
  for (const s of KEY_SURFACE_ORDER) readers[s] = () => s === open;
  return readers as SurfaceReaders;
};

describe("the key surface resolver", () => {
  test("the canonical order lists every surface exactly once", () => {
    expect(new Set(KEY_SURFACE_ORDER).size).toBe(KEY_SURFACE_ORDER.length);
    // the grid is always open — it is the fallback, so it comes last
    expect(KEY_SURFACE_ORDER[KEY_SURFACE_ORDER.length - 1]).toBe("grid");
  });

  test("it resolves the open surface", () => {
    for (const surface of KEY_SURFACE_ORDER) {
      expect(resolveSurface(readersFor(surface))).toBe(surface);
    }
  });

  test("the FIRST open surface in the order wins", () => {
    const readers = {} as Record<KeySurface, () => boolean>;
    for (const s of KEY_SURFACE_ORDER) readers[s] = () => s === "conflict" || s === "grid";
    // the conflict sits above the grid in the canonical order
    expect(resolveSurface(readers)).toBe("conflict");
  });

  test("beneath skips one surface and resolves the one below it", () => {
    const readers = {} as Record<KeySurface, () => boolean>;
    for (const s of KEY_SURFACE_ORDER) readers[s] = () => s === "pick" || s === "grid";
    expect(resolveSurface(readers)).toBe("pick");
    expect(resolveSurface(readers, { beneath: "pick" })).toBe("grid");
  });

  test("surfaceBelow reads the canonical order", () => {
    expect(surfaceBelow("grid", "pick")).toBe(true);
    expect(surfaceBelow("prompt", "pick")).toBe(false);
    expect(surfaceBelow("pick", "pick")).toBe(false);
  });
});
