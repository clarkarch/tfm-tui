import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, type CliRenderer } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  dimHex,
  hoverEvents,
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
const hasSvgRenderer = Bun.which("resvg") !== null || Bun.which("rsvg-convert") !== null;

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
  let ttyMode = false;
  let forceGlyph = false;
  const ctx: SlotsCtx = {
    renderer: () =>
      ({ resolution: { width: 800, height: 400 }, terminalWidth: 80, terminalHeight: 20 }) as unknown as CliRenderer,
    byId: (id) => nodes.get(id),
    colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
    uiStyle: () => "solid",
    iconsMode: () => "opaque",
    iconCells: () => 3,
    modalOpen: () => modalUp,
    glyphFor: () => "F",
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
    setModal: (v: boolean) => (modalUp = v),
    setTtyMode: (v: boolean) => (ttyMode = v),
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
  afterAll(() => {
    t.renderer.destroy();
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
      modalOpen: () => false,
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

  // A superseded drain must still DELIVER: renderAll fires drainThumbs from
  // several steps back-to-back (grid, preview, props), so overlap is the norm.
  // The old generation bail dropped the losing drain's jobs outright, and
  // renderGrid early-outs on an unchanged listing, so those thumbnails stayed
  // blank until the cwd changed. (Replaces the old "superseded drain drops its
  // job" case — that behaviour WAS the regression.)
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
  // dropped. The SVG job is deliberately slower (spawned renderer) than the PNG
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

  test("dedupe state is per-instance (the app must share one sink)", () => {
    // two widgets on separate instances diverge: B still believes `pointer`
    // after A emitted `default`, so B's re-set is skipped and the terminal
    // sticks at default. This pins the trap; wireCore shares one instance.
    const seen: string[] = [];
    const a = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    const b = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    a("pointer");
    b("pointer");
    a("default");
    b("pointer");
    expect(seen).toEqual(["pointer", "pointer", "default"]);
  });

  test("one shared sink heals cross-widget transitions", () => {
    // tile -> toolbar button: out restores, the next widget's move re-sets
    // through the same `last`, so no transition is ever skipped
    const seen: string[] = [];
    const set = makePointerSetter({ setMousePointer: (s) => seen.push(s), isTtyMode: () => false });
    const tile = hoverEvents(() => {}, set);
    const button = hoverEvents(() => {}, set);
    tile.onMouseMove();
    tile.onMouseOut();
    button.onMouseMove();
    button.onMouseOut();
    expect(seen).toEqual(["pointer", "default", "pointer", "default"]);
  });
});
