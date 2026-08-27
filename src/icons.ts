// --- Raster pipeline core: SVG tinting, PNG disk/memory caches, thumbnails ---
// Renderer-free on purpose: index.ts owns slots/queues (the renderable side),
// this module only turns (name, colors, pixel size) into PNG bytes. All caches
// are keyed by everything that changes the output, so theme switches miss
// naturally and never need explicit invalidation beyond clearIconCaches.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
      for (const f of (Bun as any).embeddedFiles ?? []) {
        const iconName = String(f?.name ?? "").match(/^(.+)-[a-z0-9]{8}\.svg$/i)?.[1];
        if (iconName) map.set(iconName, await f.text());
      }
    } catch {}
    return map;
  })());

export const warmEmbeddedIcons = (): void => { void embeddedIconTexts(); };

const rasterizeSvg = async (name: string, fg: string, bg: string, pxW: number, pxH: number) =>
  new Promise<Uint8Array>(async (resolve, reject) => {
    let svg: string;
    try {
      svg =
        (await embeddedIconTexts()).get(name) ??
        readFileSync(`${import.meta.dir}/../assets/icons/${name}.svg`, "utf8");
    } catch (err) {
      return reject(err);
    }
    const tinted = /#[0-9a-fA-F]{6}/.test(svg)
      ? svg.replace(/#[0-9a-fA-F]{6}/g, fg)
      : svg.replace(/<svg\b/, `<svg fill="${fg}"`);

    const proc = spawn("rsvg-convert", ["--background-color", bg, "-w", String(pxW), "-h", String(pxH)]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(new Uint8Array(Buffer.concat(chunks)))
        : reject(new Error(`rsvg-convert exited ${code}`))
    );
    proc.stdin.end(tinted);
  });

const iconCache = new Map<string, Uint8Array>();
const inflightIcons = new Map<string, Promise<Uint8Array>>();

// Disk cache for rendered rasters: keyed by everything that changes the output
// (name, tint, bg, pixel size) plus a pipeline-version salt. Theme switches
// naturally miss because fg/bg are part of the key.
const ICON_DISK_VER = "v2";
const iconDiskDir = (): string =>
  path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "icons");
const iconDiskPath = (key: string): string =>
  path.join(iconDiskDir(), `${createHash("sha1").update(`${ICON_DISK_VER}:${key}`).digest("hex").slice(0, 20)}.png`);
let iconDirReady: Promise<void> | null = null;
const ensureIconDir = (): Promise<void> =>
  (iconDirReady ??= mkdir(iconDiskDir(), { recursive: true }).then(() => undefined).catch(() => {}));

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
  const key = `${name}:${fg}:${bg}:${pxW}x${pxH}`;
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

// --- Image thumbnails (magick resize flattened onto bg, cached per file version) ---
const thumbCache = new Map<string, Promise<Uint8Array>>();

export const thumbPng = (
  path: string,
  mtimeMs: number,
  size: number,
  pxW: number,
  pxH: number,
  bg: string,
  vector = false,
): Promise<Uint8Array> => {
  // bg in the key: thumbnails are flattened onto it, so a theme swap must miss
  const key = `${path}|${mtimeMs}|${size}|${pxW}x${pxH}|${bg}`;
  let p = thumbCache.get(key);
  if (!p) {
    p = new Promise<Uint8Array>((resolve, reject) => {
      // vectors must render at high density FIRST or we upscale a tiny
      // intrinsic bitmap (a 24-unit icon svg would look like mush)
      const args = [
        ...(vector ? ["-density", "192"] : []),
        path, "-auto-orient", "-background", bg,
        "-thumbnail", `${pxW}x${pxH}^`, "-gravity", "center", "-extent", `${pxW}x${pxH}`,
        "png:-",
      ];
      const proc = spawn("magick", args);
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 && chunks.length > 0
          ? resolve(new Uint8Array(Buffer.concat(chunks)))
          : reject(new Error(`magick exited ${code}`))
      );
      proc.stdin.end();
    });
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
