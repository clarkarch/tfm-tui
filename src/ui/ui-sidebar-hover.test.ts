import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeSidebarHover, type SidebarHoverOpts, type SidebarRowRef } from "./ui-sidebar-hover";

// Per-row hover nudge for EVERY sidebar row (places, pins, devices, network):
// hovering lifts the row's icon one cell in the configured direction, exactly
// like the tile hover lift — paint (bg/icon/label colors) stays owned by
// normalizePlaces, this module owns ONLY the lift translate.

const setup = (
  over: Partial<SidebarHoverOpts> = {},
  rows: Array<{ key: string; selected?: boolean }> = [{ key: "tfm-place-0" }],
) => {
  const nodes = new Map<string, any>();
  const refs = new Map<string, SidebarRowRef>();
  for (const r of rows) {
    const rowId = r.key;
    const iconSlotId = `${rowId}-icon`;
    const labelId = `${rowId}-label`;
    nodes.set(rowId, { id: rowId });
    nodes.set(iconSlotId, { translateX: 0, translateY: 0 });
    nodes.set(labelId, { translateX: 0, translateY: 0 });
    refs.set(rowId, { rowId, iconSlotId, labelId, selected: r.selected ?? false });
  }
  let o: SidebarHoverOpts = { enabled: true, direction: "left", includeLabel: false, ...over };
  const hover = makeSidebarHover({
    byId: (id: string) => nodes.get(id) ?? null,
    rowRefs: () => refs,
    hoverOpts: () => o,
  });
  return {
    hover,
    nodes,
    refs,
    setOpts: (next: SidebarHoverOpts) => {
      o = next;
    },
  };
};

describe("makeSidebarHover", () => {
  test("hover-in lifts the icon one cell left, the label stays", () => {
    const { hover, nodes } = setup();
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(-1);
    expect((nodes.get("tfm-place-0-icon") as any).translateY).toBe(0);
    expect((nodes.get("tfm-place-0-label") as any).translateX).toBe(0);
  });

  test("direction right mirrors the nudge", () => {
    const { hover, nodes } = setup({ direction: "right" });
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(1);
    expect((nodes.get("tfm-place-0-icon") as any).translateY).toBe(0);
  });

  test("includeLabel rides the label along; out restores both", () => {
    const { hover, nodes } = setup({ direction: "right", includeLabel: true });
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-label") as any).translateX).toBe(1);
    hover.playHover("tfm-place-0", false);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(0);
    expect((nodes.get("tfm-place-0-label") as any).translateX).toBe(0);
  });

  test("a selected (cwd) row never lifts — selection owns it", () => {
    const { hover, nodes } = setup({}, [{ key: "tfm-place-0", selected: true }]);
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(0);
  });

  test("disabled never lifts and drops a lift owned when it was on", () => {
    const { hover, nodes, setOpts } = setup();
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(-1);
    setOpts({ enabled: false, direction: "left", includeLabel: false });
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(0);
  });

  test("sweeping to a second row settles the first instantly", () => {
    const { hover, nodes } = setup({}, [{ key: "tfm-place-0" }, { key: "tfm-place-1" }]);
    hover.playHover("tfm-place-0", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(-1);
    hover.playHover("tfm-place-1", true);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(0);
    expect((nodes.get("tfm-place-1-icon") as any).translateX).toBe(-1);
  });

  test("out on a key we don't own is a no-op (never throws, never moves)", () => {
    const { hover, nodes } = setup({}, [{ key: "tfm-place-0" }, { key: "tfm-place-1" }]);
    hover.playHover("tfm-place-0", true);
    hover.playHover("tfm-place-1", false);
    expect((nodes.get("tfm-place-0-icon") as any).translateX).toBe(-1);
    expect((nodes.get("tfm-place-1-icon") as any).translateX).toBe(0);
  });

  test("an unknown key is a no-op", () => {
    const { hover } = setup();
    expect(() => hover.playHover("tfm-place-99", true)).not.toThrow();
    expect(() => hover.playHover("tfm-place-99", false)).not.toThrow();
  });

  test("a rebuilt row (stale node) is never written to", () => {
    const { hover, nodes, refs } = setup();
    const oldIcon = nodes.get("tfm-place-0-icon");
    hover.playHover("tfm-place-0", true);
    expect(oldIcon.translateX).toBe(-1);
    // sidebar rebuilt under the stationary cursor: fresh nodes, same ids
    const freshIcon = { translateX: 0, translateY: 0 };
    nodes.set("tfm-place-0-icon", freshIcon);
    nodes.set("tfm-place-0", { id: "tfm-place-0" });
    // the synthetic re-over presses the NEW row instead of settling the dead one
    hover.playHover("tfm-place-0", true);
    expect(oldIcon.translateX).toBe(-1); // untouched after abandonment
    expect(freshIcon.translateX).toBe(-1);
    expect(refs.get("tfm-place-0")!.rowId).toBe("tfm-place-0");
  });
});

// real renderables: the translate lands on the live icon slot and clears on out
describe("makeSidebarHover (engine)", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 60, height: 20 });
    await t.renderOnce();
  });
  afterAll(() => t.renderer.destroy());

  test("hover lifts the live icon slot one cell, out restores it", async () => {
    t.renderer.root.add(Box({ id: "sh-row", width: 20, height: 1 }));
    t.renderer.root.add(Box({ id: "sh-icon", width: 2, height: 1 }));
    await t.renderOnce();
    const byId = (id: string) => t.renderer.root.findDescendantById(id);
    const refs = new Map<string, SidebarRowRef>([
      ["sh-row", { rowId: "sh-row", iconSlotId: "sh-icon", labelId: "sh-label", selected: false }],
    ]);
    const hover = makeSidebarHover({
      byId,
      rowRefs: () => refs,
      hoverOpts: () => ({ enabled: true, direction: "left", includeLabel: false }),
    });
    hover.playHover("sh-row", true);
    await t.renderOnce();
    expect((byId("sh-icon") as any).translateX).toBe(-1);
    hover.playHover("sh-row", false);
    await t.renderOnce();
    expect((byId("sh-icon") as any).translateX).toBe(0);
  });
});
