import { describe, expect, test } from "bun:test";
import { dimHex, makeSlots, type SlotsCtx } from "./ui-slots";
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
  const ctx: SlotsCtx = {
    renderer: () => ({ resolution: { width: 800, height: 400 }, terminalWidth: 80, terminalHeight: 20 }),
    byId: (id) => nodes.get(id),
    clearChildren: () => {},
    colors: () => ({ bg: BG, sidebarFgMuted: FG, sidebarBg: BG, hoverBg: BG, white: "#fff" }) as unknown as Theme,
    uiStyle: () => "solid",
    iconsTransparent: () => false,
    iconCells: () => 3,
    modalOpen: () => modalUp,
    glyphFor: () => "F",
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

  return { slots, nodes, mountFakeSlot, setModal: (v: boolean) => (modalUp = v) };
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
});
