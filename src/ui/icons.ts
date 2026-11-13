// --- Raster pipeline core: SVG tinting, PNG disk/memory caches, thumbnails ---
// Renderer-free on purpose: ./ui-slots owns slots/queues (the renderable side),
// this module only turns (name, colors, pixel size) into PNG bytes. All caches
// are keyed by everything that changes the output, so theme switches miss
// naturally and never need explicit invalidation beyond clearIconCaches.
import type { Subprocess } from "bun";
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// niche raster decoders (ico-to-png / pngjs / utif2) load LAZILY at the
// lane call sites below — they rode wireCore's static import chain and cost
// parse time on every boot while only ICO/TIFF thumbs ever touch them
// (jpg/png ride Bun.Image; heic-decode was already a lazy import).
import type * as UtifType from "utif2";
import { atomicWriteFile } from "../lib/atomic-write";
import { extOf } from "../fs/filetype";
import { resetVideoBin, videoBin } from "../fs/videobin";
import { errMessage } from "../lib/uiutil";
import { swallow } from "../lib/log";
import type { IconStyle } from "../config/config-schema";

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

// A compiled binary names an embedded asset "<name>-<hash>.svg". An
// ahead-of-time build may keep the plain "<name>.svg" instead (the same
// build keeps an embedded native addon's name). Which one it is shows in
// the WHOLE set: every asset carries the hash suffix, or none does — so
// the mode is decided per set, not per file. It has to be: the hash
// pattern alone is ambiguous ("file-document.svg" reads as the icon "file"
// with the hash "document"), and picking wrong keys every icon.
const HASHED_SVG_NAME = /^(.+)-[a-z0-9]{8}\.svg$/i;

export const loadEmbeddedIcons = (files: readonly EmbeddedFile[]): Promise<Map<string, string>> =>
  (async () => {
    const map = new Map<string, string>();
    // the names first: the naming mode is a property of the whole set
    const entries: { file: EmbeddedFile; name: string }[] = [];
    for (const f of files) {
      const raw = typeof f === "object" && f !== null && "name" in f ? f.name : undefined;
      if (typeof raw === "string" && raw.toLowerCase().endsWith(".svg")) {
        entries.push({ file: f, name: raw });
      }
    }
    const hashedCount = entries.filter((e) => HASHED_SVG_NAME.test(e.name)).length;
    const hashed = hashedCount * 2 > entries.length;
    for (const e of entries) {
      // per-entry guard: one unreadable blob must not abort the whole index
      // (every later icon would fall back to a Nerd-Font glyph forever)
      try {
        const iconName = hashed
          ? (e.name.match(HASHED_SVG_NAME)?.[1] ?? e.name.replace(/\.svg$/i, ""))
          : e.name.replace(/\.svg$/i, "");
        if (iconName) map.set(iconName, await e.file.text());
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

// Slots with an outline sibling (`<name>-outline.svg`, same suffix as the
// `-outline` glyph entries). Static table, not a directory probe: the
// compiled binary has no assets dir (Blobs only), and a probe would disagree
// between dev and compiled runs. icons.test.ts pins both directions
// (set ⟺ files on disk ⟺ glyph entries).
export const OUTLINE_ICONS: ReadonlySet<string> = new Set([
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
  "keyboard",
  "palette",
  "lightning-bolt",
  "information",
  "help",
  "checkbox-blank",
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
]);

// Style resolution for [ui] icon-style: outline mode serves the -outline
// asset where one ships, else the filled base (the key carries the resolved
// name, so filled/outline rasters never share a cache entry).
export const resolveIconName = (name: string, style: IconStyle = "filled"): string =>
  style === "outline" && OUTLINE_ICONS.has(name) ? `${name}-outline` : name;

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

// Natural aspect (w/h) of an icon asset for aspect-correct slot sizing:
// width/height attrs win, viewBox is the fallback, null when unparseable
// (callers fall back to square). Reads the same embedded-or-disk source the
// rasterizer uses, opening tag only — icon assets are path-only with
// unitless dims by policy.
export const svgAspect = async (name: string): Promise<number | null> => {
  let svg: string;
  try {
    svg = (await embeddedIconTexts()).get(name) ?? readFileSync(svgAssetPath(name), "utf8");
  } catch {
    return null;
  }
  const tag = svg.slice(0, svg.indexOf(">") + 1);
  const num = (re: RegExp): number | null => {
    const v = parseFloat(tag.match(re)?.[1] ?? "");
    return v > 0 ? v : null;
  };
  const w = num(/\bwidth="([\d.]+)/);
  const h = num(/\bheight="([\d.]+)/);
  if (w !== null && h !== null) return w / h;
  const vb = tag
    .match(/\bviewBox="([^"]*)"/)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (vb && vb.length === 4 && (vb[2] as number) > 0 && (vb[3] as number) > 0)
    return (vb[2] as number) / (vb[3] as number);
  return null;
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

// The ONLY SVG rasterizer is the in-process resvg-js addon (napi): measured
// in scripts/bench-raster.ts at ~0.3-0.5ms/icon vs the resvg CLI's ~6-7ms
// (13-23x — process startup dominates a spawn) and rsvg-convert's ~31-44ms
// (~60x), pixel-identical on path-only assets (0 px diff vs the CLI across
// the whole asset corpus). `loadSystemFonts: false` is what makes it fast:
// the default `true` rescans /usr/share/fonts per construction (~1.8s/icon
// measured); icon assets are path-only by policy, so fonts are never needed.
// Pure selector so the precedence is pinned without any renderer on the
// machine.
export type SvgRendererKind = "inproc" | null;
export const pickSvgRenderer = (hasInproc: boolean): SvgRendererKind => (hasInproc ? "inproc" : null);

// resvg-js loads via a sync require-dlopen: svgRenderer() AND the cache-key
// salts read it synchronously, so the addon must be resolved by the first
// call — an async import would let a salt computed before the load resolve
// name something else while later renders use in-process (key/salt mismatch).
// A failed load (musl/minimal container) is remembered, never retried.
type ResvgCtor = typeof import("@resvg/resvg-js").Resvg;

// The renderer's lifecycle is a TAG, not a nullable value. The old shape kept
// TWO states in ONE variable (`undefined` = "not tried yet", `null` = "tried
// and failed"), so writing the failure value to mean "not loaded yet"
// disabled the in-process renderer forever (the untried guard never fired)
// AND changed the disk salt — a full re-raster of every cached icon. One
// record names the phase; one function owns the transition.
export type RendererPhase = "untried" | "failed" | "ready";
export type RendererState = { phase: "untried" } | { phase: "failed" } | { phase: "ready"; ctor: ResvgCtor };

let rendererState: RendererState = { phase: "untried" };

// The transition out of "untried" is PURE: the ready phase means a USABLE
// constructor. The addon can load its JS half and expose no Resvg (a broken
// dlopen) — the old "not null" check called that "inproc", so the disk salt
// promised in-process pixels while every render threw.
export const rendererStateFor = (ctor: unknown): RendererState =>
  typeof ctor === "function" ? { phase: "ready", ctor: ctor as ResvgCtor } : { phase: "failed" };

// The ONLY transition owner: untried → ready | failed. A failed load is
// remembered (never retried — the addon cannot appear mid-session).
const loadInprocResvg = (): ResvgCtor | null => {
  if (rendererState.phase === "untried") {
    try {
      rendererState = rendererStateFor(require("@resvg/resvg-js").Resvg);
    } catch {
      rendererState = { phase: "failed" };
    }
  }
  return rendererState.phase === "ready" ? rendererState.ctor : null;
};

// The current phase — a PURE read (reading it never loads anything).
const rendererPhase = (): RendererPhase => rendererState.phase;

// The disk salt names the renderer identity, and the mapping is PURE so the
// three phases can never collapse into one spelling: an UNRESOLVED renderer
// ("untried") must not be spelled like a FAILED one ("none"), or a machine
// that resolves the addon later would serve the other lane's pixels. The
// settled spellings are the ones the disk cache already uses ("inproc" /
// "none") — the fix must not re-key every cached icon on users' machines.
export const rendererSaltFor = (phase: RendererPhase): string =>
  phase === "ready" ? "inproc" : phase === "failed" ? "none" : "untried";

const svgRenderer = (): SvgRendererKind => (loadInprocResvg() === null ? null : "inproc");

// warm the resvg dlopen off the first-paint path: the first drainIconQueue
// worker pays ~40ms for the sync require otherwise. Fire-and-forget like
// warmEmbeddedIcons — memoized, failure remembered, salt-consistent.
// setTimeout (a REAL macrotask): a Promise.then microtask runs before
// index.ts continues past `await wireChrome` and delays first paint by the
// full dlopen; the macrotask lands during runBoot's I/O wait instead.
// [ui] lazy-startup gates BOTH warms in wiring/chrome (off = classic: the
// first drain pays them inline). The gate is the boot's CAPTURED MODE
// (src/lib/boot-mode — the one place lazy-startup is interpreted), so the
// two warms can't drift (one warmed + one not = half the win for the same
// config read) and no call site spells the rule a second time.

export const warmSvgRenderer = (): void => {
  setTimeout(() => {
    try {
      loadInprocResvg();
    } catch {}
  }, 0);
};

// In-process render (resvg-js): fit-inside replicates the CLI's `-w`+`-h` —
// resvg-js lacks FitTo::Size, so a parse-only probe (width/height getters, no
// raster) gives the natural size and `zoom` renders. Two constructions per
// call, both sub-ms; the raster caches mean it only pays on cache misses.
// `bg === undefined` omits the background (transparent mode, keep alpha).
const renderInproc = (svg: string, pxW: number, pxH: number, bg?: string): Uint8Array => {
  const R = loadInprocResvg();
  if (!R) throw new Error("resvg-js addon unavailable");
  const probe = new R(svg, { logLevel: "off", font: { loadSystemFonts: false } });
  const zoom = Math.min(pxW / probe.width, pxH / probe.height);
  const r = new R(svg, {
    logLevel: "off",
    font: { loadSystemFonts: false },
    ...(bg === undefined ? {} : { background: bg }),
    fitTo: { mode: "zoom", value: zoom },
  });
  return new Uint8Array(r.render().asPng());
};

// --- Exact-canvas icon raster ---------------------------------------------
// The icon slot's PIXEL box is rarely square: foot's 7x18 cells make a
// 1-cell-tall icon box 21x18 (3 cells wide), kitty's 10x20 cells make it
// 20x20. A placement's source is drawn INTO that box, and a source whose
// dims differ from the box's gets SCALED to it: Sixel resizes the payload
// (an area filter — a resample), Kitty transmits a small placement's bitmap
// as-is and lets the terminal scale it into the cell rect. Either way the
// art was distorted (a square icon in foot's 21x18 box came out 16.7% too
// wide) and softened by the resample.
//
// OpenTUI's fit math sizes the placement's box from the SOURCE's aspect,
// but a fit-INSIDE raster is the art's own size, which is smaller than the
// box whenever the art is not as wide as the box is tall. That mismatch is
// the whole bug.
//
// So the raster's canvas IS the box: render the art fit-inside a canvas of
// exactly the box's size, centered. The source's dims then EQUAL the
// placement's pixel dims, so nothing rescales — no stretch, no resample —
// and the margin around the art is part of the image. (A writer-side
// letterbox instead — the fork's OT_IMAGE_DRAW_PRESERVE_ASPECT — leaves
// TRANSPARENT margins, and Sixel drops alpha < 128 pixels: the 1px-left /
// 2px-right margin of a 21px box became a hole, which read as a vertical
// line on the icon's right edge in foot.)
//
// The art is placed through a nested <svg> viewport that keeps the original
// root's viewBox + preserveAspectRatio: the pixels are the same fit-inside
// render as before, just centered on a canvas of the box's size.
//
// The fork's aspect-preserving placement is the fallback for a source whose
// aspect still differs from the box: it letterboxes rather than stretches.
// The icon lane does not need it — its canvas now matches the box exactly.
//
// The thumb lane does NOT use the exact canvas: its source pixels must stay
// policy-independent, and the mounted ImageRenderable owns the global
// fit/crop/stretch policy. An exact canvas would bake one policy into the
// pixels and make the other two unable to recover the source content.
export type LetterboxPlan = {
  /** the rewritten SVG: a canvas-sized outer <svg> around the art viewport */
  svg: string;
  /** the art's size in px inside the canvas */
  artW: number;
  artH: number;
  /** the art's offset in px inside the canvas */
  offsetX: number;
  offsetY: number;
};

const SVG_ROOT_OPEN = /<svg\b([^>]*)>/i;
const SVG_GEOMETRY_ATTR = /\s*\b(?:x|y|width|height|viewBox|preserveAspectRatio)\s*=\s*(?:"[^"]*"|'[^']*')/gi;

export const planLetterboxedSvg = (
  svg: string,
  probeW: number,
  probeH: number,
  pxW: number,
  pxH: number,
): LetterboxPlan | null => {
  if (!(probeW > 0 && probeH > 0 && pxW > 0 && pxH > 0)) return null;
  const zoom = Math.min(pxW / probeW, pxH / probeH);
  const artW = probeW * zoom;
  const artH = probeH * zoom;
  // the art already fills the box — the plain fit-inside render IS the box
  if (Math.abs(artW - pxW) < 0.01 && Math.abs(artH - pxH) < 0.01) return null;
  const open = svg.match(SVG_ROOT_OPEN);
  if (!open || open.index === undefined) return null;
  const attrs = open[1] ?? "";
  const close = svg.lastIndexOf("</svg>");
  if (close < open.index + open[0].length) return null;
  const inner = svg.slice(open.index + open[0].length, close);
  // keep the original root attributes (xmlns, class, style, ...) but replace
  // the geometry ones — the art viewport owns them now
  const kept = attrs.replace(SVG_GEOMETRY_ATTR, "").trim();
  const viewBox = attrs.match(/\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const par = attrs.match(/\bpreserveAspectRatio\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const vb = (viewBox?.[1] ?? viewBox?.[2])?.trim() || `0 0 ${probeW} ${probeH}`;
  const aspect = (par?.[1] ?? par?.[2])?.trim() || "xMidYMid meet";
  const offsetX = (pxW - artW) / 2;
  const offsetY = (pxH - artH) / 2;
  const nested =
    `<svg${kept ? ` ${kept}` : ""} x="${offsetX}" y="${offsetY}" width="${artW}" height="${artH}"` +
    ` viewBox="${vb}" preserveAspectRatio="${aspect}">${inner}</svg>`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="0 0 ${pxW} ${pxH}">${nested}</svg>`,
    artW,
    artH,
    offsetX,
    offsetY,
  };
};

// The icon/brand lane renders into the EXACT box (see planLetterboxedSvg);
// the thumb lane keeps the plain fit-inside render so the mounted image can
// apply the global fit/crop/stretch policy without losing source content.
const renderInprocExact = (svg: string, pxW: number, pxH: number, bg?: string): Uint8Array => {
  const R = loadInprocResvg();
  if (!R) throw new Error("resvg-js addon unavailable");
  const probe = new R(svg, { logLevel: "off", font: { loadSystemFonts: false } });
  const plan = planLetterboxedSvg(svg, probe.width, probe.height, pxW, pxH);
  if (!plan) return renderInproc(svg, pxW, pxH, bg);
  const r = new R(plan.svg, {
    logLevel: "off",
    font: { loadSystemFonts: false },
    ...(bg === undefined ? {} : { background: bg }),
  });
  return new Uint8Array(r.render().asPng());
};

// The icon lane renders into the EXACT box (renderInprocExact; the art is
// fit inside it) — see the exact-canvas note above. Transparent mode omits
// the background (keep alpha); the flattened path bakes bg in because kitty
// alpha on icon rasters proved unreliable (tint/fringe) — see [ui] icons.
const rasterizeSvg = async (
  name: string,
  fg: string,
  bg: string,
  pxW: number,
  pxH: number,
  transparent = false,
): Promise<Uint8Array> => {
  if (!svgRenderer()) throw new Error("no SVG rasterizer available (bun add @resvg/resvg-js)");
  const svg = (await embeddedIconTexts()).get(name) ?? readFileSync(svgAssetPath(name), "utf8");
  const tinted = /#[0-9a-fA-F]{6}/.test(svg)
    ? svg.replace(/#[0-9a-fA-F]{6}/g, fg)
    : svg.replace(/<svg\b/, `<svg fill="${fg}"`);
  return renderInprocExact(tinted, pxW, pxH, transparent ? undefined : bg);
};

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
// Returns the key it evicted (undefined when nothing was evicted): the lane's
// LRU index holds only the ORDER, the record itself lives in the lane's
// record map, so the caller has to drop the evicted key's record too.
export const lruSet = <V>(m: Map<string, V>, k: string, v: V, cap: number): string | undefined => {
  m.delete(k); // overwrite = recency refresh too (a no-op delete when new)
  m.set(k, v);
  let evicted: string | undefined;
  while (m.size > cap) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
    evicted = oldest;
  }
  return evicted;
};
const ICON_CACHE_MAX = 400;
const BRAND_CACHE_MAX = 8; // one logo, a few sizes — never a folder's worth
const THUMB_CACHE_MAX = 200;
// The failed sentinels get their own budget: a folder full of broken files
// must not evict the good rasters, and the good rasters must not evict the
// sentinels (the old design kept the two in separate containers for exactly
// that reason).
const FAILED_THUMBS_MAX = 4096;

// --- The per-key raster lifecycle.
//
// ONE record per key per lane: absent → inflight → ready | failed.
//
// The old shape kept three containers per cache (six in total): the ready
// bytes, the in-flight promise and (for thumbs) the failure sentinel. WHICH
// container held the key encoded the state, and the thumb cache stored
// PROMISES — so a rejected promise stayed in the cache for one microtask (the
// .catch that deleted it ran after the rejection had propagated) and was
// served to the next caller, who saw the raw render error instead of the
// sentinel.
//
// The record makes the lifecycle explicit: every transition happens INSIDE
// the render body, BEFORE the rejection propagates, so no caller can ever be
// handed a promise that has already rejected.
type RasterRecord =
  | { state: "inflight"; promise: Promise<Uint8Array> }
  | { state: "ready"; bytes: Uint8Array }
  | { state: "failed" };

// A cache is ONE record map plus the two eviction indexes. The indexes carry
// no state (the record does) — they only keep the budgets apart: the READY
// rasters are LRU-capped (hot pixels) and the FAILED sentinels have their
// own cap.
type RasterStore = {
  records: Map<string, RasterRecord>;
  readyOrder: Map<string, true>;
  failedOrder: Set<string>;
  readyCap: number;
  failedCap: number;
};

const makeStore = (readyCap: number, failedCap: number): RasterStore => ({
  records: new Map(),
  readyOrder: new Map(),
  failedOrder: new Set(),
  readyCap,
  failedCap,
});

// A READY hit touches the LRU order (the least-recently-used raster is the
// first one evicted).
const storeGet = (store: RasterStore, key: string): RasterRecord | undefined => {
  const rec = store.records.get(key);
  if (rec?.state === "ready") lruGet(store.readyOrder, key);
  return rec;
};

const storeSetReady = (store: RasterStore, key: string, bytes: Uint8Array): void => {
  store.records.set(key, { state: "ready", bytes });
  store.failedOrder.delete(key);
  const evicted = lruSet(store.readyOrder, key, true, store.readyCap);
  if (evicted !== undefined) store.records.delete(evicted);
};

const storeSetInflight = (store: RasterStore, key: string, promise: Promise<Uint8Array>): void => {
  store.records.set(key, { state: "inflight", promise });
  store.readyOrder.delete(key);
  store.failedOrder.delete(key);
};

// The failure transition runs INSIDE the render body: a caller that arrives
// in the window between "the render failed" and "the rejection propagated"
// finds the FAILED record (the sentinel) — never the dead promise.
//
// failedCap 0 → the cache keeps no sentinels: the key goes back to absent so
// the next call retries. The icon caches use that: a failed raster must not
// stick for the whole session (the drain's reset re-arms the slot, and the
// cache must not serve the old failure).
const storeSetFailed = (store: RasterStore, key: string): void => {
  store.readyOrder.delete(key);
  if (store.failedCap <= 0) {
    store.records.delete(key);
    return;
  }
  store.records.set(key, { state: "failed" });
  store.failedOrder.add(key);
  if (store.failedOrder.size >= store.failedCap) {
    // wiped wholesale (the old failedThumbs.clear()): a lost sentinel costs
    // one wasted spawn, nothing else
    for (const k of store.failedOrder) store.records.delete(k);
    store.failedOrder.clear();
  }
};

const storeClear = (store: RasterStore): void => {
  store.records.clear();
  store.readyOrder.clear();
  store.failedOrder.clear();
};

// only the FAILED records (the sentinels): a theme flip retries the broken
// files without dropping the hot rasters
const storeClearFailed = (store: RasterStore): void => {
  for (const k of store.failedOrder) store.records.delete(k);
  store.failedOrder.clear();
};

// A deferred promise: the cache's record goes INFLIGHT BEFORE the render
// starts. The old code created the job first and wrote the inflight entry
// after — correct only because every body happened to suspend before it
// settled; a body that settled early would be overwritten by the inflight
// entry (a dead promise stuck in the cache forever).
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const iconStore = makeStore(ICON_CACHE_MAX, 0);
const brandStore = makeStore(BRAND_CACHE_MAX, 0);
const thumbStore = makeStore(THUMB_CACHE_MAX, FAILED_THUMBS_MAX);

// Disk cache for rendered rasters: keyed by everything that changes the output
// (name, tint, bg, pixel size, SVG source version, transparency mode) plus a
// pipeline-version salt. Theme switches naturally miss because fg/bg are part
// of the key.
// v4: SVG icons rasterize via resvg when installed (pixels differ from the
// librsvg path), so v3 entries must regenerate.
// v5: icons render into the EXACT cell box (the art fit inside it) — a
// fit-inside canvas did not match the placement's pixel box, so the writer
// scaled the raster to it: distorted on sixel, and resampled (blurry)
// everywhere.
const ICON_DISK_VER = "v5";
// renderer identity is part of the salt: installing/switching the rasterizer
// must invalidate whatever the OTHER one cached (a flat version bump only
// covers the upgrade itself, not a later install). The salt is a PURE read
// of the renderer's phase — the lane that builds the path settles the
// renderer first, so the disk read and the disk write of one raster agree.
const iconSalt = (): string => `${ICON_DISK_VER}:${rendererSaltFor(rendererPhase())}`;
const iconDiskDir = (): string => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "icons");
const iconDiskPath = (key: string): string =>
  path.join(
    iconDiskDir(),
    `${new Bun.CryptoHasher("sha1").update(`${iconSalt()}:${key}`).digest("hex").slice(0, 20)}.png`,
  );
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
  opts?: { transparent?: boolean; style?: IconStyle },
): Promise<Uint8Array> => {
  // settle the renderer BEFORE the cache paths: the disk salt names the
  // renderer identity and is a pure read of the phase, so the disk read and
  // the disk write of one raster must see the SAME phase
  loadInprocResvg();
  const transparent = opts?.transparent ?? false;
  const asset = resolveIconName(name, opts?.style ?? "filled");
  const key = iconCacheKey(asset, fg, bg, pxW, pxH, svgSourceMtime(asset), transparent);
  const hit = storeGet(iconStore, key);
  if (hit?.state === "ready") return hit.bytes;
  // identical requests racing (e.g. 15 folder rows) share one render
  if (hit?.state === "inflight") return hit.promise;
  try {
    const cached = readFileSync(iconDiskPath(key));
    const bytes = new Uint8Array(cached);
    storeSetReady(iconStore, key, bytes);
    return bytes;
  } catch {}
  const job = deferred<Uint8Array>();
  storeSetInflight(iconStore, key, job.promise);
  void (async () => {
    try {
      await acquireRasterSlot();
      try {
        const bytes = await rasterizeSvg(asset, fg, bg, pxW, pxH, transparent);
        storeSetReady(iconStore, key, bytes);
        // path captured NOW: the write-behind must not re-read $XDG_CACHE_HOME
        // after a sandbox re-pointed it — the late read let the previous test's
        // write land in the NEXT test's fresh sandbox (fire-and-forget race)
        const diskPath = iconDiskPath(key);
        void ensureIconDir().then(() =>
          atomicWriteFile(diskPath, bytes).catch((err) => swallow("icon disk cache write", err)),
        );
        job.resolve(bytes);
      } finally {
        releaseRasterSlot();
      }
    } catch (err) {
      // the record leaves the inflight state HERE, inside the body: the
      // rejection has not propagated yet, so a caller arriving in that
      // window can never be handed the dead promise
      storeSetFailed(iconStore, key);
      job.reject(err);
    }
  })().catch((err) => job.reject(err));
  return job.promise;
};

// --- Faithful brand raster (the About logo): the icon path above replaces
// every #hex with the slot fg, which is right for monochrome glyphs but
// destroys a multi-color mark. This lane renders the asset AS-IS (no tint)
// through the same in-process renderer, with its own `brand:` cache prefix
// so faithful and tinted rasters never share an entry. `bg === undefined`
// keeps alpha (transparent modes); otherwise it flattens onto bg like icons.
export const brandPng = async (name: string, pxW: number, pxH: number, bg?: string): Promise<Uint8Array> => {
  // settle the renderer before the cache paths (same rule as iconPng above)
  loadInprocResvg();
  const key = `brand:${name}:${pxW}x${pxH}|src${svgSourceMtime(name)}${bg === undefined ? "|t" : `|${bg}`}`;
  const hit = storeGet(brandStore, key);
  if (hit?.state === "ready") return hit.bytes;
  if (hit?.state === "inflight") return hit.promise;
  try {
    const cached = readFileSync(iconDiskPath(key));
    const bytes = new Uint8Array(cached);
    storeSetReady(brandStore, key, bytes);
    return bytes;
  } catch {}
  const job = deferred<Uint8Array>();
  storeSetInflight(brandStore, key, job.promise);
  void (async () => {
    try {
      await acquireRasterSlot();
      try {
        if (!svgRenderer()) throw new Error("no SVG rasterizer available (bun add @resvg/resvg-js)");
        const svg = (await embeddedIconTexts()).get(name) ?? readFileSync(svgAssetPath(name), "utf8");
        const bytes = renderInprocExact(svg, pxW, pxH, bg);
        storeSetReady(brandStore, key, bytes);
        // path captured NOW (same write-behind race as the icon cache above)
        const diskPath = iconDiskPath(key);
        void ensureIconDir().then(() =>
          atomicWriteFile(diskPath, bytes).catch((err) => swallow("brand disk cache write", err)),
        );
        job.resolve(bytes);
      } finally {
        releaseRasterSlot();
      }
    } catch (err) {
      storeSetFailed(brandStore, key);
      job.reject(err);
    }
  })().catch((err) => job.reject(err));
  return job.promise;
};

// --- Image thumbnails (vector-crisp via the shared svgRenderer, magick
// fallback; cached per file version in memory AND on disk so folder revisits
// are instant instead of re-spawning a renderer per file) ---

// test seam: the hung-renderer timeout is pinned through a real hanging child
// cap what pngFromProc retains: a chatty/broken renderer would otherwise OOM
// the renderer process (same 256KB ceiling as the archive tool capture — a
// cell-box PNG thumb is bytes, anything past this is pathological and fails
// downstream decode into the next lane/sentinel instead of growing RAM).
const MAX_PROC_CAPTURE = 256 * 1024;
export const pngFromProc = (proc: Subprocess, tool: string, timeoutMs = 30_000): Promise<Uint8Array> =>
  new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let retained = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // a hung renderer must not occupy a RASTER_CONCURRENCY slot forever (12
    // simultaneous hangs = the whole icon/thumbnail pipeline stalls with no
    // sentinel, since the FAILED record only lands on rejection)
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      settle(() => reject(new Error(`${tool} timed out`)));
    }, timeoutMs);
    // stderr is drained + discarded: a chatty failing renderer filling its
    // pipe would block the process and the exit would never resolve (the
    // thumb job would hang)
    const pump = async (stream: unknown, keep: boolean): Promise<void> => {
      if (!(stream instanceof ReadableStream)) return;
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!keep) continue;
          if (retained >= MAX_PROC_CAPTURE) continue;
          const room = MAX_PROC_CAPTURE - retained;
          const take = value.length > room ? value.subarray(0, room) : value;
          chunks.push(take);
          retained += take.length;
        }
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      } finally {
        reader.releaseLock();
      }
    };
    void (async () => {
      await Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]);
      let code: number | null = null;
      try {
        code = await proc.exited;
      } catch {
        code = null;
      }
      // message shapes are load-bearing: the video retry matches "timed out"
      // vs /exited \d+/ to tell a hung ffmpeg from a corrupt file
      const out = new Uint8Array(retained);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      settle(() => (code === 0 && retained > 0 ? resolve(out) : reject(new Error(`${tool} exited ${code}`))));
    })();
  });

// spawn wrapper for the raster pipes: Bun.spawn throws synchronously on a
// missing binary (node's spawn did not), so the throw is converted to a
// rejection — every magick()/attempt() call site chains .catch() and would
// otherwise see a sync throw escape where a rejection belonged. The message
// carries neither "timed out" nor "exited N", so the video path still reads
// it as a dead binary (resetVideoBin) rather than a corrupt file.
const spawnPng = (bin: string, args: string[], tool: string): Promise<Uint8Array> => {
  try {
    return pngFromProc(
      Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } }),
      tool,
    );
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
};

// SVG files render vector-crisp through the SAME single renderer icons use
// (the in-process resvg-js addon; magick is the addon-failure last resort —
// and the photo/video paths' renderer anyway). In-process fit-inside
// (dims <= target), same as the icon path.
//
// magick's shared fallback tail keeps the WHOLE source: auto-orient, flatten
// onto bg, then thumbnail INSIDE the requested box. It deliberately does not
// use `^` + `-extent` (the old cover-crop shape): baking a crop into the
// pixels would make the global fit policy unable to recover the source edges
// and the stretch policy unable to undo the distortion.
export const magickFitTail = (p: string, pxW: number, pxH: number, bg: string): string[] => [
  p,
  "-auto-orient",
  "-background",
  bg,
  "-alpha",
  "remove",
  "-alpha",
  "off",
  "-thumbnail",
  `${pxW}x${pxH}`,
  "png:-",
];
const magickVectorArgs = (p: string, pxW: number, pxH: number, bg: string): string[] => [
  "-density",
  "192",
  ...magickFitTail(p, pxW, pxH, bg),
];
const renderVectorPng = (p: string, pxW: number, pxH: number, bg: string): Promise<Uint8Array> => {
  // Text-bearing SVGs render glyphless in-process (fonts-off, probed: the
  // glyphs vanish, no crash) — no renderer is re-spawned for fonts.
  const magick = () => spawnPng("magick", magickVectorArgs(p, pxW, pxH, bg), "magick");
  return Promise.resolve()
    .then(() => renderInproc(readFileSync(p, "utf8"), pxW, pxH, bg))
    .catch(magick);
};

// Raster stills go through Bun's built-in image pipeline (Bun >= 1.3.14): it
// runs in-process on the work pool (no spawn) and already uses the JPEG IDCT
// scale-down magick needed the `jpeg:size` hint for. Output is aspect-preserving
// (fit:"inside", never letterboxed) — the mounted ImageRenderable applies the
// global fit/crop/stretch policy at draw time. The 2x box mirrors the old
// decode hint so the draw-time crop downsamples.
// Alpha: Bun.Image preserves the source alpha channel where magick's
// `-alpha remove` FLATTENS onto bg. Deliberate: flattening can't be done
// in-process, and the
// flatten only changes genuinely translucent pixels (an opaque-alpha PNG like a
// screenshot renders identically) — so we accept it and keep the perf win. The
// magick fallback below still flattens, so exotic formats stay opaque.
const renderRasterBunImage = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> =>
  new Bun.Image(p, { autoOrient: true })
    .resize(pxW * 2, pxH * 2, { fit: "inside" })
    .png()
    .bytes();

// --- Niche raster decoders: in-process fallbacks for formats Bun.Image
// can't decode on Linux. Measured in scripts/bench-niche-decoders.ts
// (median per 64px thumb, Linux — spawn times swing wildly with box load,
// in-process lanes don't):
//   ICO:  ico-to-png ~40-55ms vs spawn ~35-85ms (parity-or-better) → lane
//         FIRST for zero-dep + primary-path shape, spawn residual
//   TIFF: utif2+pngjs ~30-45ms beats spawn ~50-72ms → lane FIRST, spawn residual
//   HEIC: heic-decode ~780ms ties spawn ~700-800ms → spawn FIRST, wasm covers
//         the no-magick machine (lazy import: wasm + ~250ms init only on HEIC
//         files that both faster lanes refused)
//   AVIF: NO wasm lane — @jsquash/avif 241ms loses to spawn 128ms AND needs
//         manual wasm init under bun --compile (probed) → spawn, then glyph.
//   magick-wasm: REJECTED — its Memory64 build aborts at init on Bun 1.4.0
//         (blocked on oven-sh/bun#35740), 15.8MB for a fallback path.
// pngjs is the RGBA→PNG bridge for the rgba-returning decoders: Bun.Image
// cannot construct from raw RGBA (uncaught ERR_IMAGE_UNKNOWN_FORMAT —
// probed, never do it).

// Pure lane routing (ext → in-process decoder); null rides Bun.Image/spawn.
export type RasterLane = "ico" | "tiff" | "heic";
export const rasterLaneFor = (p: string): RasterLane | null => {
  const ext = extOf(p);
  if (ext === "ico" || ext === "cur") return "ico";
  if (ext === "tif" || ext === "tiff") return "tiff";
  if (ext === "heic" || ext === "heif") return "heic";
  return null;
};

// Shared tail: resize PNG bytes through the primary path (same 2x
// aspect-fit shape as renderRasterBunImage, so lane output matches it).
const bunResizeBytes = async (pngBytes: Uint8Array, pxW: number, pxH: number): Promise<Uint8Array> =>
  new Bun.Image(pngBytes, { autoOrient: true })
    .resize(pxW * 2, pxH * 2, { fit: "inside" })
    .png()
    .bytes();

// memoized lazy decoders (same policy as heicDecodeP below: an import
// failure is structural and the lane's catch falls through to magick/glyph)
let pngjsP: Promise<typeof import("pngjs")> | null = null;
const loadPngjs = (): Promise<typeof import("pngjs")> => (pngjsP ??= import("pngjs"));
let utifP: Promise<typeof UtifType> | null = null;
const loadUtif = (): Promise<typeof UtifType> => (utifP ??= import("utif2"));
let icoPngP: Promise<typeof import("@humanwhocodes/ico-to-png")> | null = null;
const loadIcoPng = (): Promise<typeof import("@humanwhocodes/ico-to-png")> =>
  (icoPngP ??= import("@humanwhocodes/ico-to-png"));

const rgbaToPng = async (data: Uint8Array | Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> => {
  const { PNG } = await loadPngjs();
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data);
  return PNG.sync.write(png);
};

// ICOs carry multiple resolutions; the biggest decodes cleanest.
const renderIcoPng = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const { extractImagesAsPng } = await loadIcoPng();
  const imgs = extractImagesAsPng(new Uint8Array(readFileSync(p)));
  const best = imgs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!best) throw new Error(`no images in ICO: ${p}`);
  return bunResizeBytes(best.data, pxW, pxH);
};

const renderTiffPng = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const UTIF = await loadUtif();
  const buf = readFileSync(p);
  const ifd = UTIF.decode(buf)[0];
  if (!ifd) throw new Error(`no IFD in TIFF: ${p}`);
  UTIF.decodeImage(buf, ifd);
  return bunResizeBytes(await rgbaToPng(UTIF.toRGBA8(ifd), ifd.width, ifd.height), pxW, pxH);
};

// heic-decode loads its libheif wasm on first import (~300ms) — memoized and
// never retried, same policy as the resvg-js loader above (an import failure
// is structural, and the thumb lane's FAILED record already sentinels per key).
let heicDecodeP: Promise<typeof import("heic-decode")["default"]> | null = null;
const renderHeicPng = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  heicDecodeP ??= import("heic-decode").then((m) => m.default);
  const { width, height, data } = await (await heicDecodeP)({ buffer: readFileSync(p) });
  return bunResizeBytes(await rgbaToPng(data, width, height), pxW, pxH);
};

// In-process decoders hold the whole image in RAM, so files past this skip
// straight to the out-of-process magick fallback (its 30s pngFromProc timeout
// bounds even those). 256MB compressed can decode to GBs of pixels.
export const RASTER_FILE_LIMIT = 256 * 1024 * 1024;
export const rasterFileTooLarge = (p: string): boolean => {
  try {
    return (statSync(p, { throwIfNoEntry: false })?.size ?? 0) > RASTER_FILE_LIMIT;
  } catch {
    return false;
  }
};

const renderRasterPng = (p: string, pxW: number, pxH: number, bg: string): Promise<Uint8Array> => {
  // magick stays the fallback: formats no in-process lane covers (AVIF on
  // Linux; XCF/KRA; exotic ICO/TIFF payloads the lanes refuse) — and a
  // runtime older than 1.3.14, where `new Bun.Image` throws inside the async
  // fn and the catch routes here.
  const magick = (): Promise<Uint8Array> =>
    spawnPng(
      "magick",
      [
        // decode at ~2x target size: full-res JPEG decode dominates thumb time
        // (~95 of ~108ms measured on 12MP); the hint is a no-op for PNG input.
        "-define",
        `jpeg:size=${pxW * 2}x${pxH * 2}`,
        ...magickFitTail(p, pxW, pxH, bg),
      ],
      "magick",
    );
  // Faster lane first (measured, see above): a refusing lane falls through to
  // magick, a missing magick falls through to the lane/glyph. Oversize files
  // skip every in-process decoder straight to magick: a multi-hundred-MB
  // panorama/TIFF fully decodes in-process (same OOM class the archive memory
  // limit guards), while the spawn is out-of-process with its own 30s timeout.
  if (rasterFileTooLarge(p)) return magick();
  switch (rasterLaneFor(p)) {
    case "ico":
      return renderRasterBunImage(p, pxW, pxH).catch(() => renderIcoPng(p, pxW, pxH).catch(magick));
    case "tiff":
      return renderRasterBunImage(p, pxW, pxH).catch(() => renderTiffPng(p, pxW, pxH).catch(magick));
    case "heic":
      return renderRasterBunImage(p, pxW, pxH).catch(() => magick().catch(() => renderHeicPng(p, pxW, pxH)));
    default:
      return renderRasterBunImage(p, pxW, pxH).catch(magick);
  }
};

// video thumbs: one representative frame via the system ffmpeg
// (src/fs/videobin — $TFM_FFMPEG override then PATH; nothing is bundled, and
// a machine without ffmpeg keeps plain icons via canThumbVideo). The frame
// preserves the source aspect ratio: the mounted ImageRenderable owns the
// global fit/crop/stretch policy, so the producer must not bake in a crop.
// Input-seek ~1s in to skip the black lead-in (fast keyframe seek); clips
// shorter than that retry at 0.
export const canThumbVideo = (): boolean => videoBin() !== null;
export const videoThumbFilter = (pxW: number, pxH: number): string =>
  `scale=${pxW}:${pxH}:force_original_aspect_ratio=decrease`;
const renderVideoPng = async (p: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const vb = videoBin();
  if (!vb) throw new Error(`no video ffmpeg available: ${p}`);
  const vf = videoThumbFilter(pxW, pxH);
  const attempt = (ss: string) =>
    spawnPng(
      vb.bin,
      [
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
      ],
      "ffmpeg",
    );
  try {
    return await attempt("1");
  } catch (err) {
    // a hung ffmpeg must not cost two full timeouts (60s worker stall for one
    // corrupt video): the 0-seek retry only helps empty-output decode misses,
    // never a child that never answered
    if (errMessage(err).includes("timed out")) throw err;
    try {
      return await attempt("0");
    } catch (err2) {
      // dead binary (spawn-level failure), not a corrupt file: drop the
      // memoized resolution so the next job re-resolves instead of failing
      // every video; decode failures ("exited N") keep the binary and let the
      // per-file sentinel remember the broken file
      const msg = errMessage(err2);
      if (!msg.includes("timed out") && !/exited \d+/.test(msg)) resetVideoBin();
      throw err2;
    }
  }
};

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

// The FAILED state of the thumb lane (corrupt jpg, magick choked). Without
// it the cache re-spawned the doomed renderer on EVERY rebuild for as long as
// the folder was open. The key carries path+size+mtime, so any real change to
// the file retries naturally. The sentinels have their own budget (they are
// wiped wholesale past the cap — memory bound only; a lost sentinel costs one
// wasted spawn, nothing else).
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Disk cache keyed by everything that changes the output (path, mtime, size,
// pixel size, bg, vector flag) plus a pipeline-version salt — renderer swaps
// and file edits miss naturally. The disk tier is unbounded on purpose (the
// memory layer above now is LRU-capped).
// v2: raster path decodes JPEGs at ~2x target (jpeg:size hint) — pixels differ
// slightly from v1 full-decode thumbs, so old entries must regenerate.
// v3: raster stills moved to Bun.Image (aspect-preserving, cover-cropped at
// draw) — different pixels/dims from magick's v2 cover-crop, so regenerate.
// v4: magick fallback and video frames now preserve the whole source instead
// of baking a cover crop into their pixels. The global draw-time fit policy
// needs those original edges, so old cropped disk entries must regenerate.
// SVG thumbs carry the rasterizer identity in their key (see `mode` in thumbPng)
// instead of a flat bump here, so changing the SVG renderer regenerates only
// SVG thumbs and never re-rasterizes a whole photo library.
const THUMB_DISK_VER = "v4";
const thumbDiskDir = (): string => path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "thumbs");
const thumbDiskPath = (key: string): string =>
  path.join(
    thumbDiskDir(),
    `${new Bun.CryptoHasher("sha1").update(`${THUMB_DISK_VER}:${key}`).digest("hex").slice(0, 20)}.png`,
  );
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

// Pure disk/memory key for one thumbnail. Raster + video lanes ignore bg:
// Bun.Image keeps alpha (no flatten) and video frames are opaque, so bg in
// the key re-rendered the whole photo library on every theme switch for
// byte-identical pixels. Vector (SVG) thumbs DO flatten onto bg and keep it.
// Niche raster lanes share the bg-free key (aspect-fit, alpha kept); the rare
// magick-fallback flatten of a translucent exotic then serves the older bg's
// pixels — accepted, opaque images are unaffected either way.
export const thumbCacheKey = (
  path: string,
  mtimeMs: number,
  size: number,
  pxW: number,
  pxH: number,
  bg: string,
  mode: string,
): string =>
  mode.startsWith("vec:")
    ? `${path}|${mtimeMs}|${size}|${pxW}x${pxH}|${bg}|${mode}`
    : `${path}|${mtimeMs}|${size}|${pxW}x${pxH}|${mode}`;

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
  // SVG thumbs are keyed by the rasterizer too: resvg vs rsvg produce different
  // pixels, and switching must not serve the other renderer's cache. Raster
  // keys stay renderer-free so a photo library is never needlessly redone;
  // video keys carry the binary source instead (override↔PATH swaps must not
  // serve another binary's pixels — same argv, decoders may differ).
  // Niche lanes carry their lane in the mode: in-process pixels (2x aspect-fit)
  // differ from spawn pixels (1x aspect-fit), so `raster:ico` etc. must not
  // serve magick-era `raster` entries. jpg/png/avif keep bare `raster` — their
  // paths are unchanged, no mass re-raster. (heic's two lanes share one mode:
  // installing/removing magick flips its lane under the same key — both are
  // valid thumbs of the same image and any file edit re-keys on mtime.)
  const lane = rasterLaneFor(path);
  const vb = video ? videoBin() : null;
  const mode = video
    ? `video:${vb?.source ?? "none"}`
    : vector
      ? `vec:${svgRenderer() ?? "none"}`
      : lane
        ? `raster:${lane}`
        : "raster";
  const key = thumbCacheKey(path, mtimeMs, size, pxW, pxH, bg, mode);
  const hit = storeGet(thumbStore, key);
  if (hit?.state === "ready") return Promise.resolve(hit.bytes);
  if (hit?.state === "inflight") return hit.promise;
  // a FAILED record → the sentinel: this exact version already failed, so it
  // is not attempted again (the key carries path+size+mtime, so an edit
  // retries naturally)
  if (hit?.state === "failed") return Promise.reject(new Error(`thumb previously failed: ${path}`));
  // the disk tier is consulted BEFORE the job starts: the render is the only
  // async part, and a disk hit must not be overwritten by the inflight entry
  try {
    const bytes = new Uint8Array(readFileSync(thumbDiskPath(key)));
    storeSetReady(thumbStore, key, bytes);
    return Promise.resolve(bytes);
  } catch {}
  const job = deferred<Uint8Array>();
  storeSetInflight(thumbStore, key, job.promise);
  void (async () => {
    try {
      // a disk hit means these pixels were already rendered once — never cool
      // off those, only the expensive live render
      const wait = thumbCooloffMs(mtimeMs, Date.now());
      if (wait > 0) await sleep(wait);
      const bytes = await (video
        ? renderVideoPng(path, pxW, pxH)
        : vector
          ? renderVectorPng(path, pxW, pxH, bg)
          : renderRasterPng(path, pxW, pxH, bg));
      storeSetReady(thumbStore, key, bytes);
      // write-behind: never block the render on the cache write
      // path captured NOW — same fire-and-forget race as the icon write above
      const diskPath = thumbDiskPath(key);
      void ensureThumbDir().then(() =>
        atomicWriteFile(diskPath, bytes).catch((err) => swallow("thumb disk cache write", err)),
      );
      job.resolve(bytes);
    } catch (err) {
      // the sentinel lands HERE, inside the body: the rejection has not
      // propagated yet, so a caller arriving in that window gets the
      // sentinel — never the dead promise
      storeSetFailed(thumbStore, key);
      job.reject(err);
    }
  })().catch((err) => job.reject(err));
  return job.promise;
};

// theme flips re-tint icons (their keys carry fg/bg, so old-theme entries
// stay valid for cycling back — never wiped here); the disk cache still
// serves new-theme misses — this only drops the in-memory layers
export const clearIconCaches = (): void => {
  storeClear(iconStore);
  storeClear(brandStore);
  storeClear(thumbStore);
};

// theme-flip retry: a broken file deserves one fresh attempt per palette
// without dropping every hot raster (the old full wipe made each flip cold)
export const clearFailedThumbs = (): void => {
  storeClearFailed(thumbStore);
};
