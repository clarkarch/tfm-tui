import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { inflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import {
  THUMB_COOL_MS,
  clearIconCaches,
  iconCacheKey,
  iconPng,
  loadEmbeddedIcons,
  lruGet,
  lruSet,
  pickSvgRenderer,
  svgSourceMtime,
  thumbCooloffMs,
  thumbPng,
} from "./icons";

// exercises the real resvg/rsvg-convert/magick pipeline (dev-machine deps);
// failures here mean the raster pipeline or its cache keys broke.
// Icon and vector-thumb tests need an SVG rasterizer (resvg preferred, else
// rsvg-convert — one at a time, see icons.ts); raster tests need magick.
// They skip when the binaries are absent (CI runners, containers) — "missing
// icon rejects" stays live everywhere: with no renderer installed rasterizeSvg
// throws at the renderer check before reading the asset, and the missing asset
// throws at the read on a machine that has one.
const hasResvg = Bun.which("resvg") !== null;
const hasSvgRenderer = hasResvg || Bun.which("rsvg-convert") !== null;
const hasMagick = Bun.which("magick") !== null;
const hasFfmpeg = Bun.which("ffmpeg") !== null;

// sandbox the disk cache for the WHOLE file: iconPng/thumbPng read the real
// ~/.cache/tfm before rasterizing, so an app-populated disk hit could make
// the raster tests pass with a broken pipeline ("green suite lies") — and
// the write-behind would leak test PNGs into the real cache. The disk-cache
// test below keeps its own finer sandbox; this only guarantees isolation.
const CACHE_SANDBOX = mkdtempSync(path.join(os.tmpdir(), "tfm-icons-cache-"));
const REAL_CACHE_HOME = process.env.XDG_CACHE_HOME;
beforeAll(() => {
  process.env.XDG_CACHE_HOME = CACHE_SANDBOX;
});
afterAll(() => {
  if (REAL_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = REAL_CACHE_HOME;
  rmSync(CACHE_SANDBOX, { recursive: true, force: true });
});

describe("icons", () => {
  test.skipIf(!hasSvgRenderer)("iconPng renders a PNG and serves the second request from cache", async () => {
    clearIconCaches();
    const a = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    expect(a.length).toBeGreaterThan(0);
    // PNG signature
    expect([a[0], a[1], a[2], a[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const b = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    expect(b).toBe(a); // same object = memory-cache hit
    clearIconCaches();
  });

  test.skipIf(!hasSvgRenderer)("power-plug asset rasterizes (esc-menu Plugins entry icon)", async () => {
    clearIconCaches();
    const bytes = await iconPng("power-plug", "#c0caf5", "#1a1b26", 16, 16);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    clearIconCaches();
  });

  test.skipIf(!hasSvgRenderer)("different tints/size produce distinct renders", async () => {
    clearIconCaches();
    const a = await iconPng("folder", "#c0caf5", "#1a1b26", 16, 16);
    const b = await iconPng("folder", "#f7768e", "#1a1b26", 16, 16);
    expect(b).not.toBe(a);
    const c = await iconPng("folder", "#c0caf5", "#1a1b26", 32, 32);
    expect(c).not.toBe(a);
    clearIconCaches();
  });

  test.skipIf(!hasResvg)("prefers resvg: non-square requests keep aspect (fit-inside)", async () => {
    clearIconCaches();
    // resvg CLI `-w`+`-h` fits inside (aspect-preserving): the square 24x24
    // folder glyph in an 18x16 box shrinks to 16x16. rsvg-convert instead
    // stretches to exactly 18x16, so this pins that resvg is the one running.
    const bytes = await iconPng("folder", "#c0caf5", "#1a1b26", 18, 16);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(16)).toBe(16); // IHDR width
    expect(dv.getUint32(20)).toBe(16); // IHDR height
    clearIconCaches();
  });

  test("renderer precedence: resvg wins, rsvg-convert is the fallback, none is null", () => {
    expect(pickSvgRenderer(true, true)).toBe("resvg");
    expect(pickSvgRenderer(true, false)).toBe("resvg");
    expect(pickSvgRenderer(false, true)).toBe("rsvg-convert");
    expect(pickSvgRenderer(false, false)).toBe(null);
  });

  test("missing icon rejects", async () => {
    expect(iconPng("no-such-icon-xyz", "#ffffff", "#000000", 8, 8)).rejects.toThrow();
  });

  test("transparent cache keys ignore bg but differ from flattened keys", () => {
    const t1 = iconCacheKey("folder", "#fff", "#111111", 16, 16, 1000, true);
    const t2 = iconCacheKey("folder", "#fff", "#222222", 16, 16, 1000, true);
    expect(t1).toBe(t2); // bg-insensitive: one raster serves every tile state
    expect(t1).not.toBe(iconCacheKey("folder", "#fff", "#111111", 16, 16, 1000));
    expect(t1).not.toBe(iconCacheKey("folder", "#fff", "#111111", 16, 16, 1000, false));
  });

  test.skipIf(!hasSvgRenderer)("transparent iconPng keeps alpha; flattened iconPng is fully opaque", async () => {
    clearIconCaches();
    // the folder glyph never fills the whole canvas: skipping the bg flatten
    // must leave transparent pixels, flattening must leave none
    const bytes = await iconPng("folder", "#c0caf5", "#1a1b26", 32, 32, { transparent: true });
    expect(pngAlphaMin(bytes)).toBe(0);
    clearIconCaches();
    const flat = await iconPng("folder", "#c0caf5", "#1a1b26", 32, 32);
    expect(pngAlphaMin(flat)).toBe(255);
    clearIconCaches();
  });

  test.skipIf(!hasSvgRenderer)("transparent iconPng serves every bg from one raster", async () => {
    clearIconCaches();
    const a = await iconPng("folder", "#c0caf5", "#111111", 16, 16, { transparent: true });
    const b = await iconPng("folder", "#c0caf5", "#222222", 16, 16, { transparent: true });
    expect(b).toBe(a); // same object = memory-cache hit across bgs
    clearIconCaches();
  });

  test("icon cache key includes the SVG source version (edited assets re-raster)", () => {
    const a = iconCacheKey("disc", "#fff", "#000", 16, 16, 1000);
    expect(iconCacheKey("disc", "#fff", "#000", 16, 16, 1000)).toBe(a); // deterministic
    expect(iconCacheKey("disc", "#fff", "#000", 16, 16, 2000)).not.toBe(a); // source edit misses
    expect(iconCacheKey("disc", "#fff", "#000", 16, 16, 1000)).not.toBe(
      iconCacheKey("folder", "#fff", "#000", 16, 16, 1000),
    );
  });

  test("svgSourceMtime tracks a real asset, degrades to 0 when absent (compiled binary)", () => {
    const m = svgSourceMtime("folder");
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeGreaterThan(0);
    expect(svgSourceMtime("no-such-icon-xyz")).toBe(0);
  });

  test("embedded index reads Blob entries by name (compiled binary: Blobs, not Files)", async () => {
    // Bun.embeddedFiles in a --compile binary are plain Blobs carrying .name
    // (no File instances) — the index must not require instanceof File
    const fake = [
      { name: "disc-abcdef12.svg", text: async () => "<svg>DISC</svg>" },
      { name: "not-an-icon.txt", text: async () => "junk" },
      { text: async () => "nameless" },
    ];
    const map = await loadEmbeddedIcons(fake);
    expect(map.get("disc")).toBe("<svg>DISC</svg>");
    expect(map.size).toBe(1);
  });

  test("one unreadable embedded blob skips itself, the rest of the index still loads", async () => {
    // the try/catch used to wrap the WHOLE loop: a single f.text() failure
    // aborted the index and every later icon fell back to a glyph forever
    const fake = [
      { name: "folder-abcdef12.svg", text: async () => "<svg>FOLDER</svg>" },
      { name: "disc-abcdef12.svg", text: async () => Promise.reject(new Error("corrupt blob")) },
      { name: "file-abcdef12.svg", text: async () => "<svg>FILE</svg>" },
    ];
    const map = await loadEmbeddedIcons(fake);
    expect(map.get("folder")).toBe("<svg>FOLDER</svg>");
    expect(map.get("file")).toBe("<svg>FILE</svg>");
    expect(map.has("disc")).toBe(false);
  });

  test.skipIf(!hasMagick && !hasSvgRenderer)("thumbPng rasterizes a file onto a bg", async () => {
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

  test.skipIf(!hasSvgRenderer)("vector thumbs use the shared SVG renderer (exact dims per renderer)", async () => {
    clearIconCaches();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>';
    const tmp = path.join(os.tmpdir(), `tfm-thumb-vec-${process.pid}.svg`);
    await Bun.write(tmp, svg);
    const bytes = await thumbPng(tmp, 2, 1, 64, 48, "#1a1b26", true);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const w = dv.getUint32(16); // IHDR width
    const h = dv.getUint32(20); // IHDR height
    // Exact dims pin WHICH renderer ran: resvg fits inside (square 24x24 at
    // 64x48 → 48x48); rsvg-convert keeps the exact letterboxed 64x48 canvas.
    // A `<= requested` assertion would pass for both and prove nothing.
    if (hasResvg) {
      expect(w).toBe(48);
      expect(h).toBe(48);
    } else {
      expect(w).toBe(64);
      expect(h).toBe(48);
    }
  });

  test.skipIf(!hasMagick && !hasSvgRenderer)(
    "thumb disk cache serves revisits after the memory layer drops",
    async () => {
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
    },
  );

  // ffmpeg frame generation + raster is slow under parallel-suite load — the
  // 5s bun default is a coin flip here (AGENTS: heavy tests pin their own)
  test.skipIf(!hasFfmpeg)(
    "video thumbs extract a frame at the requested size",
    async () => {
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
    },
    20000,
  );
});

// The in-memory layers are the only unbounded ones — every raster ever served
// would otherwise live until the process exits. lruGet touches on hit, lruSet
// evicts from the Map's insertion head (least-recently-used) past the cap.
describe("icon/thumb memory cache LRU", () => {
  test("lruGet keeps the entry hot (eviction takes the untouched one)", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    expect(lruGet(m, "a")).toBe(1);
    lruSet(m, "c", 3, 2);
    expect(m.has("b")).toBe(false); // b was untouched → first out
    expect(m.has("a")).toBe(true);
    expect(m.has("c")).toBe(true);
  });

  test("lruSet overwrites in place without growing past the cap", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    lruSet(m, "a", 9, 2);
    expect(m.size).toBe(2);
    expect(m.get("a")).toBe(9);
    lruSet(m, "c", 3, 2);
    expect(m.has("b")).toBe(false);
  });

  test("lruGet misses without mutating the queue", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    expect(lruGet(m, "zz")).toBeUndefined();
    expect([...m.keys()]).toEqual(["a"]);
  });
});

// Files modified within the cool-off window are still being written: rendering
// them spawns a renderer for pixels that are stale before they land (a
// download re-thumbing on every watcher rebuild). Clock skew can't park a
// worker longer than the window either.
describe("thumbCooloffMs", () => {
  const NOW = 1_000_000;
  test("fresh file waits out the full window", () => {
    expect(thumbCooloffMs(NOW, NOW)).toBe(THUMB_COOL_MS);
  });
  test("partial age waits the remainder", () => {
    expect(thumbCooloffMs(NOW - 1000, NOW)).toBe(THUMB_COOL_MS - 1000);
  });
  test("settled file never waits", () => {
    expect(thumbCooloffMs(NOW - THUMB_COOL_MS, NOW)).toBe(0);
    expect(thumbCooloffMs(NOW - THUMB_COOL_MS - 5000, NOW)).toBe(0);
  });
  test("future mtime (clock skew) is clamped to one window", () => {
    expect(thumbCooloffMs(NOW + 60_000, NOW)).toBe(THUMB_COOL_MS);
  });
  test("unknown mtime 0 is treated as settled (the old tests pass 1/2/3)", () => {
    expect(thumbCooloffMs(0, NOW)).toBe(0);
  });
});

// magick/SVG renderer missing (CI) can't prove the sentinel end to end —
// thumbPng rejects at the spawn before the failure is recorded either way, so
// the "second call rejects fast" contract is only asserted with a real binary.
describe("thumb failure sentinel", () => {
  test.skipIf(!hasMagick && !hasSvgRenderer)(
    "a doomed file is not re-rendered per request",
    async () => {
      clearIconCaches();
      const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-thumb-fail-"));
      // not a PNG: the raster/vector pipeline must choke on it
      const bad = path.join(dir, "broken.svg");
      writeFileSync(bad, "this is not an image");
      const errOf = async (p: Promise<Uint8Array>): Promise<string> =>
        p.then(
          () => "",
          (e: unknown) => String(e),
        );
      const first = await errOf(thumbPng(bad, 5, 1, 32, 32, "#1a1b26", true));
      expect(first).toContain("exited");
      // second request must reject from the sentinel, NOT by spawning again —
      // the distinct message is the whole proof (no wall-clock bound needed)
      const second = await errOf(thumbPng(bad, 5, 1, 32, 32, "#1a1b26", true));
      expect(second).toContain("previously failed");
      // a different version of the same path is a different key: it must get a
      // REAL render attempt again (the renderer's own error, not the sentinel's)
      const edited = await errOf(thumbPng(bad, 6, 1, 32, 32, "#1a1b26", true));
      expect(edited).toContain("exited");
      // and clearIconCaches wipes the sentinel (theme flip = honest retry)
      clearIconCaches();
      const afterClear = await errOf(thumbPng(bad, 5, 1, 32, 32, "#1a1b26", true));
      expect(afterClear).toContain("exited");
      rmSync(dir, { recursive: true, force: true });
      clearIconCaches();
      // four real spawns (2 rsvg + magick fallbacks) — the 5s bun default flakes
      // under parallel-suite load (AGENTS: heavy tests pin their own timeout)
    },
    20000,
  );
});

// minimum alpha over a PNG's pixels (0 = some pixel fully transparent,
// 255 = fully opaque). Handles the 8-bit truecolor outputs rsvg-convert
// produces (color type 2 = no alpha channel, 6 = RGBA); anything else throws
// so an encoder change fails loudly instead of asserting on garbage.
const pngAlphaMin = (bytes: Uint8Array): number => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8; // skip the signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type =
      String.fromCharCode(bytes[off + 4]!) +
      String.fromCharCode(bytes[off + 5]!) +
      String.fromCharCode(bytes[off + 6]!) +
      String.fromCharCode(bytes[off + 7]!);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      // data[] is chunk-relative: bit depth / color type sit 8/9 past the
      // width+height+compression+filter+interlace header, NOT at [0]/[1]
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (colorType === 2) return 255; // truecolor without an alpha channel
  if (colorType !== 6 || bitDepth !== 8)
    throw new Error(`unsupported PNG for alpha scan: colorType=${colorType} bitDepth=${bitDepth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  let min = 255;
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const cur = raw.subarray(p, p + stride);
    p += stride;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? recon[i - 4]! : 0;
      const b = prev[i]!;
      const c = i >= 4 ? prev[i - 4]! : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = cur[i]!;
          break;
        case 1:
          v = (cur[i]! + a) & 255;
          break;
        case 2:
          v = (cur[i]! + b) & 255;
          break;
        case 3:
          v = (cur[i]! + ((a + b) >> 1)) & 255;
          break;
        default: {
          // Paeth
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          v = (cur[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
      }
      recon[i] = v;
    }
    for (let i = 3; i < stride; i += 4) if (recon[i]! < min) min = recon[i]!;
    if (min === 0) break;
    prev = recon;
  }
  return min;
};
