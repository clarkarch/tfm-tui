import { describe, expect, test } from "bun:test";
import { clearIconCaches, iconPng, thumbPng } from "./icons";

// exercises the real rsvg-convert/magick pipeline (both are dev-machine deps);
// failures here mean the raster pipeline or its cache keys broke

describe("icons", () => {
  test("iconPng renders a PNG and serves the second request from cache", async () => {
    clearIconCaches();
    const a = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    expect(a.length).toBeGreaterThan(0);
    // PNG signature
    expect([a[0], a[1], a[2], a[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const b = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    expect(b).toBe(a); // same object = memory-cache hit
    clearIconCaches();
  });

  test("different tints/size produce distinct renders", async () => {
    clearIconCaches();
    const a = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    const b = await iconPng("folder", "#f7768e", "#1a1b26", 16, 16);
    expect(b).not.toBe(a);
    const c = await iconPng("folder", "#c0caf5", "#1a1b26", 32, 32);
    expect(c).not.toBe(a);
    clearIconCaches();
  });

  test("missing icon rejects", async () => {
    expect(iconPng("no-such-icon-xyz", "#ffffff", "#000000", 8, 8)).rejects.toThrow();
  });

  test("thumbPng rasterizes a file onto a bg", async () => {
    clearIconCaches();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>';
    const tmp = `/tmp/opencode/tfm-thumb-test-${process.pid}.svg`;
    await Bun.write(tmp, svg);
    const bytes = await thumbPng(tmp, 1, 1, 32, 32, "#1a1b26", true);
    expect(bytes.length).toBeGreaterThan(0);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const again = thumbPng(tmp, 1, 1, 32, 32, "#1a1b26", true);
    await expect(again).resolves.toBe(bytes); // memoized promise
    clearIconCaches();
  });
});
