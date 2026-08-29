import { describe, expect, test } from "bun:test";
import { makeHitTargetAt } from "./hit-target";

// fake renderable chain: child nodes link to parents via .parent
const node = (id: string | undefined, parent?: any): any => ({ id, parent });

const mkCtx = (chain: any, hitNum: number | null = 7) => {
  const registry = new Map<number, any>([[7, chain]]);
  return {
    ctx: {
      hitTest: (_x: number, _y: number) => hitNum,
      byNumber: (num: number) => registry.get(num),
      placesHost: () => [{ place: { path: "/media/usb" } }, { place: {} }],
      tileRefs: new Map<string, any>([
        ["/home/a", { selected: true, baseFg: "", tileId: "tfm-tile-0", isDir: true }],
        ["/home/b.txt", { selected: false, baseFg: "", tileId: "tfm-tile-1", isDir: false }],
      ]),
    },
  };
};

describe("makeHitTargetAt", () => {
  test("missed hit test returns null", () => {
    const { ctx } = mkCtx(node("tfm-tile-0"), null);
    expect(makeHitTargetAt(ctx)(3, 3, null)).toBeNull();
  });

  test("walks up the chain: deep child resolves to its tile", () => {
    const leaf = node("tfm-tile-0-label", node("tfm-tile-0"));
    const { ctx } = mkCtx(leaf);
    const hit = makeHitTargetAt(ctx);
    expect(hit(3, 3, null)).toEqual({ kind: "folder", path: "/home/a" });
  });

  test("file tile is not a drop target", () => {
    const { ctx } = mkCtx(node("tfm-tile-1"));
    expect(makeHitTargetAt(ctx)(3, 3, null)).toBeNull();
  });

  test("dropping onto a tile being dragged is rejected (self-drop)", () => {
    const { ctx } = mkCtx(node("tfm-tile-0"));
    expect(makeHitTargetAt(ctx)(3, 3, ["/home/a"])).toBeNull();
  });

  test("place row resolves to the place path", () => {
    const { ctx } = mkCtx(node("tfm-place-0"));
    expect(makeHitTargetAt(ctx)(3, 3, null)).toEqual({ kind: "place", path: "/media/usb" });
  });

  test("place record without a path resolves to null", () => {
    const { ctx } = mkCtx(node("tfm-place-1"));
    expect(makeHitTargetAt(ctx)(3, 3, null)).toBeNull();
  });

  test("out-of-range place index resolves to null", () => {
    const { ctx } = mkCtx(node("tfm-place-9"));
    expect(makeHitTargetAt(ctx)(3, 3, null)).toBeNull();
  });

  test("non-tfm ids walk past to the parent", () => {
    const inner = node("tfm-tile-0", node(undefined, node("tfm-scroller")));
    const { ctx } = mkCtx(inner);
    expect(makeHitTargetAt(ctx)(3, 3, null)).toEqual({ kind: "folder", path: "/home/a" });
  });

  test("chain with no match ends null", () => {
    const { ctx } = mkCtx(node("tfm-scroller", node(undefined)));
    expect(makeHitTargetAt(ctx)(3, 3, null)).toBeNull();
  });
});
