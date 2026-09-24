import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { dimHex, makeSlots, thumbImageFit, thumbJobRank, type SlotsCtx, type ThumbJob } from "./ui-slots";
import type { Theme } from "../config/config";

// The scrim (setScrim) must cover every RASTERED slot, including ones whose
// raster finished before the modal opened. The old queue pruned drained
// specs at the end of each drain, so setScrim iterated an (almost) empty
// queue: kitty rasters rendered just before a modal opened floated over the
// menu, and resetIconQueue could no longer re-queue drained slots for
// theme-flip re-rasters. The drain's raster step is intentionally pointed at
// a missing icon name — the raster fails cleanly without spawning anything,
// but done+prune still run, which is exactly the regression path.

const FG = "#c0caf5";
const BG = "#1a1b26";

const makeHarness = () => {
  const nodes = new Map<string, any>();
  let modalUp = false;
  let compat = false;
  let forceGlyph = false;
  const ctx: SlotsCtx = {
    renderer: () => ({ resolution: { width: 800, height: 400 }, terminalWidth: 80, terminalHeight: 20 }),
    byId: (id) => nodes.get(id),
    clearChildren: () => {},
    colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
    uiStyle: () => "solid",
    iconsMode: () => "opaque",
    iconCells: () => 3,
    modalOpen: () => modalUp,
    glyphFor: () => "F",
    compatActive: () => compat,
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
    setModal: (v: boolean) => (modalUp = v),
    setCompat: (v: boolean) => (compat = v),
    setForceGlyph: (v: boolean) => (forceGlyph = v),
  };
};

describe("icon slot scrim", () => {
  test("setScrim dims a raster drained BEFORE the modal opened and restores it on close", async () => {
    const h = makeHarness();
    const s = h.slots.makeIconSlot("no-such-icon-xyz", [{ fg: FG, bg: BG }], 1, 0);
    const { glyph, img } = h.mountFakeSlot(s.spec);

    await h.slots.drainIconQueue(); // raster fails (missing asset) — done+prune still run
    h.setModal(true);
    h.slots.setScrim(true);

    expect(img.visible).toBe(false);
    expect(glyph.visible).toBe(true);
    expect(glyph.fg).toBe(dimHex(FG, 0.41));

    h.slots.setScrim(false);
    expect(img.visible).toBe(true);
    expect(glyph.visible).toBe(false);
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

  test("compat mode drains nothing: specs stay pending, thumb jobs are dropped", async () => {
    // the linux console has no graphics protocol, so every raster spawn would
    // fail, and the drains no-op with the glyph slots staying as built
    const h = makeHarness();
    h.setCompat(true);
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
    h.setCompat(false);
    await h.slots.drainIconQueue();
    expect(s.spec.done).toBe(true);
  });

  test("force glyph drains nothing (buggy kitty impl) without forcing compat", async () => {
    // same raster skip as compat, but the terminal is modern: view mode,
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

  beforeAll(async () => {
    // box the disk cache for this file, like icons.test.ts — drainThumbs →
    // thumbPng would otherwise write into (or be served a disk hit from) the
    // real ~/.cache/tfm/thumbs
    cacheSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-slots-cache-"));
    process.env.XDG_CACHE_HOME = cacheSandbox;
    t = await createTestRenderer({ width: 80, height: 24 });
  });
  afterAll(() => {
    t.renderer.destroy();
    if (REAL_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = REAL_CACHE_HOME;
    rmSync(cacheSandbox, { recursive: true, force: true });
  });

  test('a drained raster thumb mounts with fit:"cover"', async () => {
    const slotId = "tfm-tile-0-thumb";
    t.renderer.root.add(Box({ id: slotId, width: 8, height: 8 }));
    await t.renderOnce();

    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-slots-thumb-"));
    const p = path.join(dir, "wide.png");
    writeFileSync(p, Buffer.from(PNG_6x2, "base64"));

    const ctx: SlotsCtx = {
      renderer: () => t.renderer,
      byId: (id) => t.renderer.root.findDescendantById(id),
      clearChildren: () => {},
      colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
      uiStyle: () => "solid",
      iconsMode: () => "opaque",
      iconCells: () => 4,
      modalOpen: () => false,
      glyphFor: () => "F",
      compatActive: () => false,
      forceGlyph: () => false,
    };
    const slots = makeSlots(ctx);
    slots.pushThumbJob({ slotId, path: p, mtimeMs: 1, size: 1, wCells: 4, vector: false, fallbackGlyph: "F" });
    // the headless renderer's resolution getter is readonly and null (real
    // pixels come from the live terminal); shadow it so drainThumbs'
    // cell-metrics gate opens
    Object.defineProperty(t.renderer, "resolution", { value: { width: 800, height: 480 }, configurable: true });
    await slots.drainThumbs();
    await t.renderOnce();

    const img = t.renderer.root.findDescendantById(`${slotId}-t`) as any;
    expect(img).toBeTruthy();
    expect(img.fit).toBe("cover");
    rmSync(dir, { recursive: true, force: true });
  });
});
