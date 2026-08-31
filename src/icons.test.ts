import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearIconCaches, iconPng, thumbPng } from "./icons";

// exercises the real rsvg-convert/magick pipeline (both are dev-machine deps);
// failures here mean the raster pipeline or its cache keys broke.
// The raster tests skip when the binaries are absent (CI runners, containers) —
// "missing icon rejects" stays live everywhere: it rejects at the asset read,
// before any binary is spawned.
const hasRsvg = Bun.which("rsvg-convert") !== null;
const hasMagick = Bun.which("magick") !== null;
const hasFfmpeg = Bun.which("ffmpeg") !== null;

describe("icons", () => {
  test.skipIf(!hasRsvg)("iconPng renders a PNG and serves the second request from cache", async () => {
    clearIconCaches();
    const a = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    expect(a.length).toBeGreaterThan(0);
    // PNG signature
    expect([a[0], a[1], a[2], a[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const b = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    expect(b).toBe(a); // same object = memory-cache hit
    clearIconCaches();
  });

  test.skipIf(!hasRsvg)("different tints/size produce distinct renders", async () => {
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

  test.skipIf(!hasMagick)("thumbPng rasterizes a file onto a bg", async () => {
    clearIconCaches();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>';
    const tmp = path.join(os.tmpdir(), `tfm-thumb-test-${process.pid}.svg`);
    await Bun.write(tmp, svg);
    const bytes = await thumbPng(tmp, 1, 1, 32, 32, "#1a1b26", true);
    expect(bytes.length).toBeGreaterThan(0);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const again = thumbPng(tmp, 1, 1, 32, 32, "#1a1b26", true);
    await expect(again).resolves.toBe(bytes); // memoized promise
    clearIconCaches();
  });

  test.skipIf(!hasRsvg)("vector thumbs render at the exact requested pixel size (rsvg path)", async () => {
    clearIconCaches();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>';
    const tmp = path.join(os.tmpdir(), `tfm-thumb-vec-${process.pid}.svg`);
    await Bun.write(tmp, svg);
    const bytes = await thumbPng(tmp, 2, 1, 64, 48, "#1a1b26", true);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(16)).toBe(64); // IHDR width
    expect(dv.getUint32(20)).toBe(48); // IHDR height
  });

  test.skipIf(!hasMagick && !hasRsvg)("thumb disk cache serves revisits after the memory layer drops", async () => {
    const prevCache = process.env.XDG_CACHE_HOME;
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-thumb-cache-"));
    process.env.XDG_CACHE_HOME = sandbox;
    try {
      clearIconCaches();
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>';
      const tmp = path.join(os.tmpdir(), `tfm-thumb-disk-${process.pid}.svg`);
      await Bun.write(tmp, svg);
      const a = await thumbPng(tmp, 3, 1, 32, 32, "#1a1b26", true);
      // write-behind — poll the sandbox for the cache file
      const thumbDir = path.join(sandbox, "tfm", "thumbs");
      let files: string[] = [];
      for (let i = 0; i < 100; i++) {
        files = existsSync(thumbDir) ? readdirSync(thumbDir) : [];
        if (files.length > 0) break;
        await Bun.sleep(5);
      }
      expect(files.length).toBe(1);
      clearIconCaches(); // drop the memory layer only
      const b = await thumbPng(tmp, 3, 1, 32, 32, "#1a1b26", true);
      expect(b).toEqual(a); // served from disk, byte-identical
    } finally {
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
      rmSync(sandbox, { recursive: true, force: true });
      clearIconCaches();
    }
  });

  test.skipIf(!hasFfmpeg)("video thumbs extract a frame at the requested size", async () => {
    clearIconCaches();
    const tmp = path.join(os.tmpdir(), `tfm-thumb-video-${process.pid}.mp4`);
    const gen = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=256x256:rate=10",
      "-pix_fmt",
      "yuv420p",
      "-y",
      tmp,
    ]);
    expect(gen.exitCode).toBe(0);
    const bytes = await thumbPng(tmp, 4, 1, 48, 64, "#1a1b26", false, true);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(16)).toBe(48); // IHDR width
    expect(dv.getUint32(20)).toBe(64); // IHDR height
  });
});
