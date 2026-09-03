// --- Raster pipeline core: SVG tinting, PNG disk/memory caches, thumbnails ---
// Renderer-free on purpose: ./ui-slots owns slots/queues (the renderable side),
// this module only turns (name, colors, pixel size) into PNG bytes. All caches
// are keyed by everything that changes the output, so theme switches miss
// naturally and never need explicit invalidation beyond clearIconCaches.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

// In a `bun --compile` binary, assets/icons/*.svg are embedded as File blobs
// named "<basename>-<hash>.svg" — plain readFileSync can't see them. Index by
// basename once; dev runs (embeddedFiles empty) fall through to disk.
// Memoize the PROMISE, not the Map: assigning the Map first let concurrent
// callers resolve against a half-filled index during the await loop.
let embeddedIconsP: Promise<Map<string, string>> | null = null;
const embeddedIconTexts = (): Promise<Map<string, string>> =>
  (embeddedIconsP ??= (async () => {
    const map = new Map<string, string>();
    try {
      for (const f of Bun.embeddedFiles ?? []) {
        // typed as Blob, but the compiled binary embeds Files (hence .name)
        const iconName = (f instanceof File ? f.name : "").match(/^(.+)-[a-z0-9]{8}\.svg$/i)?.[1];
        if (iconName) map.set(iconName, await f.text());
      }
    } catch {}
    return map;
  })());

export const warmEmbeddedIcons = (): void => {
  void embeddedIconTexts();
};

const svgAssetPath = (name: string): string => `${import.meta.dir}/../../assets/icons/${name}.svg`;

// SVG source version for the icon cache key: editing an asset must
// re-raster instead of serving the stale disk entry (the old key only had
// name/tint/bg/size, so asset edits were invisible until the cache dir was
// wiped by hand). 0 when the file is absent — the compiled binary embeds
// assets, fixed at build time.
export const svgSourceMtime = (name: string): number => {
  try {
    return statSync(svgAssetPath(name)).mtimeMs;
  } catch {
    return 0;
  }
};

export const iconCacheKey = (
  name: string,
  fg: string,
  bg: string,
  pxW: number,
  pxH: number,
  srcMtimeMs: number,
): string => `${name}:${fg}:${bg}:${pxW}x${pxH}|src${srcMtimeMs}`;

const rasterizeSvg = async (name: string, fg: string, bg: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const svg = (await embeddedIconTexts()).get(name) ?? readFileSync(svgAssetPath(name), "utf8");
  const tinted = /#[0-9a-fA-F]{6}/.test(svg)
    ? svg.replace(/#[0-9a-fA-F]{6}/g, fg)
    : svg.replace(/<svg\b/, `<svg fill="${fg}"`);

  const proc = spawn("rsvg-convert", ["--background-color", bg, "-w", String(pxW), "-h", String(pxH)]);
  const chunks: Buffer[] = [];
  proc.stdout.on("data", (c: Buffer) => {
    chunks.push(c);
  });
  const done = new Promise<Uint8Array>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(new Uint8Array(Buffer.concat(chunks)))
        : reject(new Error(`rsvg-convert exited ${code}`)),
    );
  });
  proc.stdin.end(tinted);
  return done;
};

const iconCache = new Map<string, Uint8Array>();
const inflightIcons = new Map<string, Promise<Uint8Array>>();

// Disk cache for rendered rasters: keyed by everything that changes the output
// (name, tint, bg, pixel size, SVG source version) plus a pipeline-version
// salt. Theme switches naturally miss because fg/bg are part of the key.
const ICON_DISK_VER = "v2";
const iconDiskDir = (): string => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "icons");
const iconDiskPath = (key: string): string =>
  path.join(iconDiskDir(), `${createHash("sha1").update(`${ICON_DISK_VER}:${key}`).digest("hex").slice(0, 20)}.png`);
let iconDirReady: Promise<void> | null = null;
const ensureIconDir = (): Promise<void> =>
  (iconDirReady ??= mkdir(iconDiskDir(), { recursive: true })
    .then(() => undefined)
    .catch(() => {}));

// Cap concurrent rsvg forks — boot fans out dozens of slots at once and a
// thundering herd of librsvg processes is slower than a capped pipeline.
const RASTER_CONCURRENCY = 12;
let rasterActive = 0;
const rasterWaiters: (() => void)[] = [];
const acquireRasterSlot = async (): Promise<void> => {
  if (rasterActive >= RASTER_CONCURRENCY) await new Promise<void>((r) => rasterWaiters.push(r));
  rasterActive++;
};
const releaseRasterSlot = () => {
  rasterActive--;
  rasterWaiters.shift()?.();
};

export const iconPng = async (name: string, fg: string, bg: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const key = iconCacheKey(name, fg, bg, pxW, pxH, svgSourceMtime(name));
  const hit = iconCache.get(key);
  if (hit) return hit;
  // identical requests racing (e.g. 15 folder rows) share one render
  const running = inflightIcons.get(key);
  if (running) return running;
  try {
    const cached = readFileSync(iconDiskPath(key));
    const bytes = new Uint8Array(cached);
    iconCache.set(key, bytes);
    return bytes;
  } catch {}
  const job = (async () => {
    await acquireRasterSlot();
    try {
      const bytes = await rasterizeSvg(name, fg, bg, pxW, pxH);
      iconCache.set(key, bytes);
      void ensureIconDir().then(() => writeFile(iconDiskPath(key), bytes).catch(() => {}));
      return bytes;
    } finally {
      releaseRasterSlot();
    }
  })();
  inflightIcons.set(key, job);
  job.finally(() => inflightIcons.delete(key)).catch(() => {});
  return job;
};

// --- Image thumbnails (vector-crisp via rsvg-convert, magick fallback;
// cached per file version in memory AND on disk so folder revisits are
// instant instead of re-spawning a renderer per file) ---

const pngFromProc = (proc: ChildProcessWithoutNullStreams, tool: string): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(new Uint8Array(Buffer.concat(chunks)))
        : reject(new Error(`${tool} exited ${code}`)),
    );
  });

// SVGs render vector-crisp at the exact target size (contain-fit, letterboxed
// onto bg) — the old magick -density dance rasterized a small intrinsic bitmap
// first and then upscaled it: slow AND mushy for icon-sized viewBoxes.
// rsvg-convert missing (CI, IM6 distros) or ancient librsvg (< 2.54, no
// --page-*): fall back to the magick -density path.
const magickVectorArgs = (p: string, pxW: number, pxH: number, bg: string): string[] => [
  "-density",
  "192",
  p,
  "-auto-orient",
  "-background",
  bg,
  "-thumbnail",
  `${pxW}x${pxH}^`,
  "-gravity",
  "center",
  "-extent",
  `${pxW}x${pxH}`,
  "png:-",
];
const renderVectorPng = (p: string, pxW: number, pxH: number, bg: string): Promise<Uint8Array> => {
  if (Bun.which("rsvg-convert")) {
    return pngFromProc(
      spawn("rsvg-convert", [
        "-w",
        String(pxW),
        "-h",
        String(pxH),
        "--page-width",
        String(pxW),
        "--page-height",
        String(pxH),
        "--keep-aspect-ratio",
        "--background-color",
        bg,
        p,
      ]),
      "rsvg-convert",
    ).catch(() => pngFromProc(spawn("magick", magickVectorArgs(p, pxW, pxH, bg)), "magick"));
  }
  return pngFromProc(spawn("magick", magickVectorArgs(p, pxW, pxH, bg)), "magick");
};

const renderRasterPng = (p: string, pxW: number, pxH: number, bg: string): Promise<Uint8Array> =>
  pngFromProc(
    spawn("magick", [
      // decode at ~2x target size: full-res JPEG decode dominates thumb time
      // (~95 of ~108ms measured on 12MP); the hint is a no-op for PNG input.
      // 2x keeps downscale quality while skipping most of the decode (~5x).
      "-define",
      `jpeg:size=${pxW * 2}x${pxH * 2}`,
      p,
      "-auto-orient",
      "-background",
      bg,
      "-thumbnail",
      `${pxW}x${pxH}^`,
      "-gravity",
      "center",
      "-extent",
      `${pxW}x${pxH}`,
      "png:-",
    ]),
    "magick",
  );

// video thumbs: one representative frame via ffmpeg, cover-cropped like the
// raster path so tiles keep a uniform look. Input-seek ~1s in to skip the
// black lead-in (fast keyframe seek); clips shorter than that retry at 0.
export const canThumbVideo = (): boolean => Bun.which("ffmpeg") !== null;
const renderVideoPng = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const vf = `scale=${pxW}:${pxH}:force_original_aspect_ratio=increase,crop=${pxW}:${pxH}`;
  const attempt = (ss: string) =>
    pngFromProc(
      spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        ss,
        "-i",
        p,
        "-frames:v",
        "1",
        "-vf",
        vf,
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-",
      ]),
      "ffmpeg",
    );
  try {
    return await attempt("1");
  } catch {
    return attempt("0");
  }
};

const thumbCache = new Map<string, Promise<Uint8Array>>();

// Disk cache keyed by everything that changes the output (path, mtime, size,
// pixel size, bg, vector flag) plus a pipeline-version salt — renderer swaps
// and file edits miss naturally. No eviction (icon disk cache has none either).
// v2: raster path decodes JPEGs at ~2x target (jpeg:size hint) — pixels differ
// slightly from v1 full-decode thumbs, so old entries must regenerate.
const THUMB_DISK_VER = "v2";
const thumbDiskDir = (): string => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "thumbs");
const thumbDiskPath = (key: string): string =>
  path.join(thumbDiskDir(), `${createHash("sha1").update(`${THUMB_DISK_VER}:${key}`).digest("hex").slice(0, 20)}.png`);
// NOT memoized: tests re-point XDG_CACHE_HOME per run, a memoized mkdir would
// cache the first dir and strand later writes in a missing directory
const ensureThumbDir = async (): Promise<void> => {
  try {
    await mkdir(thumbDiskDir(), { recursive: true });
  } catch {}
};

export const thumbPng = (
  path: string,
  mtimeMs: number,
  size: number,
  pxW: number,
  pxH: number,
  bg: string,
  vector = false,
  video = false,
): Promise<Uint8Array> => {
  // bg in the key: thumbnails are flattened onto it, so a theme swap must miss
  const mode = video ? "video" : vector ? "vec" : "raster";
  const key = `${path}|${mtimeMs}|${size}|${pxW}x${pxH}|${bg}|${mode}`;
  let p = thumbCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const cached = readFileSync(thumbDiskPath(key));
        return new Uint8Array(cached);
      } catch {}
      const bytes = await (video
        ? renderVideoPng(path, pxW, pxH)
        : vector
          ? renderVectorPng(path, pxW, pxH, bg)
          : renderRasterPng(path, pxW, pxH, bg));
      // write-behind: never block the render on the cache write
      void ensureThumbDir().then(() => writeFile(thumbDiskPath(key), bytes).catch(() => {}));
      return bytes;
    })();
    p.catch(() => thumbCache.delete(key));
    thumbCache.set(key, p);
  }
  return p;
};

// theme flips re-tint everything; the disk cache still serves (fg/bg are in
// its keys) — this only drops the in-memory layers
export const clearIconCaches = (): void => {
  iconCache.clear();
  thumbCache.clear();
};
