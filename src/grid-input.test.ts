import { beforeEach, describe, expect, test } from "bun:test";
import { commitPendingCtrlToggle, finishDragState, gridDrag, makeEntryMouseHandlers, type GridInputCtx } from "./grid-input";

beforeEach(() => {
  gridDrag.keys = null;
  gridDrag.ctrl = false;
  gridDrag.active = false;
  gridDrag.dropTarget = null;
  gridDrag.startX = 0;
  gridDrag.startY = 0;
  gridDrag.pendingKey = null;
  gridDrag.pendingState = false;
});

const makeCtx = (): GridInputCtx & { visuals: Map<string, number>; statuses: string[]; moved: { dest: string; n: number }[]; menus: string[]; logs: string[] } => {
  const visuals = new Map<string, number>();
  const refs = new Map<string, { selected: boolean; isDir: boolean }>();
  for (const [p, isDir] of [["/w/a.txt", false], ["/w/b.txt", false], ["/w/c.txt", false], ["/w/sub", true]] as const) {
    refs.set(p, { selected: false, isDir });
    visuals.set(p, 0);
  }
  const statuses: string[] = [];
  const moved: { dest: string; n: number }[] = [];
  const menus: string[] = [];
  const logs: string[] = [];
  let anchor: number | null = null;
  let focused = 0;
  return {
    visuals,
    statuses,
    moved,
    menus,
    logs,
    byId: () => null,
    termW: () => 80,
    termH: () => 24,
    tileRefs: refs as GridInputCtx["tileRefs"],
    setTileVisual: (key, mode) => void visuals.set(key, mode),
    updateSelectionStatusReal: () => {},
    renderPreview: () => {},
    clearTileSelection: () => { for (const [k, r] of refs) if (r.selected) { r.selected = false; visuals.set(k, 0); } },
    selectRange: (from, to) => {
      const keys = [...refs.keys()];
      const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
      for (let i = lo; i <= hi; i++) { const r = refs.get(keys[i]!); if (r) { r.selected = true; visuals.set(keys[i]!, 2); } }
    },
    getSelAnchor: () => anchor,
    setSelAnchor: (v) => { anchor = v; },
    getFocusIdx: () => focused,
    selPaths: () => [...refs.entries()].filter(([, r]) => r.selected).map(([p, r]) => ({ path: p, isDir: r.isDir })),
    dblClickMs: () => 500,
    navigate: () => {},
    openFileDefault: () => {},
    openContextMenu: (_x, _y, _t, entries) => { menus.push(entries[0]?.label ?? ""); },
    fileEntriesFor: (key) => [{ label: `menu-${key}`, action: () => {} }],
    closeFileMenu: () => {},
    renameEditKey: () => null,
    finishInlineRename: () => {},
    setStatusMsg: (m) => { statuses.push(m); },
    log: (m) => { logs.push(m); },
    moveInto: async (dest, items) => { moved.push({ dest, n: items.length }); },
  };
};

const press = (h: ReturnType<ReturnType<typeof makeEntryMouseHandlers>>, ev: Partial<{ button: number; x: number; y: number; modifiers: Record<string, boolean> }>) =>
  h.onMouseDown({ x: 0, y: 0, button: 0, modifiers: {}, ...ev } as any);

describe("plain click + drag", () => {
  test("click selects single tile and arms drag payload; drop moves it", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 5, y: 5 });
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    expect(gridDrag.keys).toEqual([{ path: "/w/a.txt", isDir: false }]);
    // threshold is >1 cell — 1-cell jitter must NOT start the drag
    h.onMouseDrag({ x: 6, y: 5 } as any);
    expect(gridDrag.active).toBe(false);
    h.onMouseDrag({ x: 8, y: 5 } as any);
    expect(gridDrag.active).toBe(true);
    expect(ctx.statuses.at(-1)).toBe("Dragging 1 item…");
    // hover over a folder arms the drop target
    (makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3)).onMouseOver();
    expect(gridDrag.dropTarget).toBe("/w/sub");
    // drop fires on the TARGET tile's handler (isDir=true there), filtering the dest itself
    (makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3)).onMouseDrop();
    expect(ctx.moved).toEqual([{ dest: "/w/sub", n: 1 }]);
    expect(gridDrag.keys).toBeNull();
    expect(gridDrag.active).toBe(false);
  });
});

describe("deferred ctrl toggle (the moved-0-items regression)", () => {
  test("ctrl+click toggles at mouseup without movement", async () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { modifiers: { ctrl: true } });
    // NOT toggled at mousedown — selection state untouched
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(false);
    h.onMouseUp();
    // toggle fires synchronously; drag-state cleanup is deferred a tick
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    await Bun.sleep(2);
    expect(gridDrag.keys).toBeNull();
  });

  test("ctrl+press then drag: toggle is cancelled, payload keeps the pressed tile", () => {
    const ctx = makeCtx();
    // pre-select b and c
    ctx.tileRefs.get("/w/b.txt")!.selected = true;
    ctx.tileRefs.get("/w/c.txt")!.selected = true;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 5, y: 5, modifiers: { ctrl: true } });
    expect(gridDrag.pendingKey).toBe("/w/a.txt");
    h.onMouseDrag({ x: 9, y: 9 } as any); // past threshold -> becomes a drag
    expect(gridDrag.pendingKey).toBeNull();
    expect(gridDrag.active).toBe(true);
    expect(gridDrag.keys!.map((k) => k.path).sort()).toEqual(["/w/a.txt", "/w/b.txt", "/w/c.txt"]);
    // drag marked unselected payload tiles as selected
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    h.onMouseUp();
    // toggle must NOT have fired
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
  });
});

describe("selection model", () => {
  test("plain click on selected tile of a multi-selection keeps the group", () => {
    const ctx = makeCtx();
    ctx.tileRefs.get("/w/a.txt")!.selected = true;
    ctx.tileRefs.get("/w/b.txt")!.selected = true;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 3, y: 3 });
    expect(ctx.selPaths().map((p) => p.path).sort()).toEqual(["/w/a.txt", "/w/b.txt"]);
  });

  test("shift+click range-extends from anchor", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/c.txt", 2);
    press(h, { modifiers: { shift: true } });
    expect(ctx.selPaths().length).toBe(3);
  });

  test("right-click selects an unselected tile and opens its menu", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/b.txt", 1);
    press(h, { button: 2, x: 4, y: 4 });
    expect(ctx.tileRefs.get("/w/b.txt")!.selected).toBe(true);
    expect(ctx.menus).toEqual(["menu-/w/b.txt"]);
  });

  test("double-click opens (dir navigates) and resets lastClick", () => {
    const ctx = makeCtx();
    let navigated: string[] = [];
    ctx.navigate = (d) => { navigated.push(d); };
    const factory = makeEntryMouseHandlers(ctx);
    const h = factory({ isDir: true }, "/w/sub", 3);
    press(h, { x: 1, y: 1 });
    press(h, { x: 1, y: 1 });
    expect(navigated).toEqual(["/w/sub"]);
  });
});

describe("commitPendingCtrlToggle / finishDragState", () => {
  test("commit applies pendingState only when no drag became active", () => {
    const ctx = makeCtx();
    gridDrag.pendingKey = "/w/a.txt";
    gridDrag.pendingState = true;
    gridDrag.active = true; // mid-drag: never commit
    commitPendingCtrlToggle(ctx);
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(false);
    // commit consumed the key even while active — a fresh press re-arms it
    gridDrag.pendingKey = "/w/a.txt";
    gridDrag.pendingState = true;
    gridDrag.active = false;
    commitPendingCtrlToggle(ctx);
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
  });

  test("finishDragState clears everything and un-highlights a non-selected target", () => {
    const ctx = makeCtx();
    gridDrag.active = true;
    gridDrag.dropTarget = "/w/sub";
    gridDrag.keys = [{ path: "/w/a.txt", isDir: false }];
    finishDragState(ctx);
    expect(gridDrag.active).toBe(false);
    expect(gridDrag.keys).toBeNull();
    expect(gridDrag.dropTarget).toBeNull();
    expect(gridDrag.ctrl).toBe(false);
    expect(ctx.visuals.get("/w/sub")).toBe(0);
  });
});
