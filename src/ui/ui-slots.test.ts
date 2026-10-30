import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, type CliRenderer } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  dimHex,
  hoverEvents,
  shadeIconStates,
  isFloatRootId,
  makePointerSetter,
  makeSlots,
  thumbImageFit,
  thumbJobRank,
  type SlotsCtx,
  type ThumbJob,
} from "./ui-slots";
import type { Theme } from "../config/config";

// icon rasters need one of the SVG renderers (same gate as icons.test.ts)
const hasInproc = await import("@resvg/resvg-js").then(() => true).catch(() => false);
const hasMagick = Bun.which("magick") !== null;
const hasSvgRenderer = hasInproc || hasMagick;
// brand/faithful rasters are in-process only (no CLI fallback, same as iconPng)

// recursive walk over a source tree — the no-drift rule below scans ALL of
// src/, not just the flat src/ui/ directory (same model as fs/which.test.ts)
const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
};

// The registry must cover every RASTERED slot, including ones whose raster
// finished before a modal opened: resetIconQueue re-queues drained slots for
// theme-flip re-rasters, and setRasterDim repaints mounted state images for
// the scrim. The drain's raster step is intentionally pointed at a missing
// icon name — the raster fails cleanly without spawning anything,
// but done+prune still run, which is exactly the regression path.

const FG = "#c0caf5";
const BG = "#1a1b26";

const makeHarness = () => {
  const nodes = new Map<string, any>();
  let ttyMode = false;
  let forceGlyph = false;
  let iconStyle: "filled" | "outline" = "filled";
  const ctx: SlotsCtx = {
    renderer: () =>
      ({ resolution: { width: 800, height: 400 }, terminalWidth: 80, terminalHeight: 20 }) as unknown as CliRenderer,
    byId: (id) => nodes.get(id),
    colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
    uiStyle: () => "solid",
    iconsMode: () => "opaque",
    iconStyle: () => iconStyle,
    iconCells: () => 3,
    glyphFor: (name) => (iconStyle === "outline" ? `O:${name}` : "F"),
    isTtyMode: () => ttyMode,
    forceGlyph: () => forceGlyph,
  };
  const slots = makeSlots(ctx);

  // a fake mounted slot: glyph + an already-rastered state image
  const mountFakeSlot = (spec: { slotId: string }) => {
    const glyph = { id: `${spec.slotId}-g`, content: "F", fg: FG, visible: true };
    const img = { id: `${spec.slotId}-s0`, visible: true };
    const slot = {
      id: spec.slotId,
      width: 2,
      kids: [glyph, img] as any[],
      getChildren: () => [...slot.kids],
      add: (c: any) => slot.kids.push(c),
    };
    nodes.set(spec.slotId, slot);
    return { slot, glyph, img };
  };

  return {
    slots,
    nodes,
    mountFakeSlot,
    setTtyMode: (v: boolean) => (ttyMode = v),
    setForceGlyph: (v: boolean) => (forceGlyph = v),
    setIconStyle: (v: "filled" | "outline") => (iconStyle = v),
  };
};

describe("icon slot registry", () => {
  test("shadeIconStates darkens the foreground and leaves the background", () => {
    // the flattened square must keep matching the tile, so only fg is shaded;
    // float islands are never dimmed
    const states = [{ fg: FG, bg: BG }];
    expect(shadeIconStates(states, 0.5, false)).toEqual([{ fg: dimHex(FG, 0.5), bg: BG }]);
    // the fill overlay darkens the covered cells, so the square follows
    expect(shadeIconStates(states, 0.5, false, 0.5)).toEqual([{ fg: dimHex(FG, 0.5), bg: dimHex(BG, 0.5) }]);
    expect(shadeIconStates(states, 0.5, true)).toEqual(states);
    expect(shadeIconStates(states, 1, false)).toEqual(states);
  });

  test("resetIconQueue re-queues a drained slot whose raster finished earlier", async () => {
    // theme flips must re-raster boot-baked slots (nav buttons et al) that
    // already drained — the prune made them unreachable from the queue
    const h = makeHarness();
    const s = h.slots.makeIconSlot("no-such-icon-xyz", [{ fg: FG, bg: BG }], 1, 0);
    h.mountFakeSlot(s.spec);

    await h.slots.drainIconQueue();
    h.slots.resetIconQueue();

    expect(s.spec.done).toBe(false);
    await h.slots.drainIconQueue();
    expect(s.spec.done).toBe(true);
  });

  test("resetIconQueue repaints mounted fallback glyphs for the active style", async () => {
    // an icon-style toggle must flip the -g texts too (shown pre-raster and
    // under the scrim) — re-rastering alone would strand the old glyph
    // behind every slow/failed raster
    const h = makeHarness();
    const s = h.slots.makeIconSlot("folder", [{ fg: FG, bg: BG }], 1, 0);
    const { glyph } = h.mountFakeSlot(s.spec);
    expect(glyph.content).toBe("F");

    h.setIconStyle("outline");
    h.slots.resetIconQueue();
    expect(glyph.content).toBe("O:folder");

    h.setIconStyle("filled");
    h.slots.resetIconQueue();
    expect(glyph.content).toBe("F");
  });

  test("drain re-raster consults statesFactory so a theme flip paints fresh colors", async () => {
    // the factory reads live theme colors — a mutating factory proves the
    // second drain actually re-rastered (pruned specs can never drain again)
    const h = makeHarness();
    let color = "#00ff00";
    const s = h.slots.makeIconSlot("no-such-icon-xyz", [{ fg: color, bg: BG }], 1, 0, undefined, () => [
      { fg: color, bg: BG },
    ]);
    h.mountFakeSlot(s.spec);

    await h.slots.drainIconQueue();
    expect(s.spec.states[0]!.fg).toBe("#00ff00");

    color = "#ff0000";
    h.slots.resetIconQueue();
    await h.slots.drainIconQueue();
    expect(s.spec.states[0]!.fg).toBe("#ff0000");
  });

  test("tty mode drains nothing: specs stay pending, thumb jobs are dropped", async () => {
    // the linux console has no graphics protocol, so every raster spawn would
    // fail, and the drains no-op with the glyph slots staying as built
    const h = makeHarness();
    h.setTtyMode(true);
    const s = h.slots.makeIconSlot("no-such-icon-xyz", [{ fg: FG, bg: BG }], 1, 0);
    h.mountFakeSlot(s.spec);
    h.slots.pushThumbJob({
      slotId: "thumb-1",
      path: "/nonexistent.png",
      mtimeMs: 0,
      size: 10,
      wCells: 4,
      vector: false,
      fallbackGlyph: "F",
    });

    await h.slots.drainIconQueue();
    await h.slots.drainThumbs();
    expect(s.spec.done).toBeFalsy();

    // flipping back off resumes normal draining with the same registry
    h.setTtyMode(false);
    await h.slots.drainIconQueue();
    expect(s.spec.done).toBe(true);
  });

  test("force glyph drains nothing (buggy kitty impl) without forcing tty mode", async () => {
    // same raster skip as tty mode, but the terminal is modern: view mode,
    // anims and transparency are untouched, only placements stop
    const h = makeHarness();
    h.setForceGlyph(true);
    const s = h.slots.makeIconSlot("no-such-icon-xyz", [{ fg: FG, bg: BG }], 1, 0);
    h.mountFakeSlot(s.spec);

    await h.slots.drainIconQueue();
    await h.slots.drainThumbs();
    expect(s.spec.done).toBeFalsy();

    h.setForceGlyph(false);
    await h.slots.drainIconQueue();
    expect(s.spec.done).toBe(true);
  });
});

// Two decisions hang off "is this slot inside a floating layer": the raster
// keeps its alpha only OUTSIDE floats under `transparent-partial`, and its
// flatten bg is the float's own fill (style.slotBg role "float"). The toast
// shell was missing from the set, so toast icons were the ONE floating-layer
// icon rendered transparent while every menu/dialog icon stayed opaque.
describe("isFloatRootId", () => {
  test("every floating layer root counts", () => {
    for (const id of [
      "tfm-menu",
      "tfm-filemenu",
      "tfm-filemenu-sub",
      "tfm-prompt",
      "tfm-props",
      "tfm-conflict",
      "tfm-yesno",
      "tfm-pick",
      "tfm-bulkrename",
    ]) {
      expect(isFloatRootId(id)).toBe(true);
    }
  });

  test("toast shells are per-instance, so the prefix matches", () => {
    expect(isFloatRootId("tfm-toast-1")).toBe(true);
    expect(isFloatRootId("tfm-toast-42")).toBe(true);
  });

  test("chrome and non-string ids never count as floats", () => {
    expect(isFloatRootId("tfm-status")).toBe(false);
    expect(isFloatRootId("tfm-term-host")).toBe(false);
    expect(isFloatRootId("tfm-toast")).toBe(false);
    expect(isFloatRootId(undefined)).toBe(false);
    expect(isFloatRootId(7)).toBe(false);
  });
});

describe("thumbJobRank", () => {
  const job = (over: Partial<ThumbJob>): ThumbJob =>
    ({
      slotId: "s",
      path: "/p",
      mtimeMs: 0,
      size: 0,
      wCells: 1,
      vector: false,
      fallbackGlyph: "?",
      ...over,
    }) as ThumbJob;

  test("visible tiles drain ahead of the off-screen backlog", () => {
    expect(thumbJobRank(job({ visible: true }))).toBeLessThan(thumbJobRank(job({ visible: false })));
  });

  test("foreground jobs still outrank the whole folder backlog", () => {
    expect(thumbJobRank(job({ priority: true, visible: false }))).toBeLessThan(thumbJobRank(job({ visible: true })));
  });

  // jobs built before this field existed (or with no viewport verdict) keep
  // their old position — an absent flag must never demote them to last
  test("missing visible flag ranks as visible", () => {
    expect(thumbJobRank(job({}))).toBe(thumbJobRank(job({ visible: true })));
  });
});

// The fit mapping is a pure decision, tested here so it guards CI too (the
// mounted tests below skip when the SVG/magick renderers are absent): rasters
// and video cover-crop into the tile, SVG vectors contain. Getting this wrong
// crops SVG drawings — the exact regression this pins.
describe("thumbImageFit", () => {
  test("rasters/video cover-crop; SVG vectors contain", () => {
    expect(thumbImageFit(false)).toBe("cover");
    expect(thumbImageFit(true)).toBe("fit");
  });
});

// Renderer-backed (createTestRenderer pilot: ui-menu.test.ts): drainThumbs
// mounts a REAL ImageRenderable, pinning the raster→renderable coupling that
// fake-ctx tests can't see — a raster thumb is aspect-preserving (Bun.Image
// fit:"inside", see icons.test.ts) and must be cover-cropped into the cell box;
// a `fit:"fit"` revert would letterbox/contain it instead of filling the tile.
describe("thumbnail mount", () => {
  // 6x2 PNG — same fixture as icons.test.ts
  const PNG_6x2 =
    "iVBORw0KGgoAAAANSUhEUgAAAAYAAAACAQMAAABBkz8dAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURRI0VoH6TfIAAAAHdElNRQfqCRgBEh8XiJhUAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA5LTI0VDAxOjE4OjMxKzAwOjAwhxQ3CQAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOS0yNFQwMToxODozMSswMDowMPZJj7UAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDktMjRUMDE6MTg6MzErMDA6MDChXK5qAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC";
  let t: TestRendererSetup;
  const REAL_CACHE_HOME = process.env.XDG_CACHE_HOME;
  let cacheSandbox = "";
  // mouse pointer shapes requested through the slots ctx seam (OSC 22 sink)
  const slotPointers: string[] = [];

  beforeAll(async () => {
    // box the disk cache for this file, like icons.test.ts — drainThumbs →
    // thumbPng would otherwise write into (or be served a disk hit from) the
    // real ~/.cache/tfm/thumbs
    cacheSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-slots-cache-"));
    process.env.XDG_CACHE_HOME = cacheSandbox;
    t = await createTestRenderer({ width: 80, height: 24 });
  });
  afterAll(async () => {
    await t.dispose(); // 0.6.0: destroy + await closed
    if (REAL_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = REAL_CACHE_HOME;
    rmSync(cacheSandbox, { recursive: true, force: true });
  });

  const mkSlots = () =>
    makeSlots({
      renderer: () => t.renderer,
      byId: (id) => t.renderer.root.findDescendantById(id),
      colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
      uiStyle: () => "solid",
      iconsMode: () => "opaque",
      iconCells: () => 4,
      glyphFor: () => "F",
      isTtyMode: () => false,
      forceGlyph: () => false,
      setPointer: (s) => void slotPointers.push(s),
    });
  // the headless renderer's resolution getter is readonly and null (real pixels
  // come from the live terminal); shadow it so the drains' pixel gate opens
  const openResolution = (): void => {
    Object.defineProperty(t.renderer, "resolution", { value: { width: 800, height: 480 }, configurable: true });
  };
  const writePng = (name = "wide.png"): { dir: string; p: string } => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-slots-thumb-"));
    const p = path.join(dir, name);
    writeFileSync(p, Buffer.from(PNG_6x2, "base64"));
    return { dir, p };
  };
  const SVG_DOT = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#f00"/></svg>`;
  const writeSvg = (name = "dot.svg"): { dir: string; p: string } => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-slots-svg-"));
    const p = path.join(dir, name);
    writeFileSync(p, SVG_DOT);
    return { dir, p };
  };

  test('a drained raster thumb mounts with fit:"cover"', async () => {
    const slotId = "tfm-tile-0-thumb";
    t.renderer.root.add(Box({ id: slotId, width: 8, height: 8 }));
    await t.renderOnce();
    const { dir, p } = writePng();
    const slots = mkSlots();
    slots.pushThumbJob({ slotId, path: p, mtimeMs: 1, size: 1, wCells: 4, vector: false, fallbackGlyph: "F" });
    openResolution();
    await slots.drainThumbs();
    await t.renderOnce();

    const img = t.renderer.root.findDescendantById(`${slotId}-t`) as any;
    expect(img).toBeTruthy();
    expect(img.fit).toBe("cover");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a narrower raster centers in its slot (the slot-internal half of hero centering)", async () => {
    // prod thumb slots (grid/list/props hero) are row+center boxes: a raster
    // narrower than the slot must center, not hug the left edge. The props
    // hero tests can only pin the slot-in-row half (drain is faked there) —
    // this pins the raster-in-slot half through the REAL drain.
    const slotId = "tfm-tile-center-thumb";
    t.renderer.root.add(Box({ id: slotId, width: 8, height: 8, flexDirection: "row", justifyContent: "center" }));
    await t.renderOnce();
    const { dir, p } = writePng("narrow.png");
    const slots = mkSlots();
    slots.pushThumbJob({ slotId, path: p, mtimeMs: 1, size: 1, wCells: 4, vector: false, fallbackGlyph: "F" });
    openResolution();
    await slots.drainThumbs();
    await t.renderOnce();

    const img = t.renderer.root.findDescendantById(`${slotId}-t`) as any;
    expect(img).toBeTruthy();
    expect(img.getLayout().width).toBe(4);
    expect(img.getLayout().left).toBe(2); // (8 − 4)/2 — flex-start would be 0
    rmSync(dir, { recursive: true, force: true });
  });

  // A superseded drain must still DELIVER: renderAll fires drainThumbs from
  // several steps back-to-back (grid, preview, props), so overlap is the norm.
  // The old generation bail dropped the losing drain's jobs outright, and
  // renderGrid early-outs on an unchanged listing, so those thumbnails stayed
  // blank until the cwd changed. (Replaces the old "superseded drain drops its
  // job" case — that behaviour WAS the regression.)
  test.skipIf(!hasSvgRenderer)("a scrim-active drain pins icon rasters opaque (content and float alike)", async () => {
    // icons are shaded rather than alpha-faded under the scrim, and the
    // frame-end region bake must skip them. A floating layer's icon sits ABOVE
    // the overlay, so its panel is never dimmed and its raster must not be
    // either — hence the override applies to floats too.
    const slots = mkSlots();
    const content = slots.makeIconSlot("home", [{ fg: FG, bg: BG }], 1, 0);
    const floater = slots.makeIconSlot("home", [{ fg: FG, bg: BG }], 1, 0);
    t.renderer.root.add(Box({ id: "scrim-content-host", width: 8, height: 1 }, content.el));
    t.renderer.root.add(Box({ id: "tfm-menu", width: 8, height: 1 }, floater.el));
    await t.renderOnce();
    openResolution();

    slots.setRasterDim(1, 0.5);
    await slots.drainIconQueue();
    await t.renderOnce();

    const contentImg = t.renderer.root.findDescendantById(`${content.slotId}-s0`) as {
      placementOpacity?: number | null;
    };
    const floatImg = t.renderer.root.findDescendantById(`${floater.slotId}-s0`) as { placementOpacity?: number | null };
    expect(contentImg?.placementOpacity).toBe(1);
    expect(floatImg?.placementOpacity).toBe(1);

    slots.setRasterDim(null, 1);
    await slots.drainIconQueue();
    await t.renderOnce();
    const restored = t.renderer.root.findDescendantById(`${content.slotId}-s0`) as { placementOpacity?: number | null };
    expect(restored?.placementOpacity ?? null).toBeNull();
  });

  test("the scrim exempts mounted float thumbnails but not content ones", async () => {
    // a properties-dialog thumbnail is above the overlay (its panel is not
    // dimmed), so the mounted-thumb walk must opt it out of the frame-end
    // region bake; a content thumbnail keeps inheriting and dims with the tile.
    const slots = mkSlots();
    t.renderer.root.add(
      Box({ id: "tfm-menu", width: 6, height: 4 }, Box({ id: "float-thumb-slot", width: 4, height: 4 })),
    );
    t.renderer.root.add(Box({ id: "content-thumb-slot", width: 4, height: 4 }));
    await t.renderOnce();
    openResolution();
    const { dir, p } = writePng("scrim-scope.png");
    for (const slotId of ["float-thumb-slot", "content-thumb-slot"]) {
      slots.pushThumbJob({ slotId, path: p, mtimeMs: 1, size: 1, wCells: 4, vector: false, fallbackGlyph: "F" });
    }
    await slots.drainThumbs();
    await t.renderOnce();

    slots.setRasterDim(1, 0.5);
    const floatThumb = t.renderer.root.findDescendantById("float-thumb-slot-t") as { placementOpacity?: number | null };
    const contentThumb = t.renderer.root.findDescendantById("content-thumb-slot-t") as {
      placementOpacity?: number | null;
    };
    expect(floatThumb?.placementOpacity).toBe(1);
    expect(contentThumb?.placementOpacity ?? null).toBeNull();

    slots.setRasterDim(null, 1);
    const restored = t.renderer.root.findDescendantById("float-thumb-slot-t") as { placementOpacity?: number | null };
    expect(restored?.placementOpacity ?? null).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a superseded drain still delivers its thumbnail", async () => {
    const slotId = "tfm-tile-live-thumb";
    t.renderer.root.add(Box({ id: slotId, width: 8, height: 8 }));
    await t.renderOnce();
    const { dir, p } = writePng("live.png");
    const slots = mkSlots();
    openResolution();
    slots.pushThumbJob({ slotId, path: p, mtimeMs: 1, size: 1, wCells: 4, vector: false, fallbackGlyph: "F" });

    const superseded = slots.drainThumbs(); // starts the raster, yields
    await slots.drainThumbs(); // newer (empty) drain starts mid-raster
    await superseded;
    await t.renderOnce();

    expect(t.renderer.root.findDescendantById(`${slotId}-t`)).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  // A rebuild replaces the tile's file but keeps the slot id and re-pushes a job
  // for it. The older drain's in-flight raster must NOT paint into the rebuilt
  // slot: pushThumbJob overwrote the slot's ownership key, so the stale image is
  // dropped. The SVG job is deliberately slower (async renderer) than the PNG
  // job (Bun.Image, in-process), so without the guard the stale 4-cell raster
  // lands last and overwrites the fresh 6-cell one.
  test.skipIf(!hasSvgRenderer)("a stale job cannot overwrite a rebuilt slot", async () => {
    const slotId = "tfm-tile-stale-thumb";
    t.renderer.root.add(Box({ id: slotId, width: 8, height: 8 }));
    await t.renderOnce();
    const { dir, p } = writePng("fresh.png");
    const svg = writeSvg("stale.svg");
    const slots = mkSlots();
    openResolution();

    slots.pushThumbJob({ slotId, path: svg.p, mtimeMs: 1, size: 1, wCells: 4, vector: true, fallbackGlyph: "F" });
    const staleDrain = slots.drainThumbs(); // slow SVG raster in flight
    // the rebuild re-pushes the slot's ACTUAL file — this is the ownership flip
    slots.pushThumbJob({ slotId, path: p, mtimeMs: 1, size: 1, wCells: 6, vector: false, fallbackGlyph: "F" });
    const freshDrain = slots.drainThumbs();
    await Promise.all([staleDrain, freshDrain]);
    await t.renderOnce();

    const img = t.renderer.root.findDescendantById(`${slotId}-t`) as any;
    expect(img).toBeTruthy();
    expect(img.width).toBe(6);
    rmSync(dir, { recursive: true, force: true });
    rmSync(svg.dir, { recursive: true, force: true });
  });

  // Regression: renderAll fires drainIconQueue from several steps (sidebar, the
  // iconQueue step, the grid). A per-drain supersession token made the losing
  // drain mark its specs done and then discard the rasters it had built, while
  // the winner's pending snapshot (taken before the loser claimed them) never
  // revisited them — every icon stuck on its fallback glyph until a resize.
  // Serializing the drain must raster every spec the first pass claimed.
  test.skipIf(!hasSvgRenderer)("overlapping drains still raster every icon slot", async () => {
    const slots = mkSlots();
    const slot = slots.makeIconSlot("home", [{ fg: FG, bg: BG }], 1, 0);
    t.renderer.root.add(Box({ id: `${slot.slotId}-host`, width: 8, height: 1 }, slot.el));
    await t.renderOnce();
    openResolution();

    const first = slots.drainIconQueue();
    const second = slots.drainIconQueue(); // starts while `first` is mid-raster
    await Promise.all([first, second]);
    await t.renderOnce();

    expect(t.renderer.root.findDescendantById(`${slot.slotId}-s0`)).toBeTruthy();
  });

  test.skipIf(!hasInproc)("faithful slots drain untinted while plain slots tint", async () => {
    // the About logo must keep its palette: a drain that ignored `faithful`
    // would tint it to the slot fg like every other icon (white on white).
    // heightCells 5 also pins the aspect stretch: the landscape logo fills a
    // 120x100 box (not the square 100x100 the cell-aspect math gives).
    const slots = mkSlots();
    const states = [{ fg: "#9ece6a", bg: BG }];
    const plain = slots.makeIconSlot("tfm", states, 5, 0);
    const faithful = slots.makeIconSlot("tfm", states, 5, 0, undefined, undefined, { faithful: true });
    expect(faithful.spec.faithful).toBe(true);
    expect(plain.spec.faithful).toBeFalsy();
    t.renderer.root.add(Box({ id: "faithful-host", width: 16, height: 5 }, plain.el, faithful.el));
    await t.renderOnce();
    openResolution();

    await slots.drainIconQueue();
    await t.renderOnce();

    const srcOf = (slotId: string): Uint8Array => {
      const img = t.renderer.root.findDescendantById(`${slotId}-s0`) as any;
      expect(img).toBeTruthy();
      return new Uint8Array(img.source);
    };
    const plainSrc = srcOf(plain.slotId);
    const faithfulSrc = srcOf(faithful.slotId);
    expect(Buffer.from(faithfulSrc)).not.toEqual(Buffer.from(plainSrc));
    // pixel math: shadowed 800x480 over the 80x24 test renderer, heightCells 5
    // → wCells round(5*2*1.2274)=12 → 120x100 px, flattened onto BG in opaque
    // mode (no letterbox: the box aspect matches the asset now)
    const { brandPng } = await import("./icons");
    expect(Buffer.from(faithfulSrc)).toEqual(Buffer.from(await brandPng("tfm", 120, 100, BG)));
  });

  test("escHintBtn hover sets pointer, out restores (X buttons are hoverables too)", async () => {
    // regression: the slots ctx was built without setPointer, so every
    // close-X silently hovered with no shape change
    slotPointers.length = 0;
    const slots = mkSlots();
    const btn = slots.escHintBtn("test-x", () => {});
    t.renderer.root.add(btn as never);
    await t.renderOnce();
    const fire = (type: string) =>
      (t.renderer.root.findDescendantById("test-x") as any)?.processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
      });
    fire("move");
    fire("out");
    expect(slotPointers).toEqual(["pointer", "default"]);
  });

  // The terminal pane's X sits on a transparent header under transparent-bg
  // force, but its 3-wide wrapper kept a baked sidebarBg fill — the raster
  // covers only 2 cells, so the padding cell painted one opaque square.
  test("escHintBtn wrapper clears its fill under transparent-bg force", async () => {
    const mkForceSlots = (force: boolean) =>
      makeSlots({
        renderer: () => t.renderer,
        byId: (id) => t.renderer.root.findDescendantById(id),
        colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
        uiStyle: () => "solid",
        iconsMode: () => "opaque",
        transparentForce: () => force,
        iconCells: () => 4,
        glyphFor: () => "F",
        isTtyMode: () => false,
        forceGlyph: () => false,
      });
    const bgOf = (id: string): number[] => {
      const n = t.renderer.root.findDescendantById(id) as any;
      return [...n.backgroundColor.toInts()];
    };
    const plain = mkForceSlots(false).escHintBtn("test-x-plain", () => {});
    t.renderer.root.add(plain as never);
    const forced = mkForceSlots(true).escHintBtn("test-x-force", () => {});
    t.renderer.root.add(forced as never);
    await t.renderOnce();
    // the raster covers 2 of the 3 wrapper cells — the padding cell paints
    // the wrapper fill, so under force it must be alpha-0, not sidebarBg
    expect(bgOf("test-x-plain")).toEqual([26, 27, 38, 255]);
    expect(bgOf("test-x-force")).toEqual([0, 0, 0, 0]);
  });

  test("escHintBtn hover still lights under force, out restores to transparent", async () => {
    const slots = makeSlots({
      renderer: () => t.renderer,
      byId: (id) => t.renderer.root.findDescendantById(id),
      colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
      uiStyle: () => "solid",
      iconsMode: () => "opaque",
      transparentForce: () => true,
      iconCells: () => 4,
      glyphFor: () => "F",
      isTtyMode: () => false,
      forceGlyph: () => false,
    });
    const btn = slots.escHintBtn("test-x-force-hover", () => {});
    t.renderer.root.add(btn as never);
    await t.renderOnce();
    const fire = (type: string) =>
      (t.renderer.root.findDescendantById("test-x-force-hover") as any)?.processMouseEvent({
        type,
        button: 0,
        x: 0,
        y: 0,
        modifiers: { shift: false, alt: false, ctrl: false },
        propagationStopped: false,
        stopPropagation(this: { propagationStopped: boolean }) {
          this.propagationStopped = true;
        },
      });
    fire("move");
    await t.renderOnce();
    expect([...(t.renderer.root.findDescendantById("test-x-force-hover") as any).backgroundColor.toInts()]).toEqual([
      26, 27, 38, 255,
    ]);
    fire("out");
    await t.renderOnce();
    expect([...(t.renderer.root.findDescendantById("test-x-force-hover") as any).backgroundColor.toInts()]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

// The ONE hover wiring every button/row uses. It is deliberately not
// onMouseOver: OpenTUI only emits over/out when the deepest hit node changes,
// so a rebuild under a stationary cursor re-fires a synthetic "over" on the new
// node and the highlight desyncs from the real pointer. It is also guarded, so
// per-pixel moves over a list row can't repaint the whole list.
describe("hoverEvents", () => {
  test("lights up on the first move, clears on out", () => {
    const calls: boolean[] = [];
    const h = hoverEvents((on) => calls.push(on));
    h.onMouseMove();
    h.onMouseOut();
    expect(calls).toEqual([true, false]);
  });

  test("repeated moves are no-ops (an out is required to re-light)", () => {
    const calls: boolean[] = [];
    const h = hoverEvents((on) => calls.push(on));
    h.onMouseMove();
    h.onMouseMove();
    h.onMouseMove();
    expect(calls).toEqual([true]);
    h.onMouseOut();
    h.onMouseOut();
    expect(calls).toEqual([true, false]);
    h.onMouseMove();
    expect(calls).toEqual([true, false, true]);
  });

  test("an out before any move never paints", () => {
    const calls: boolean[] = [];
    const h = hoverEvents((on) => calls.push(on));
    h.onMouseOut();
    expect(calls).toEqual([]);
  });
});

// hoverEvents drives the mouse pointer shape alongside the paint: set on the
// guarded first move, restored to default on out. The guarded flag is what
// keeps per-pixel sweeps from spamming OSC 22.
describe("hoverEvents pointer", () => {
  test("sets the pointer on move, restores default on out", () => {
    const paints: boolean[] = [];
    const pointers: string[] = [];
    const h = hoverEvents(
      (on) => paints.push(on),
      (s) => pointers.push(s),
      "pointer",
    );
    h.onMouseMove();
    h.onMouseOut();
    expect(paints).toEqual([true, false]);
    expect(pointers).toEqual(["pointer", "default"]);
  });

  test("repeated moves emit one pointer set (guarded like paint)", () => {
    const pointers: string[] = [];
    const h = hoverEvents(
      () => {},
      (s) => pointers.push(s),
      "pointer",
    );
    h.onMouseMove();
    h.onMouseMove();
    h.onMouseMove();
    expect(pointers).toEqual(["pointer"]);
  });

  test("supports the text style for inputs", () => {
    const pointers: string[] = [];
    const h = hoverEvents(
      () => {},
      (s) => pointers.push(s),
      "text",
    );
    h.onMouseMove();
    h.onMouseOut();
    expect(pointers).toEqual(["text", "default"]);
  });

  test("an out before any move sets nothing", () => {
    const pointers: string[] = [];
    const h = hoverEvents(
      () => {},
      (s) => pointers.push(s),
    );
    h.onMouseOut();
    expect(pointers).toEqual([]);
  });

  test("absent setter paints exactly like before (old call sites keep working)", () => {
    const paints: boolean[] = [];
    const h = hoverEvents((on) => paints.push(on));
    h.onMouseMove();
    h.onMouseOut();
    expect(paints).toEqual([true, false]);
  });
});

// the wiring's tty-guarded OSC 22 sink: delegates exact styles, dedupes
// repeats (a drag sweep crosses hundreds of tiles — one OSC write, not N),
// and stays silent on the console where no shapes exist (gpm draws its own).
describe("makePointerSetter", () => {
  test("delegates exact styles to the renderer", () => {
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    set("pointer");
    set("text");
    expect(seen).toEqual(["pointer", "text"]);
  });

  test("dedupes repeats (drag sweeps must not spam OSC 22)", () => {
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    set("grabbing");
    set("grabbing");
    set("grabbing");
    expect(seen).toEqual(["grabbing"]);
  });

  test("tty mode is a silent no-op (gpm console has no shapes)", () => {
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => true });
    set("pointer");
    expect(seen).toEqual([]);
  });

  test("dedupe state is per-instance (the app must share one sink)", async () => {
    // two widgets on separate instances diverge: B still believes `pointer`
    // after A emitted `default`, so B's re-set is skipped and the terminal
    // sticks at default. This pins the trap; wireCore shares one instance.
    // NOTE: `default` leaves flush on a microtask — await before asserting.
    const seen: string[] = [];
    const a = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    const b = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    a("pointer");
    b("pointer");
    a("default");
    await Promise.resolve();
    expect(seen).toEqual(["pointer", "pointer", "default"]);
    b("pointer");
    expect(seen).toEqual(["pointer", "pointer", "default"]);
  });

  test("one shared sink heals cross-widget transitions", async () => {
    // tile -> drag-grab on the next widget: the tile's lazy leave is
    // cancelled by the grab claim, so the intermediate default is never
    // emitted (eager would write pointer,default,grabbing,default)
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    const tile = hoverEvents(() => {}, set);
    tile.onMouseMove();
    tile.onMouseOut();
    set("grabbing");
    set("default");
    await Promise.resolve();
    expect(seen).toEqual(["pointer", "grabbing", "default"]);
  });

  test("default leaves are lazy: a same-turn re-enter cancels with zero writes", async () => {
    // icon-edge crossings run out+move in one synchronous turn (the move
    // bubbles from the raster child to the hovered wrapper). Emitting the
    // intermediate default hits the compositor as flicker, so the leave
    // waits a microtask and any re-enter first cancels it.
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    set("pointer");
    set("default"); // out: nothing emitted yet
    expect(seen).toEqual(["pointer"]);
    set("pointer"); // bubbled move in the same turn: cancels; dedupe skips
    await Promise.resolve(); // the re-write (terminal already shows it)
    expect(seen).toEqual(["pointer"]);
  });

  test("a genuine leave flushes default before any frame can run", async () => {
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    set("pointer");
    set("default");
    await Promise.resolve();
    expect(seen).toEqual(["pointer", "default"]);
  });

  test("redundant default emits nothing (ground truth without a write)", async () => {
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    set("default");
    await Promise.resolve();
    expect(seen).toEqual([]);
    set("pointer");
    set("default");
    set("default");
    await Promise.resolve();
    expect(seen).toEqual(["pointer", "default"]);
  });
});

describe("no-drift rule: one home for the icon-slot contract", () => {
  // makeIconSlot's signature used to be re-spelled in a dozen ctx types, and
  // most of them dropped the trailing `opts` (the faithful-brand-art switch)
  // — so a widget could not ask for a multi-color raster through its ctx, and
  // every signature change had to be mirrored by hand in each copy. The
  // contract now lives in ONE type (MakeIconSlot, here in ui-slots); a
  // method-style re-spelling may not come back.
  //
  // The scan covers ALL of src/ (the old rule walked only the FLAT src/ui/
  // directory, so a re-spelling planted in src/wiring/ or src/input/ slipped
  // through). Two spellings count as a re-spelling:
  //   - the CALL form: the identifier opens a parameter list of its own in a
  //     member position — `makeIconSlot(name: string, ...): Handle`. A CALL
  //     never looks like that (calls go through `ctx.makeIconSlot(...)`, and
  //     a destructured local is always assigned first), so the member-position
  //     anchor is what separates the two.
  //   - the BARE REFERENCE form: the identifier is a property whose value is
  //     an inline parameter list — `makeIconSlot: (name: string) => Handle`.
  // The legal spellings never match: the `MakeIconSlot` type reference,
  // `ctx.makeIconSlot(...)` calls, and the `makeIconSlot: ctx.makeIconSlot`
  // forwards.
  test("no module declares its own makeIconSlot parameter list", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const leaf = path.join(root, "ui", "ui-slots.ts");
    const offenders: Array<{ file: string; form: string }> = [];
    for (const file of collectTsFiles(root)) {
      if (file.endsWith(".test.ts")) continue;
      // the leaf owns the one legal spelling of the contract
      if (file === leaf) continue;
      const src = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const rel = path.relative(root, file);
      if (/(?:^|[{;])\s*makeIconSlot\s*\(/m.test(src)) offenders.push({ file: rel, form: "call form" });
      else if (/\bmakeIconSlot\s*:\s*\(/.test(src)) offenders.push({ file: rel, form: "bare reference" });
    }
    expect(offenders).toEqual([]);
  });
});
