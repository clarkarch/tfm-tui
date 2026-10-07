import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { truncateSync, writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { inflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { glyphFor } from "./glyphs";
import { resetVideoBin, videoBin } from "../fs/videobin";
import {
  OUTLINE_ICONS,
  RASTER_FILE_LIMIT,
  THUMB_COOL_MS,
  clearIconCaches,
  iconCacheKey,
  iconPng,
  loadEmbeddedIcons,
  lruGet,
  lruSet,
  pickSvgRenderer,
  pngFromProc,
  rasterFileTooLarge,
  rasterLaneFor,
  resolveIconName,
  svgSourceMtime,
  thumbCooloffMs,
  thumbPng,
} from "./icons";

// exercises the real resvg-js/magick pipeline (dev-machine deps); failures
// here mean the raster pipeline or its cache keys broke.
// Icon tests need the in-process resvg-js addon (icons render in-process
// only, no CLI fallback anymore); vector-thumb tests also pass on magick-only
// machines via the addon-failure last resort. They skip when nothing is
// available — "missing icon rejects" stays live everywhere: with no renderer
// installed rasterizeSvg throws at the renderer check before reading the
// asset, and the missing asset throws at the read on a machine that has one.
const hasInproc = await import("@resvg/resvg-js").then(() => true).catch(() => false);
const hasMagick = Bun.which("magick") !== null;
// icons: in-process only; vector thumbs: in-process or the magick last resort
const hasSvgRenderer = hasInproc || hasMagick;
// video thumbs ride the bundled sidecar (never the system PATH); the corpus
// below is generated with that same binary, so CI covers it via postinstall.
const hasVideoBin = videoBin() !== null;

// tiny fixtures, embedded so the raster tests need no external tool to CREATE
// the input: a 6x2 PNG (Bun.Image decodes it), a 4x4 ICO (Bun.Image can't
// sniff ICO on any platform → in-process ico-to-png lane) and a 6x2
// uncompressed RGB TIFF (Bun.Image rejects TIFF on Linux → utif2 lane).
const PNG_6x2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAYAAAACAQMAAABBkz8dAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURRI0VoH6TfIAAAAHdElNRQfqCRgBEh8XiJhUAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA5LTI0VDAxOjE4OjMxKzAwOjAwhxQ3CQAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOS0yNFQwMToxODozMSswMDowMPZJj7UAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDktMjRUMDE6MTg6MzErMDA6MDChXK5qAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC";
const ICO_4x4 =
  // well-formed 4x4 INFOHEADER BMP payload (full 16-byte AND mask): the prior
  // fixture was TRUNCATED (dir entry claimed 120 payload bytes in a 108-byte
  // tail) — magick tolerates that, ico-to-png bounds-checks and refuses, so
  // the truncated shape now exercises the spawn residual, not this lane.
  "AAABAAEABAQAAAEAIAB4AAAAFgAAACgAAAAEAAAACAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAAAAAAAAAAAAAAAAAAAAAA==";
const TIFF_6x2 =
  "SUkqACwAAAD/AAD/AAD/AAD/AAD/AAD/AAAAAP8AAP8AAP8AAP8AAP8AAP8PAAABAwABAAAABgAAAAEBAwABAAAAAgAAAAIBAwADAAAA5gAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAAAoBAwABAAAAAQAAABEBBAABAAAACAAAABIBAwABAAAAAQAAABUBAwABAAAAAwAAABYBAwABAAAAAgAAABcBBAABAAAAJAAAABwBAwABAAAAAQAAACkBAwACAAAAAAABAD4BBQACAAAAHAEAAD8BBQAGAAAA7AAAAAAAAAAIAAgACACF61EAAACAAMP1qAAAAAACzcxMAAAAAAHNzEwAAACAAM3MTAAAAAACj8L1AAAAABA3GqAAAAAAAiuHCgAAACAA";

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

  test.skipIf(!hasSvgRenderer)("icon-style set rasterizes (filled base + outline variants)", async () => {
    clearIconCaches();
    for (const name of [
      "keyboard",
      "palette",
      "lightning-bolt",
      "information",
      "help",
      "checkbox-blank",
      "content-duplicate",
      "search",
      "home",
      "star",
      "clock",
      "bookmark",
      "trash-can",
      "folder",
      "eject",
      "file",
      "cog",
      "power-plug",
      "eye",
      "eye-off",
      "pencil",
      "checkbox-marked",
      "play",
      "plus",
      "folder-plus",
      "book-open",
      "database",
      "certificate",
      "cube",
      "email",
      "file-code",
      "file-document",
      "file-image",
      "file-video",
      "file-music",
      "zip-box",
    ]) {
      const bytes = await iconPng(name, "#c0caf5", "#1a1b26", 16, 16);
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // style opt resolves to the -outline asset (same bytes as naming it)
      const viaStyle = await iconPng(name, "#c0caf5", "#1a1b26", 16, 16, { style: "outline" });
      const direct = await iconPng(resolveIconName(name, "outline"), "#c0caf5", "#1a1b26", 16, 16);
      expect(viaStyle).toEqual(direct);
    }
    clearIconCaches();
  });

  test("OUTLINE_ICONS matches the -outline assets and glyph entries both ways", () => {
    // the resolver, the asset dir and the glyph table must agree, or outline
    // mode silently serves filled (missing file falls back) or tofu
    // (missing glyph entry)
    const files = new Set(
      readdirSync(path.join(import.meta.dir, "..", "..", "assets", "icons"))
        .filter((f) => f.endsWith("-outline.svg"))
        .map((f) => f.slice(0, -"-outline.svg".length)),
    );
    expect([...files].sort()).toEqual([...OUTLINE_ICONS].sort());
    for (const name of OUTLINE_ICONS) {
      expect(glyphFor(`${name}-outline`)).not.toBe("�");
      expect(resolveIconName(name, "outline")).toBe(`${name}-outline`);
    }
    // no outline sibling: filled serves both styles
    for (const name of ["power", "sort", "search", "content-duplicate", "close", "check"]) {
      expect(resolveIconName(name, "outline")).toBe(name);
    }
    expect(resolveIconName("folder", "filled")).toBe("folder");
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

  test.skipIf(!hasInproc)("non-square requests keep aspect (fit-inside)", async () => {
    clearIconCaches();
    // the in-process zoom render fit-insides (aspect-preserving): the square
    // 24x24 folder glyph in an 18x16 box shrinks to 16x16 — an exact-box
    // stretch would return 18x16, so the dims pin the behavior.
    const bytes = await iconPng("folder", "#c0caf5", "#1a1b26", 18, 16);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(16)).toBe(16); // IHDR width
    expect(dv.getUint32(20)).toBe(16); // IHDR height
    clearIconCaches();
  });

  test("renderer precedence: the in-process addon or nothing", () => {
    expect(pickSvgRenderer(true)).toBe("inproc");
    expect(pickSvgRenderer(false)).toBe(null);
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
    // Exact dims pin WHICH renderer ran: the in-process addon fit-insides
    // (square 24x24 at 64x48 → 48x48); the magick last resort keeps the
    // exact cover box 64x48. A `<= requested` assertion would pass for both
    // and prove nothing.
    if (hasInproc) {
      expect(w).toBe(48);
      expect(h).toBe(48);
    } else {
      expect(w).toBe(64);
      expect(h).toBe(48);
    }
  });

  test("raster thumbs come from Bun.Image (aspect-preserving 2x, not magick's exact box)", async () => {
    clearIconCaches();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-thumb-bun-"));
    const p = path.join(dir, "wide.png");
    writeFileSync(p, Buffer.from(PNG_6x2, "base64"));
    const bytes = await thumbPng(p, 1, 1, 64, 64, "#1a1b26");
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 6:2 into a 128x128 inside-box fits to 128x42/43; magick would have
    // returned exactly 64x64. The 128 width is the pin that Bun.Image ran.
    expect(dv.getUint32(16)).toBe(128);
    expect(dv.getUint32(20)).toBeLessThan(128);
    rmSync(dir, { recursive: true, force: true });
    clearIconCaches();
  });

  test("ICO thumbs render in-process (aspect-fit, never the magick spawn)", async () => {
    clearIconCaches();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-thumb-ico-"));
    const p = path.join(dir, "icon.ico");
    writeFileSync(p, Buffer.from(ICO_4x4, "base64"));
    const bytes = await thumbPng(p, 1, 1, 64, 64, "#1a1b26");
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // ico-to-png + Bun.Image is aspect-fit inside the 2x box (the primary
    // path's shape): 4x4 square → 128x128. magick's exact cover box would be
    // 64x64 — that shape now proves the SPAWN ran, not the lane.
    expect(dv.getUint32(16)).toBe(128);
    expect(dv.getUint32(20)).toBe(128);
    rmSync(dir, { recursive: true, force: true });
    clearIconCaches();
  });

  test("TIFF thumbs render in-process via utif2 (aspect-fit, no magick needed)", async () => {
    clearIconCaches();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-thumb-tiff-"));
    const p = path.join(dir, "img.tiff");
    writeFileSync(p, Buffer.from(TIFF_6x2, "base64"));
    const bytes = await thumbPng(p, 1, 1, 64, 64, "#1a1b26");
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 6:2 into a 128x128 inside-box fits to 128x42/43 — same aspect-fit pin
    // as the Bun.Image primary path, proving the utif2 lane ran.
    expect(dv.getUint32(16)).toBe(128);
    expect(dv.getUint32(20)).toBeLessThan(128);
    rmSync(dir, { recursive: true, force: true });
    clearIconCaches();
  });

  test("rasterLaneFor routes niche exts to in-process lanes, rest to spawn", () => {
    expect(rasterLaneFor("a.ico")).toBe("ico");
    expect(rasterLaneFor("a.CUR")).toBe("ico");
    expect(rasterLaneFor("a.tif")).toBe("tiff");
    expect(rasterLaneFor("a.TIFF")).toBe("tiff");
    expect(rasterLaneFor("a.heic")).toBe("heic");
    expect(rasterLaneFor("a.HEIF")).toBe("heic");
    // AVIF has no wasm lane (jsquash loses to spawn AND needs manual wasm
    // init under bun --compile) and everything else rides Bun.Image/spawn.
    expect(rasterLaneFor("a.avif")).toBeNull();
    expect(rasterLaneFor("a.jpg")).toBeNull();
    expect(rasterLaneFor("a.png")).toBeNull();
    expect(rasterLaneFor("a")).toBeNull();
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
  test.skipIf(!hasVideoBin)(
    "video thumbs extract a frame at the requested size",
    async () => {
      const vb = videoBin();
      if (!vb) throw new Error("video ffmpeg resolved at gate but gone at run");
      clearIconCaches();
      const tmp = path.join(os.tmpdir(), `tfm-thumb-video-${process.pid}.mp4`);
      try {
        const gen = Bun.spawnSync([
          vb.bin,
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
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    20000,
  );

  // Fake stats (not the file's real mtime/size): the point is rejection, and
  // real stats would park the job in the 3s fresh-file cooloff for nothing.
  test.skipIf(!hasVideoBin)(
    "corrupt video rejects and sentinels the key",
    async () => {
      clearIconCaches();
      const bad = path.join(os.tmpdir(), `tfm-thumb-video-bad-${process.pid}.mp4`);
      try {
        writeFileSync(bad, Buffer.from([0x00, 0x01, 0x02, 0x03]));
        const first = await thumbPng(bad, 4, 4, 48, 64, "#1a1b26", false, true).then(
          () => "resolved",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(first).not.toBe("resolved");
        const second = await thumbPng(bad, 4, 4, 48, 64, "#1a1b26", false, true).then(
          () => "resolved",
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        expect(second).toContain("previously failed");
      } finally {
        rmSync(bad, { force: true });
      }
    },
    20000,
  );

  test.skipIf(!hasVideoBin)(
    "vanished binary rejects instead of hanging",
    async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "tfm-videobin-gone-"));
      const prevEnv = process.env.TFM_FFMPEG;
      resetVideoBin();
      try {
        const ghost = path.join(tmp, "ffmpeg");
        writeFileSync(ghost, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        chmodSync(ghost, 0o755);
        process.env.TFM_FFMPEG = ghost;
        resetVideoBin();
        expect(videoBin()?.source).toBe("override");
        rmSync(ghost);
        // resolver memo still points at the deleted path: the spawn must
        // surface as a rejection (async ENOENT), never a stuck drain
        await expect(thumbPng(path.join(tmp, "x.mp4"), 4, 4, 48, 64, "#1a1b26", false, true)).rejects.toThrow();
      } finally {
        if (prevEnv === undefined) delete process.env.TFM_FFMPEG;
        else process.env.TFM_FFMPEG = prevEnv;
        resetVideoBin();
        rmSync(tmp, { recursive: true, force: true });
      }
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

// The sentinel contract holds in every environment with a renderer: the
// first/editted/cleared calls reject from a REAL render attempt (whatever
// its error text — "exited N" from a spawn, "Executable not found" without
// magick, an in-process throw), while the immediate retry rejects from the
// sentinel. Only the sentinel's own message is pinned; pinning the render
// error text made this fail on magick-less CI (resvg-js present, spawn absent).
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
      const realAttempt = (label: string, err: string) => {
        expect(`${label}: ${err}`).not.toContain("previously failed");
        expect(err.length).toBeGreaterThan(0);
      };
      const first = await errOf(thumbPng(bad, 5, 1, 32, 32, "#1a1b26", true));
      realAttempt("first", first);
      // second request must reject from the sentinel, NOT by spawning again —
      // the distinct message is the whole proof (no wall-clock bound needed)
      const second = await errOf(thumbPng(bad, 5, 1, 32, 32, "#1a1b26", true));
      expect(second).toContain("previously failed");
      // a different version of the same path is a different key: it must get a
      // REAL render attempt again (the renderer's own error, not the sentinel's)
      const edited = await errOf(thumbPng(bad, 6, 1, 32, 32, "#1a1b26", true));
      realAttempt("edited", edited);
      // and clearIconCaches wipes the sentinel (theme flip = honest retry)
      clearIconCaches();
      const afterClear = await errOf(thumbPng(bad, 5, 1, 32, 32, "#1a1b26", true));
      realAttempt("afterClear", afterClear);
      rmSync(dir, { recursive: true, force: true });
      clearIconCaches();
      // real render attempts per key version — the 5s bun default flakes
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

describe("pngFromProc timeout", () => {
  test("a hung renderer rejects instead of holding its slot forever", async () => {
    const { spawn } = await import("node:child_process");
    const proc = spawn("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"] });
    const start = Date.now();
    await expect(pngFromProc(proc, "sleep-probe", 100)).rejects.toThrow(/timed out/);
    // well under the child's 30s life: the wrapper killed it, nothing lingers
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("rasterFileTooLarge", () => {
  test("small and missing files decode in-process; oversize skips to magick", () => {
    // sparse, not written: truncate extends the size without consuming tmpfs
    // pages, so the 256MB+1 probe costs ~0 bytes on the small /tmp tmpfs
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-rasterlimit-"));
    try {
      const small = path.join(dir, "a.png");
      writeFileSync(small, Buffer.from(PNG_6x2, "base64"));
      expect(rasterFileTooLarge(small)).toBe(false);
      expect(rasterFileTooLarge(path.join(dir, "missing.png"))).toBe(false);
      const big = path.join(dir, "big.png");
      writeFileSync(big, Buffer.from(PNG_6x2, "base64"));
      truncateSync(big, RASTER_FILE_LIMIT + 1);
      expect(rasterFileTooLarge(big)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
