import { beforeEach, describe, expect, test } from "bun:test";
import {
  BAND_ID,
  beginBand,
  cancelBands,
  commitPendingCtrlToggle,
  endBand,
  finishDragState,
  makeEntryMouseHandlers,
  updateBandRect,
  type BandCtx,
  type BandPhase,
  type GridInputCtx,
} from "./grid-input";
import { archiveUri } from "../fs/archive-scheme";
import {
  dispatchDrag,
  dragActive,
  dragDropTarget,
  dragKeys,
  dragPending,
  dragState,
  resetDragState,
} from "../lib/drag-state";

beforeEach(() => {
  resetDragState();
});

const makeCtx = (): GridInputCtx & {
  visuals: Map<string, number>;
  statuses: string[];
  moved: { dest: string; n: number }[];
  menus: string[];
  logs: string[];
  selStatusRefreshes: { n: number };
  focusCalls: { n: number };
  blurCalls: { n: number };
  blurSidebarCalls: { n: number };
  hoverCalls: [string, boolean][];
  pointers: string[];
  focusState: { path: string | null; anchorPath: string | null };
  bandCancels: { n: number };
} => {
  const visuals = new Map<string, number>();
  const refs = new Map<string, { selected: boolean; isDir: boolean }>();
  for (const [p, isDir] of [
    ["/w/a.txt", false],
    ["/w/b.txt", false],
    ["/w/c.txt", false],
    ["/w/sub", true],
  ] as const) {
    refs.set(p, { selected: false, isDir });
    visuals.set(p, 0);
  }
  const statuses: string[] = [];
  const moved: { dest: string; n: number }[] = [];
  const menus: string[] = [];
  const logs: string[] = [];
  const selStatus = { n: 0 };
  const focusCalls = { n: 0 };
  const blurCalls = { n: 0 };
  const blurSidebarCalls = { n: 0 };
  const hoverCalls: [string, boolean][] = [];
  const pointers: string[] = [];
  // the focus is a FILE (the real selection module's contract): the fake
  // mirrors it — the anchor is resolved AND pinned by ONE rule, a plain move
  // re-anchors, a range move keeps its own origin
  const focusState = { path: null as string | null, anchorPath: null as string | null };
  const bandCancels = { n: 0 };
  const keys = (): string[] => [...refs.keys()];
  return {
    visuals,
    statuses,
    moved,
    menus,
    logs,
    selStatusRefreshes: selStatus,
    focusCalls,
    blurCalls,
    blurSidebarCalls,
    hoverCalls,
    pointers,
    focusState,
    bandCancels,
    setPointer: (s) => void pointers.push(s),
    cancelBand: () => {
      bandCancels.n++;
    },
    byId: () => null,
    termW: () => 80,
    termH: () => 24,
    tileRefs: refs as GridInputCtx["tileRefs"],
    setTileVisual: (key, mode) => void visuals.set(key, mode),
    hoverAnim: (key, hovered) => void hoverCalls.push([key, hovered]),
    updateSelectionStatusReal: () => {
      selStatus.n++;
    },
    renderPreview: () => {},
    clearTileSelection: () => {
      for (const [k, r] of refs)
        if (r.selected) {
          r.selected = false;
          visuals.set(k, 0);
        }
    },
    selectRange: (from, to) => {
      const keys = [...refs.keys()];
      const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
      for (let i = lo; i <= hi; i++) {
        const r = refs.get(keys[i]!);
        if (r) {
          r.selected = true;
          visuals.set(keys[i]!, 2);
        }
      }
    },
    ensureAnchor: () => {
      const pinned = focusState.anchorPath !== null ? keys().indexOf(focusState.anchorPath) : -1;
      if (pinned >= 0) return pinned;
      if (focusState.path !== null) {
        const focused = keys().indexOf(focusState.path);
        if (focused >= 0) {
          focusState.anchorPath = focusState.path;
          return focused;
        }
      }
      const first = keys()[0];
      if (first !== undefined) focusState.anchorPath = first;
      return 0;
    },
    setFocusPath: (path, opts) => {
      focusState.path = path;
      if (!opts?.keepAnchor) focusState.anchorPath = path;
    },
    selPaths: () => [...refs.entries()].filter(([, r]) => r.selected).map(([p, r]) => ({ path: p, isDir: r.isDir })),
    dblClickMs: () => 500,
    navigate: () => {},
    openFileDefault: () => {},
    openContextMenu: (_x, _y, _t, entries) => {
      menus.push(entries[0]?.label ?? "");
    },
    fileEntriesFor: (key) => [{ label: `menu-${key}`, action: () => {} }],
    closeFileMenu: () => {},
    renameEditKey: () => null,
    finishInlineRename: () => {},
    setStatusMsg: (m) => {
      statuses.push(m);
    },
    log: (m) => {
      logs.push(m);
    },
    moveInto: async (dest, items) => {
      moved.push({ dest, n: items.length });
    },
    focusPane: () => {
      focusCalls.n++;
    },
    blurTerminal: () => {
      blurCalls.n++;
    },
    blurSidebar: () => {
      blurSidebarCalls.n++;
    },
  };
};

const press = (
  h: ReturnType<ReturnType<typeof makeEntryMouseHandlers>>,
  ev: Partial<{ button: number; x: number; y: number; modifiers: Record<string, boolean> }>,
) => h.onMouseDown({ x: 0, y: 0, button: 0, modifiers: {}, ...ev } as any);

describe("dual-pane focus", () => {
  test("a tile press focuses its pane before any selection work", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, {});
    press(h, { button: 2 });
    expect(ctx.focusCalls.n).toBe(2);
  });

  test("a tile press blurs the embedded terminal (stale ownsKeyboard lock)", () => {
    // tile mousedown stops propagation, so the scroller's blurTerminal never
    // runs — without this explicit call a focused terminal's termFocused flag
    // stays true and every key is swallowed with a lying "Terminal owns
    // keyboard" toast
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, {});
    expect(ctx.blurCalls.n).toBe(1);
  });

  test("a tile press hands the keyboard back to the grid", () => {
    // the sidebar swallows EVERY key while it has keyboard focus (the
    // keyboard lives there until something else takes it). Clicking a file
    // is that something — without this the keyboard stayed in the sidebar
    // and j/k/enter did nothing in the grid.
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, {});
    expect(ctx.blurSidebarCalls.n).toBe(1);
  });
});

describe("cross-pane internal drag (shared drag state, per-pane ctxs)", () => {
  test("a file dragged from pane A drops into pane B's folder", () => {
    const src = makeCtx();
    const dst = makeCtx();
    const hSrc = makeEntryMouseHandlers(src)({ isDir: false }, "/w/a.txt", 0);
    const hDst = makeEntryMouseHandlers(dst)({ isDir: true }, "/w/sub", 3);
    press(hSrc, {});
    hSrc.onMouseDrag({ x: 9, y: 9 } as any);
    expect(dragActive(dragState())).toBe(true);
    // the drop lands on the target tile itself; the destination comes from that
    // tile's own key, NOT from dragDropTarget(dragState()) (which over may never set)
    hDst.onMouseDrop();
    expect(dst.moved).toEqual([{ dest: "/w/sub", n: 1 }]);
  });
});

describe("plain click + drag", () => {
  test("click selects single tile and arms drag payload; drop moves it", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 5, y: 5 });
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    expect(dragKeys(dragState())).toEqual([{ path: "/w/a.txt", isDir: false }]);
    // threshold is >1 cell — 1-cell jitter must NOT start the drag
    h.onMouseDrag({ x: 6, y: 5 } as any);
    expect(dragActive(dragState())).toBe(false);
    h.onMouseDrag({ x: 8, y: 5 } as any);
    expect(dragActive(dragState())).toBe(true);
    expect(ctx.statuses.at(-1)).toBe("Dragging 1 item…");
    // hover over a folder arms the drop target
    makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3).onMouseOver();
    expect(dragDropTarget(dragState())).toBe("/w/sub");
    // drop fires on the TARGET tile's handler (isDir=true there), filtering the dest itself
    makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3).onMouseDrop();
    expect(ctx.moved).toEqual([{ dest: "/w/sub", n: 1 }]);
    expect(dragKeys(dragState())).toBeNull();
    expect(dragActive(dragState())).toBe(false);
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
    // settle the deferred cleanup via the observable state (never a bare sleep)
    for (let i = 0; i < 50 && dragKeys(dragState()); i++) await Bun.sleep(1);
    expect(dragKeys(dragState())).toBeNull();
  });

  test("ctrl+press then drag: toggle is cancelled, payload keeps the pressed tile", async () => {
    const ctx = makeCtx();
    // pre-select b and c
    ctx.tileRefs.get("/w/b.txt")!.selected = true;
    ctx.tileRefs.get("/w/c.txt")!.selected = true;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 5, y: 5, modifiers: { ctrl: true } });
    expect(dragPending(dragState())).toEqual({ key: "/w/a.txt", state: true });
    h.onMouseDrag({ x: 9, y: 9 } as any); // past threshold -> becomes a drag
    // the trip DROPS the pending toggle — it became a drag
    expect(dragPending(dragState())).toBeNull();
    expect(dragActive(dragState())).toBe(true);
    expect(
      dragKeys(dragState())!
        .map((k) => k.path)
        .sort(),
    ).toEqual(["/w/a.txt", "/w/b.txt", "/w/c.txt"]);
    // drag marked unselected payload tiles as selected
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    h.onMouseUp();
    // toggle must NOT have fired
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    // settle the deferred cleanup — a leaked timer would fire mid-next-test
    // and clear the shared drag state out from under it
    for (let i = 0; i < 50 && dragKeys(dragState()); i++) await Bun.sleep(1);
    expect(dragKeys(dragState())).toBeNull();
  });
});

describe("selection model", () => {
  test("a ctrl+press whose mouseup never arrives does not leak its toggle into the next gesture", () => {
    // the ctrl+press arms a DEFERRED toggle; if the release never reaches a
    // tile (released over the sidebar/preview), the pending toggle used to
    // survive and fire on the NEXT gesture's mouseup — toggling a file the
    // user never clicked
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { modifiers: { ctrl: true } });
    // ... no mouseup for that press
    const h2 = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/b.txt", 1);
    press(h2, {});
    h2.onMouseUp();
    expect(ctx.tileRefs.get("/w/b.txt")!.selected).toBe(true);
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(false);
  });

  test("a ctrl+press released without motion applies the toggle EXACTLY once", async () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { modifiers: { ctrl: true } });
    // the press itself refreshes the status (provisional payload)
    expect(ctx.selStatusRefreshes.n).toBe(1);
    h.onMouseUp();
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    // the toggle applied ONCE (one more status refresh, not two)
    expect(ctx.selStatusRefreshes.n).toBe(2);
    // settle the deferred cleanup — a leaked timer would fire mid-next-test
    for (let i = 0; i < 50 && dragKeys(dragState()); i++) await Bun.sleep(1);
  });

  test("plain click moves the keyboard focus (shift+arrow extends from the click)", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/c.txt", 2);
    press(h, { x: 3, y: 3 });
    expect(ctx.focusState.path).toBe("/w/c.txt");
  });

  test("shift+click range moves the keyboard focus to the clicked tile", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/c.txt", 2);
    press(h, { modifiers: { shift: true } });
    // the next shift+down computes its endpoint from THIS tile, not a stale idx
    expect(ctx.focusState.path).toBe("/w/c.txt");
    // the range origin stays at the first tile (the focus was nowhere before)
    expect(ctx.focusState.anchorPath).toBe("/w/a.txt");
  });
  test("plain click on selected tile of a multi-selection keeps the group", () => {
    const ctx = makeCtx();
    ctx.tileRefs.get("/w/a.txt")!.selected = true;
    ctx.tileRefs.get("/w/b.txt")!.selected = true;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 3, y: 3 });
    expect(
      ctx
        .selPaths()
        .map((p) => p.path)
        .sort(),
    ).toEqual(["/w/a.txt", "/w/b.txt"]);
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

  test("double-click opens (dir navigates) and re-arms the window", () => {
    const ctx = makeCtx();
    const navigated: string[] = [];
    ctx.navigate = (d) => {
      navigated.push(d);
    };
    const factory = makeEntryMouseHandlers(ctx);
    const h = factory({ isDir: true }, "/w/sub", 3);
    press(h, { x: 1, y: 1 });
    press(h, { x: 1, y: 1 });
    expect(navigated).toEqual(["/w/sub"]);
  });
  test("double-click on an archive enters its archive cwd, never xdg-open", () => {
    const ctx = makeCtx();
    const navigated: string[] = [];
    ctx.navigate = (d) => {
      navigated.push(d);
    };
    const opened: string[] = [];
    ctx.openFileDefault = (p) => opened.push(p);
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.zip", 0);
    press(h, { x: 1, y: 1 });
    press(h, { x: 1, y: 1 });
    expect(navigated).toEqual([archiveUri("/w/a.zip")]);
    expect(opened).toEqual([]);
  });
  test("a modified double-press never opens (ctrl stays toggle)", () => {
    // regression: two fast ctrl+clicks on a tile toggled it on then off and
    // launched the file (the double-click check ignored modifiers)
    const ctx = makeCtx();
    const opened: string[] = [];
    ctx.openFileDefault = (p) => opened.push(p);
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { modifiers: { ctrl: true }, x: 1, y: 1 });
    press(h, { modifiers: { ctrl: true }, x: 1, y: 1 });
    expect(opened).toEqual([]);
    // an unmodified double press still opens
    press(h, { x: 1, y: 1 });
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual(["/w/a.txt"]);
  });

  test("the double-click window is decided by the injected clock", () => {
    // The wall clock made the window untestable AND unsafe: `lastClick = 0`
    // doubled as "never clicked" and as a real instant, and a backwards step
    // (NTP) made the delta negative. The clock comes from the ctx now.
    const ctx = makeCtx();
    let now = 1000;
    ctx.now = () => now;
    const opened: string[] = [];
    ctx.openFileDefault = (p) => opened.push(p);
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual([]);
    // the second click lands OUTSIDE the window (500ms) → no open, and the
    // press re-arms the window
    now += 1000;
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual([]);
    // the next click is inside the window → the double-click opens
    now += 10;
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual(["/w/a.txt"]);
    // ... and the window is reset: the next press arms again
    now += 10;
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual(["/w/a.txt"]);
  });

  test("a backwards clock never turns a single click into an open", () => {
    // A backwards step (NTP, a restored VM) makes the delta NEGATIVE. The old
    // comparison (`now - lastClick >= window`) read that as "inside the
    // window" → a single click launched the file. A negative delta re-arms
    // instead: ONE click never opens.
    const ctx = makeCtx();
    let now = 5000;
    ctx.now = () => now;
    const opened: string[] = [];
    ctx.openFileDefault = (p) => opened.push(p);
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual([]);
    // the clock jumps BACKWARDS between the two clicks
    now -= 1000;
    press(h, { x: 1, y: 1 });
    expect(opened).toEqual([]);
  });
});

describe("commitPendingCtrlToggle / finishDragState", () => {
  test("the pending toggle is applied only while a press is armed", () => {
    const ctx = makeCtx();
    // a press that became a drag carries NO pending toggle at all — the
    // click-toggle never happened
    dispatchDrag({
      type: "arm",
      keys: [{ path: "/w/a.txt", isDir: false }],
      ctrl: true,
      x: 0,
      y: 0,
      pending: { key: "/w/a.txt", state: true },
    });
    dispatchDrag({ type: "trip" });
    commitPendingCtrlToggle(ctx);
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(false);
    // a fresh ARMED press carries one — and it is applied
    dispatchDrag({
      type: "arm",
      keys: [{ path: "/w/a.txt", isDir: false }],
      ctrl: true,
      x: 0,
      y: 0,
      pending: { key: "/w/a.txt", state: true },
    });
    commitPendingCtrlToggle(ctx);
    expect(ctx.tileRefs.get("/w/a.txt")!.selected).toBe(true);
    // ... exactly once: the commit consumed it
    commitPendingCtrlToggle(ctx);
    expect(ctx.selStatusRefreshes.n).toBe(1);
  });

  test("finishDragState clears everything and un-highlights a non-selected target", () => {
    const ctx = makeCtx();
    dispatchDrag({
      type: "arm",
      keys: [{ path: "/w/a.txt", isDir: false }],
      ctrl: true,
      x: 0,
      y: 0,
      pending: null,
    });
    dispatchDrag({ type: "trip" });
    dispatchDrag({ type: "hover-target", key: "/w/sub" });
    finishDragState(ctx);
    expect(dragState().kind).toBe("idle");
    expect(dragKeys(dragState())).toBeNull();
    expect(dragDropTarget(dragState())).toBeNull();
    expect(ctx.visuals.get("/w/sub")).toBe(0);
  });

  test("releasing an active drag restores the selection status (no stale 'Dragging…')", async () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 5, y: 5 });
    h.onMouseDrag({ x: 8, y: 5 } as any); // drag starts -> "Dragging 1 item…"
    expect(ctx.statuses.at(-1)).toBe("Dragging 1 item…");
    ctx.selStatusRefreshes.n = 0;
    h.onMouseUp(); // cleanup is deferred a tick (scheduleDragCleanup) — poll, don't sleep
    // the release moves the state to `released` (the payload survives for the
    // imminent drop); the deferred cleanup is what returns it to idle
    for (let i = 0; i < 50 && dragState().kind !== "idle"; i++) await Bun.sleep(1);
    expect(dragState().kind).toBe("idle");
    expect(ctx.selStatusRefreshes.n).toBe(1);
  });

  test("plain mouseup without an active drag does not touch the status", async () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, { x: 5, y: 5 });
    ctx.selStatusRefreshes.n = 0;
    h.onMouseUp();
    for (let i = 0; i < 50 && dragKeys(dragState()); i++) await Bun.sleep(1); // settle deferred cleanup
    expect(ctx.selStatusRefreshes.n).toBe(0);
  });
});

describe("hover animation routing", () => {
  test("over/out on an unselected tile routes through hoverAnim, not setTileVisual", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    h.onMouseOver();
    expect(ctx.hoverCalls).toEqual([["/w/a.txt", true]]);
    expect(ctx.visuals.get("/w/a.txt")).toBe(0); // no instant paint
    h.onMouseOut();
    expect(ctx.hoverCalls).toEqual([
      ["/w/a.txt", true],
      ["/w/a.txt", false],
    ]);
    expect(ctx.visuals.get("/w/a.txt")).toBe(0);
  });

  test("a selected tile gets no hover animation at all", () => {
    const ctx = makeCtx();
    ctx.tileRefs.get("/w/b.txt")!.selected = true;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/b.txt", 1);
    h.onMouseOver();
    h.onMouseOut();
    expect(ctx.hoverCalls).toEqual([]);
  });

  test("an active drag's drop-target hover keeps the instant Selected paint", () => {
    const ctx = makeCtx();
    dispatchDrag({
      type: "arm",
      keys: [{ path: "/w/a.txt", isDir: false }],
      ctrl: false,
      x: 0,
      y: 0,
      pending: null,
    });
    dispatchDrag({ type: "trip" });
    const h = makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3);
    h.onMouseOver();
    expect(ctx.hoverCalls).toEqual([]);
    expect(dragDropTarget(dragState())).toBe("/w/sub");
    expect(ctx.visuals.get("/w/sub")).toBe(2); // Selected
    h.onMouseOut();
    expect(ctx.visuals.get("/w/sub")).toBe(0);
  });

  test("without hoverAnim, over/out falls back to the instant tile paint", () => {
    const ctx = makeCtx();
    delete (ctx as any).hoverAnim;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    h.onMouseOver();
    expect(ctx.visuals.get("/w/a.txt")).toBe(1); // Hover
    h.onMouseOut();
    expect(ctx.visuals.get("/w/a.txt")).toBe(0); // Rest
  });
});

// mouse pointer shapes (OSC 22): over always sets, out always restores —
// unlike the highlight paint, which skips selected tiles, the pointer is an
// affordance (draggable/clickable) that must never stick. Drag states own
// the pointer while dragActive(dragState()) (grabbing over valid targets,
// not-allowed over files/self); finishDragState restores default centrally
// so every cleanup path (drop, pane-background drop, deferred release)
// heals, and the tile drop then re-applies the tile pointer.
describe("mouse pointer shapes", () => {
  test("tile hover sets pointer, out restores default", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    h.onMouseOver();
    h.onMouseOut();
    expect(ctx.pointers).toEqual(["pointer", "default"]);
  });

  test("selected tiles set/restore too (affordance, not highlight)", () => {
    const ctx = makeCtx();
    ctx.tileRefs.get("/w/b.txt")!.selected = true;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/b.txt", 1);
    h.onMouseOver();
    h.onMouseOut();
    expect(ctx.pointers).toEqual(["pointer", "default"]);
  });

  test("drag trip sets grabbing; finishDragState restores default", () => {
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, {});
    h.onMouseDrag({ x: 9, y: 9 } as any);
    expect(dragActive(dragState())).toBe(true);
    expect(ctx.pointers).toContain("grabbing");
    finishDragState(ctx);
    expect(ctx.pointers.at(-1)).toBe("default");
  });

  test("dragging over a folder keeps grabbing, over a file shows not-allowed", () => {
    const ctx = makeCtx();
    const hSrc = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    const hDir = makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3);
    const hFile = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/b.txt", 1);
    press(hSrc, {});
    hSrc.onMouseDrag({ x: 9, y: 9 } as any);
    expect(dragActive(dragState())).toBe(true);
    hDir.onMouseOver();
    hFile.onMouseOver();
    expect(ctx.pointers).toContain("grabbing");
    expect(ctx.pointers).toContain("not-allowed");
  });

  test("tile drop re-applies the tile pointer after the central restore", () => {
    const ctx = makeCtx();
    const hSrc = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    const hDst = makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3);
    press(hSrc, {});
    hSrc.onMouseDrag({ x: 9, y: 9 } as any);
    hDst.onMouseDrop();
    expect(ctx.pointers.at(-1)).toBe("pointer");
  });

  test("the deferred cleanup after a tile drop does not clobber the tile pointer", async () => {
    const ctx = makeCtx();
    const hSrc = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    const hDst = makeEntryMouseHandlers(ctx)({ isDir: true }, "/w/sub", 3);
    press(hSrc, {});
    hSrc.onMouseDrag({ x: 9, y: 9 } as any);
    // the release fires on the SOURCE before the drop reaches the target, so
    // the cleanup is deferred a tick — the drop lands first
    hSrc.onMouseDragEnd();
    hDst.onMouseDrop();
    expect(ctx.pointers.at(-1)).toBe("pointer");
    // when the deferred cleanup lands there is NOTHING left to clean up (the
    // drop already reset the drag), so it must not restore the pointer —
    // the cursor sits on the tile
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.pointers.at(-1)).toBe("pointer");
  });

  test("finishDragState on an idle drag state touches nothing", () => {
    // no drag owns the pointer, so a cleanup that "restores" it would
    // clobber whatever the surface under the cursor asked for
    const ctx = makeCtx();
    finishDragState(ctx);
    expect(ctx.pointers).toEqual([]);
    expect(ctx.selStatusRefreshes.n).toBe(0);
  });

  test("a tile press ends a live rubber band (its release never arrived)", () => {
    // the pointer left the terminal mid-marquee: no up event came, so the
    // band is still live. A tile press stops propagation, so the scroller
    // never sees it — the tile pipeline ends the band itself.
    const ctx = makeCtx();
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    press(h, {});
    expect(ctx.bandCancels.n).toBe(1);
  });

  test("absent setPointer changes nothing (old fakes keep working)", () => {
    const ctx = makeCtx();
    delete (ctx as any).setPointer;
    const h = makeEntryMouseHandlers(ctx)({ isDir: false }, "/w/a.txt", 0);
    h.onMouseOver();
    h.onMouseOut();
    h.onMouseDrop();
    expect(ctx.hoverCalls).toEqual([
      ["/w/a.txt", true],
      ["/w/a.txt", false],
    ]);
  });
});

// --- the rubber-band gesture: ONE explicit phase per PANE ---
//
// The gesture used to live in a MODULE-GLOBAL `bandStart` while the handlers
// are built PER PANE (one scroller per pane) → a band begun in pane 0 could
// be finalized in pane 1, committing a selection computed against pane 1's
// tiles but anchored at pane 0's screen coordinates. The band node's
// `visible` flag was a SECOND truth: it could disagree with the gesture
// state (a throw between the two writes left the state armed and the
// marquee invisible).
//
// The phase is now per pane and the node is a PROJECTION of it.

describe("the rubber-band gesture", () => {
  const makeBandCtx = (tileKeys: string[]) => {
    const phase: { current: BandPhase } = { current: { kind: "idle" } };
    const bandNode = { x: 0, y: 0, width: 0, height: 0, visible: false };
    const tileNodes = new Map<string, { screenX: number; screenY: number; width: number; height: number }>();
    tileKeys.forEach((k, i) => {
      tileNodes.set(k, { screenX: i * 10, screenY: 0, width: 10, height: 3 });
    });
    const anchorClears: (string | null)[] = [];
    const ctx: BandCtx = {
      byId: (id) => (id === BAND_ID ? (bandNode as any) : (tileNodes.get(id) as any)),
      tileRefs: new Map(tileKeys.map((k) => [k, { selected: false, tileId: k }])),
      clearTileSelection: () => {
        for (const r of ctx.tileRefs.values()) r.selected = false;
      },
      setTileVisual: () => {},
      updateSelectionStatusReal: () => {},
      renderPreview: () => {},
      setAnchorPath: (p) => {
        anchorClears.push(p);
      },
      bandPhase: () => phase.current,
      setBandPhase: (p) => {
        phase.current = p;
      },
    };
    const selected = (): string[] => [...ctx.tileRefs.entries()].filter(([, r]) => r.selected).map(([k]) => k);
    return { ctx, bandNode, phase, selected, anchorClears };
  };

  test("a band begun in one pane does not commit into another pane", () => {
    const pane0 = makeBandCtx(["/w/a.txt"]);
    const pane1 = makeBandCtx(["/w/b.txt"]);
    // the press lands in pane 0 and the pointer moves: the marquee is live
    beginBand(pane0.ctx, { x: 1, y: 1, button: 0 });
    updateBandRect(pane0.ctx, { x: 5, y: 5 });
    expect(pane0.phase.current.kind).toBe("dragging");
    // ...but the release is handled by the OTHER pane's scroller
    endBand(pane1.ctx, { x: 6, y: 6 });
    // pane 1 selected NOTHING (the gesture belonged to pane 0)
    expect(pane1.selected()).toEqual([]);
    // and pane 0's band is still live — it ends on ITS OWN release
    expect(pane0.phase.current.kind).toBe("dragging");
    endBand(pane0.ctx, { x: 6, y: 6 });
    expect(pane0.selected()).toEqual(["/w/a.txt"]);
  });

  test("the band node's visible flag is DERIVED from the phase", () => {
    const p = makeBandCtx(["/w/a.txt"]);
    // idle: the node is hidden
    expect(p.bandNode.visible).toBe(false);
    // armed (the button is down): the marquee is NOT shown yet — it appears
    // only once the pointer moves
    beginBand(p.ctx, { x: 1, y: 1, button: 0 });
    expect(p.phase.current.kind).toBe("armed");
    expect(p.bandNode.visible).toBe(false);
    // dragging: the node shows the rect
    updateBandRect(p.ctx, { x: 5, y: 4 });
    expect(p.phase.current.kind).toBe("dragging");
    expect(p.bandNode.visible).toBe(true);
    expect(p.bandNode.x).toBe(1);
    expect(p.bandNode.y).toBe(1);
    expect(p.bandNode.width).toBe(5);
    expect(p.bandNode.height).toBe(4);
    // ended: the node is hidden again
    endBand(p.ctx, { x: 5, y: 4 });
    expect(p.phase.current.kind).toBe("idle");
    expect(p.bandNode.visible).toBe(false);
  });

  test("a band that never moved commits nothing", () => {
    const p = makeBandCtx(["/w/a.txt"]);
    // a press on empty pane space arms the band; the release lands far away
    // (the pointer left the pane, so no drag event was delivered) — the stale
    // origin must NOT sweep a selection across the pane
    beginBand(p.ctx, { x: 1, y: 1, button: 0 });
    endBand(p.ctx, { x: 6, y: 6 });
    expect(p.selected()).toEqual([]);
    expect(p.phase.current.kind).toBe("idle");
  });

  test("ending a band clears the range origin (the next extend starts fresh)", () => {
    const p = makeBandCtx(["/w/a.txt"]);
    beginBand(p.ctx, { x: 1, y: 1, button: 0 });
    updateBandRect(p.ctx, { x: 5, y: 5 });
    endBand(p.ctx, { x: 5, y: 5 });
    expect(p.anchorClears).toEqual([null]);
  });

  test("cancelBands clears every pane's phase and hides the node", () => {
    const pane0 = makeBandCtx(["/w/a.txt"]);
    const pane1 = makeBandCtx(["/w/b.txt"]);
    beginBand(pane0.ctx, { x: 1, y: 1, button: 0 });
    updateBandRect(pane0.ctx, { x: 5, y: 5 });
    beginBand(pane1.ctx, { x: 2, y: 2, button: 0 });
    cancelBands([pane0.ctx, pane1.ctx]);
    expect(pane0.phase.current.kind).toBe("idle");
    expect(pane1.phase.current.kind).toBe("idle");
    expect(pane0.bandNode.visible).toBe(false);
  });
});

describe("no-drift rule", () => {
  test("the double-click window is a named phase, not a timestamp sentinel", async () => {
    // The old state was `lastClick = 0`: `0` doubled as "never clicked" AND
    // as a real instant (a clock at the epoch made the FIRST click open the
    // file), and the wall clock made the window untestable. The window is ONE
    // tagged phase with ONE transition — the sentinel may not come back.
    const src = (await Bun.file(`${import.meta.dir}/grid-input.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // (assert on the booleans, not the source: a failed match would dump
    // the whole module into the test output)
    expect(/lastClick/.test(src)).toBe(false);
    // ... and the phase names its armed variant
    expect(/kind:\s*"armed"/.test(src)).toBe(true);
  });
});
