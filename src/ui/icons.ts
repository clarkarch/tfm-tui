// --- Raster pipeline core: SVG tinting, PNG disk/memory caches, thumbnails ---
// Renderer-free on purpose: ./ui-slots owns slots/queues (the renderable side),
// this module only turns (name, colors, pixel size) into PNG bytes. All caches
// are keyed by everything that changes the output, so theme switches miss
// naturally and never need explicit invalidation beyond clearIconCaches.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../fs/fsutil";
import { swallow } from "../app/log";

const home = os.homedir();

// In a `bun --compile` binary, assets/icons/*.svg are embedded as Blob blobs
// named "<basename>-<hash>.svg" — plain readFileSync can't see them (and
// import.meta.dir is /$bunfs/..., so the disk path fails too). Index by
// basename once; dev runs (embeddedFiles empty) fall through to disk.
// The entries are plain Blobs, NOT Files — reach .name structurally ("name"
// in f), never via instanceof File (that check silently emptied the whole
// index and every icon fell back to glyphs in the shipped binary).
// Memoize the PROMISE, not the Map: assigning the Map first let concurrent
// callers resolve against a half-filled index during the await loop.
type EmbeddedFile = { name?: unknown; text: () => Promise<string> };

export const loadEmbeddedIcons = (files: readonly EmbeddedFile[]): Promise<Map<string, string>> =>
  (async () => {
    const map = new Map<string, string>();
    for (const f of files) {
      // per-entry guard: one unreadable blob must not abort the whole index
      // (every later icon would fall back to a Nerd-Font glyph forever)
      try {
        const raw = typeof f === "object" && f !== null && "name" in f ? f.name : undefined;
        const iconName = typeof raw === "string" ? raw.match(/^(.+)-[a-z0-9]{8}\.svg$/i)?.[1] : undefined;
        if (iconName) map.set(iconName, await f.text());
      } catch (err) {
        // one unreadable blob used to vanish silently; the symptom is every
        // later icon falling back to a glyph with no hint of the cause
        swallow("embedded icon blob unreadable", err);
      }
    }
    return map;
  })();

let embeddedIconsP: Promise<Map<string, string>> | null = null;
const embeddedIconTexts = (): Promise<Map<string, string>> =>
  (embeddedIconsP ??= loadEmbeddedIcons(Bun.embeddedFiles ?? []));

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
  transparent = false,
): string =>
  transparent
    ? // bg-insensitive: one raster serves every tile state (rest/hover/selected)
      `${name}:${fg}:${pxW}x${pxH}|src${srcMtimeMs}|t`
    : `${name}:${fg}:${bg}:${pxW}x${pxH}|src${srcMtimeMs}`;

// Which SVG rasterizer to spawn. resvg is ~5-7x faster per invocation than
// rsvg-convert — process startup (cairo/pango/librsvg init) dominates the
// raster by an order of magnitude, not the drawing, so the lighter dep-free
// binary wins outright (measured in scripts/bench-raster.ts). Prefer it when
// installed; fall back to rsvg-convert. Pure selector so the precedence is
// pinned without either binary on the machine; `svgRenderer` memoizes the
// Bun.which probe (a PATH scan).
export const pickSvgRenderer = (hasResvg: boolean, hasRsvg: boolean): "resvg" | "rsvg-convert" | null =>
  hasResvg ? "resvg" : hasRsvg ? "rsvg-convert" : null;
let svgRendererCache: "resvg" | "rsvg-convert" | null | undefined;
const svgRenderer = (): "resvg" | "rsvg-convert" | null => {
  if (svgRendererCache === undefined) {
    svgRendererCache = pickSvgRenderer(Bun.which("resvg") !== null, Bun.which("rsvg-convert") !== null);
  }
  return svgRendererCache;
};

// resvg reads stdin as `-` and writes stdout with `-c`; rsvg-convert does both
// implicitly. resvg fit-inside (`-w`+`-h`) preserves aspect where rsvg stretches
// — the slot's ImageRenderable `fit` absorbs the difference.
const rasterizeSvg = async (
  name: string,
  fg: string,
  bg: string,
  pxW: number,
  pxH: number,
  transparent = false,
): Promise<Uint8Array> => {
  const renderer = svgRenderer();
  if (!renderer) throw new Error("no SVG rasterizer available (install resvg or rsvg-convert)");
  const svg = (await embeddedIconTexts()).get(name) ?? readFileSync(svgAssetPath(name), "utf8");
  const tinted = /#[0-9a-fA-F]{6}/.test(svg)
    ? svg.replace(/#[0-9a-fA-F]{6}/g, fg)
    : svg.replace(/<svg\b/, `<svg fill="${fg}"`);

  // transparent mode omits the background entirely (keep alpha); the flattened
  // path bakes bg in because kitty alpha on icon rasters proved unreliable
  // (tint/fringe) — see [ui] icons
  const size = ["-w", String(pxW), "-h", String(pxH)];
  const args =
    renderer === "resvg"
      ? // --quiet mutes resvg's logger, but the stdin "set --resources-dir"
        // notice is a bare eprintln that bypasses it (verified), so stderr is
        // drained below rather than trusted to stay empty
        transparent
        ? ["--quiet", ...size, "-", "-c"]
        : ["--quiet", "--background", bg, ...size, "-", "-c"]
      : transparent
        ? size
        : ["--background-color", bg, ...size];
  const proc = spawn(renderer, args);
  const chunks: Buffer[] = [];
  proc.stdout.on("data", (c: Buffer) => {
    chunks.push(c);
  });
  // drain stderr: an undrained pipe blocks the child once it fills and 'close'
  // never fires (the icon job then holds its raster slot forever) — same reason
  // pngFromProc resumes it
  proc.stderr.resume();
  const done = new Promise<Uint8Array>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(new Uint8Array(Buffer.concat(chunks)))
        : reject(new Error(`${renderer} exited ${code}`)),
    );
  });
  proc.stdin.end(tinted);
  return done;
};

const iconCache = new Map<string, Uint8Array>();
const inflightIcons = new Map<string, Promise<Uint8Array>>();

// --- bounded LRU for the in-memory raster tiers (nautilus caps its icon/
// texture caches at 100/200/1000; without a cap a long session that browsed
// hundreds of folders/themes keeps every PNG forever). Map iteration order is
// insertion order, so delete+re-set on hit = touch-to-back and the head is the
// least-recently-used entry. The disk tier below is unbounded and serves misses.
export const lruGet = <V>(m: Map<string, V>, k: string): V | undefined => {
  const v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
};
export const lruSet = <V>(m: Map<string, V>, k: string, v: V, cap: number): void => {
  m.delete(k); // overwrite = recency refresh too (a no-op delete when new)
  m.set(k, v);
  while (m.size > cap) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
};
const ICON_CACHE_MAX = 400;
// ponytail: evicting an entry whose render is still in flight drops the dedupe,
// so a watcher rebuild can double-spawn it (self-correcting, and bounded by the
// 8 workers + the drain's slot-liveness skip). Raise past ~1 full folder of
// thumbs if image-heavy dirs ever show visible re-raster flicker.
const THUMB_CACHE_MAX = 200;

// Disk cache for rendered rasters: keyed by everything that changes the output
// (name, tint, bg, pixel size, SVG source version, transparency mode) plus a
// pipeline-version salt. Theme switches naturally miss because fg/bg are part
// of the key.
// v4: SVG icons rasterize via resvg when installed (pixels differ from the
// librsvg path), so v3 entries must regenerate.
const ICON_DISK_VER = "v4";
// renderer identity is part of the salt: installing/switching the rasterizer
// must invalidate whatever the OTHER one cached (a flat version bump only
// covers the upgrade itself, not a later install)
const iconSalt = (): string => `${ICON_DISK_VER}:${svgRenderer() ?? "none"}`;
const iconDiskDir = (): string => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "icons");
const iconDiskPath = (key: string): string =>
  path.join(iconDiskDir(), `${createHash("sha1").update(`${iconSalt()}:${key}`).digest("hex").slice(0, 20)}.png`);
let iconDirReady: Promise<void> | null = null;
const ensureIconDir = (): Promise<void> =>
  (iconDirReady ??= mkdir(iconDiskDir(), { recursive: true })
    .then(() => undefined)
    .catch(() => {}));

// Cap concurrent renderer forks — boot fans out dozens of slots at once and a
// thundering herd of rasterizer processes is slower than a capped pipeline.
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

export const iconPng = async (
  name: string,
  fg: string,
  bg: string,
  pxW: number,
  pxH: number,
  opts?: { transparent?: boolean },
): Promise<Uint8Array> => {
  const transparent = opts?.transparent ?? false;
  const key = iconCacheKey(name, fg, bg, pxW, pxH, svgSourceMtime(name), transparent);
  const hit = lruGet(iconCache, key);
  if (hit) return hit;
  // identical requests racing (e.g. 15 folder rows) share one render
  const running = inflightIcons.get(key);
  if (running) return running;
  try {
    const cached = readFileSync(iconDiskPath(key));
    const bytes = new Uint8Array(cached);
    lruSet(iconCache, key, bytes, ICON_CACHE_MAX);
    return bytes;
  } catch {}
  const job = (async () => {
    await acquireRasterSlot();
    try {
      const bytes = await rasterizeSvg(name, fg, bg, pxW, pxH, transparent);
      lruSet(iconCache, key, bytes, ICON_CACHE_MAX);
      void ensureIconDir().then(() =>
        atomicWriteFile(iconDiskPath(key), bytes).catch((err) => swallow("icon disk cache write", err)),
      );
      return bytes;
    } finally {
      releaseRasterSlot();
    }
  })();
  inflightIcons.set(key, job);
  job.finally(() => inflightIcons.delete(key)).catch(() => {});
  return job;
};

// --- Image thumbnails (vector-crisp via the shared svgRenderer, magick
// fallback; cached per file version in memory AND on disk so folder revisits
// are instant instead of re-spawning a renderer per file) ---

const pngFromProc = (proc: ChildProcessWithoutNullStreams, tool: string): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    // drain stderr: a chatty failing renderer filling its pipe would block the
    // process and 'close' would never fire (the thumb job would hang)
    proc.stderr.resume();
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(new Uint8Array(Buffer.concat(chunks)))
        : reject(new Error(`${tool} exited ${code}`)),
    );
  });

// SVG files render vector-crisp through the SAME single renderer icons use
// (svgRenderer: resvg preferred, else rsvg-convert) — one selection, one SVG
// dependency in play at a time, never both. resvg fits inside (dims <= target);
// rsvg keeps the exact letterboxed canvas. magick is the last resort when no
// SVG renderer is installed (and the photo/video paths' renderer anyway).
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
  const magick = () => pngFromProc(spawn("magick", magickVectorArgs(p, pxW, pxH, bg)), "magick");
  const renderer = svgRenderer();
  if (renderer === "resvg") {
    return pngFromProc(
      spawn("resvg", ["--quiet", "--background", bg, "-w", String(pxW), "-h", String(pxH), p, "-c"]),
      "resvg",
    ).catch(magick);
  }
  if (renderer === "rsvg-convert") {
    // exact canvas, contain-fit, letterboxed onto bg; librsvg < 2.54 lacks
    // --page-* and is caught by the magick fallback
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
    ).catch(magick);
  }
  return magick();
};

// Raster stills go through Bun's built-in image pipeline (Bun >= 1.3.14): it
// runs in-process on the work pool (no spawn) and already uses the JPEG IDCT
// scale-down magick needed the `jpeg:size` hint for. Output is aspect-preserving
// (fit:"inside", never letterboxed) — the tile's ImageRenderable uses
// fit:"cover" to center-crop it into the cell box, replacing magick's
// raster-time `-thumbnail ^` + `-extent` cover-crop. The 2x box mirrors the old
// decode hint so the cover-crop downsamples.
// Alpha: Bun.Image preserves the source alpha channel where magick's `-extent`
// FLATTENED onto bg. Deliberate: flattening can't be done in-process, and the
// flatten only changes genuinely translucent pixels (an opaque-alpha PNG like a
// screenshot renders identically) — so we accept it and keep the perf win. The
// magick fallback below still flattens, so exotic formats stay opaque.
const renderRasterBunImage = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> =>
  new Bun.Image(p, { autoOrient: true })
    .resize(pxW * 2, pxH * 2, { fit: "inside" })
    .png()
    .bytes();

const renderRasterPng = (p: string, pxW: number, pxH: number, bg: string): Promise<Uint8Array> => {
  // magick stays the fallback: formats Bun.Image can't decode here (ICO always;
  // TIFF/HEIC/AVIF on Linux; XCF/KRA) — and a runtime older than 1.3.14, where
  // `new Bun.Image` throws inside the async fn and the catch routes here.
  const magick = (): Promise<Uint8Array> =>
    pngFromProc(
      spawn("magick", [
        // decode at ~2x target size: full-res JPEG decode dominates thumb time
        // (~95 of ~108ms measured on 12MP); the hint is a no-op for PNG input.
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
  return renderRasterBunImage(p, pxW, pxH).catch(magick);
};

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

// Nautilus refuses to thumbnail files modified <3s ago (THUMBNAIL_CREATION_
// DELAY_SECS) — a mid-download file would otherwise re-spawn a renderer on
// every watcher rebuild, always producing pixels for a version that's already
// gone. Waiting it out inside the job is the lazy re-queue (nautilus arms its
// own backoff timer; we lean on the watcher's next rebuild instead, so the
// final settled version is guaranteed a render — declining outright would
// leave no thumb until a folder revisit). Cost: a cool-off sleeps THIS worker
// (one of 8) for the remainder; the burst case (freshly extracted folder)
// self-heals as files settle out of the window in drain order. Pure +
// clamped for clock skew so a future mtime can never park a worker for hours.
export const THUMB_COOL_MS = 3000;
export const thumbCooloffMs = (mtimeMs: number, now: number): number => {
  if (mtimeMs <= 0) return 0;
  const wait = THUMB_COOL_MS - (now - mtimeMs);
  return wait > 0 ? Math.min(wait, THUMB_COOL_MS) : 0;
};

// Keys whose renderer already failed (corrupt jpg, magick choked). Without
// this the self-evicting cache re-spawned the doomed renderer on EVERY rebuild
// for as long as the folder was open. The key carries path+size+mtime, so any
// real change to the file retries naturally. Wiped wholesale past the cap —
// memory bound only; a lost sentinel costs one wasted spawn, nothing else.
const failedThumbs = new Set<string>();
const FAILED_THUMBS_MAX = 4096;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Disk cache keyed by everything that changes the output (path, mtime, size,
// pixel size, bg, vector flag) plus a pipeline-version salt — renderer swaps
// and file edits miss naturally. The disk tier is unbounded on purpose (the
// memory layer above now is LRU-capped).
// v2: raster path decodes JPEGs at ~2x target (jpeg:size hint) — pixels differ
// slightly from v1 full-decode thumbs, so old entries must regenerate.
// v3: raster stills moved to Bun.Image (aspect-preserving, cover-cropped at
// draw) — different pixels/dims from magick's v2 cover-crop, so regenerate.
// SVG thumbs carry the rasterizer identity in their key (see `mode` in thumbPng)
// instead of a flat bump here, so changing the SVG renderer regenerates only
// SVG thumbs and never re-rasterizes a whole photo library.
const THUMB_DISK_VER = "v3";
const thumbDiskDir = (): string => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "thumbs");
const thumbDiskPath = (key: string): string =>
  path.join(thumbDiskDir(), `${createHash("sha1").update(`${THUMB_DISK_VER}:${key}`).digest("hex").slice(0, 20)}.png`);
// NOT memoized: tests re-point XDG_CACHE_HOME per run, a memoized mkdir would
// cache the first dir and strand later writes in a missing directory
const ensureThumbDir = async (): Promise<void> => {
  try {
    await mkdir(thumbDiskDir(), { recursive: true });
  } catch (err) {
    // a failed mkdir means no disk tier at all: every revisit re-rasterizes
    swallow("thumb disk cache dir", err);
  }
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
  // bg in the key: SVG thumbs (and the magick raster fallback for exotic
  // formats) are still flattened onto it, so a theme swap must miss. Bun.Image
  // raster output ignores bg (it keeps alpha) and so re-rasters on a theme flip
  // for nothing — rare, and the safety of the flattening paths outweighs it.
  // SVG thumbs are keyed by the rasterizer too: resvg vs rsvg produce different
  // pixels, and switching must not serve the other renderer's cache. Raster/
  // video keys stay renderer-free so a photo library is never needlessly redone.
  const mode = video ? "video" : vector ? `vec:${svgRenderer() ?? "none"}` : "raster";
  const key = `${path}|${mtimeMs}|${size}|${pxW}x${pxH}|${bg}|${mode}`;
  if (failedThumbs.has(key)) return Promise.reject(new Error(`thumb previously failed: ${path}`));
  let p = lruGet(thumbCache, key);
  if (!p) {
    p = (async () => {
      try {
        const cached = readFileSync(thumbDiskPath(key));
        return new Uint8Array(cached);
      } catch {}
      // a disk hit means these pixels were already rendered once — never cool
      // off those, only the expensive live render
      const wait = thumbCooloffMs(mtimeMs, Date.now());
      if (wait > 0) await sleep(wait);
      const bytes = await (video
        ? renderVideoPng(path, pxW, pxH)
        : vector
          ? renderVectorPng(path, pxW, pxH, bg)
          : renderRasterPng(path, pxW, pxH, bg));
      // write-behind: never block the render on the cache write
      void ensureThumbDir().then(() =>
        atomicWriteFile(thumbDiskPath(key), bytes).catch((err) => swallow("thumb disk cache write", err)),
      );
      return bytes;
    })();
    p.catch(() => {
      thumbCache.delete(key);
      if (failedThumbs.size >= FAILED_THUMBS_MAX) failedThumbs.clear();
      failedThumbs.add(key);
    });
    lruSet(thumbCache, key, p, THUMB_CACHE_MAX);
  }
  return p;
};

// theme flips re-tint everything; the disk cache still serves (fg/bg are in
// its keys) — this only drops the in-memory layers
export const clearIconCaches = (): void => {
  iconCache.clear();
  thumbCache.clear();
  failedThumbs.clear();
};
