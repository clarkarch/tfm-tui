// --- Grid input: the tile/row mouse pipeline (selection, deferred ctrl
// toggle, internal drag state, drop targeting, drag ghost) as a factory with
// injected UI callbacks. The shared drag state lives in ../lib/drag-state —
// this module DRIVES it (one reducer, no field writes) and every other
// module only READS it. No module-level imports from the renderer —
// everything flows through ctx. ---

import { archiveBrowseUri } from "../fs/archive-scheme";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { ListEntry } from "../lib/menu-entry";
import type { ClipItem } from "../lib/file-op-protocol";
import {
  dispatchDrag,
  dragActive,
  dragCtrl,
  dragDropTarget,
  dragKeys,
  dragPending,
  dragState,
} from "../lib/drag-state";

// What makeEntryMouseHandlers hands the grid to spread onto a tile: the tile
// mouse pipeline, typed so a misspelled handler name is a compile error.
export type TileMouseHandlers = {
  onMouseDown: (ev: TileMouseEvent) => void;
  onMouseUp: () => void;
  onMouseDragEnd: () => void;
  onMouseDrag: (ev: TileMouseEvent) => void;
  onMouseDrop: () => void;
};

// Mouse-event shape the tile pipeline actually reads (cell coords, button,
// modifiers). The renderer hands a richer object; handlers only touch these.
export type TileMouseEvent = {
  x: number;
  y: number;
  button?: number;
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean };
  stopPropagation?(): void;
};

// Tile highlight states painted by selection.setTileVisual. Names replace the
// bare 0/1/2 literals at call sites — Rest also covers the cut-dim case (the
// dim itself is resolved inside setTileVisual via isCutKey).
export const TileVisual = { Rest: 0, Hover: 1, Selected: 2 } as const;
export type TileVisualMode = (typeof TileVisual)[keyof typeof TileVisual];

// structural view of a tile ref — the full TileRefs in ./selection satisfies this
export type GridTileRef = { selected: boolean; isDir: boolean };

// shared drag state: the union lives in ../lib/drag-state (ONE owner, ONE
// reducer). This module drives it; nothing outside can write a field.

// --- ctx sections (intersected below; runtime object stays flat) ---
/** Selection state + visuals (owned by ./selection). */
export type GridSelectionDeps = {
  tileRefs: Map<string, GridTileRef>;
  setTileVisual(key: string, mode: TileVisualMode): void;
  updateSelectionStatusReal(): void;
  renderPreview(): void | Promise<void>;
  clearTileSelection(): void;
  selectRange(from: number, to: number): void;
  // the focus is a FILE, not an index: the range origin is resolved (and
  // pinned) by ONE rule, and a move names the file it lands on
  ensureAnchor(): number;
  setFocusPath(path: string, opts?: { keepAnchor?: boolean }): void;
  selPaths(): ClipItem[];
};
/** Context menu + inline rename (owned by the menu/rename widgets). */
export type GridMenuDeps = {
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  fileEntriesFor(key: string, isDir: boolean, x: number, y: number): ListEntry[];
  closeFileMenu(): void;
  renameEditKey(): string | null;
  finishInlineRename(commit: boolean): void;
};
/** Navigation + open + drop-into (owned by nav/fileops/chrome wirings). */
export type GridNavDeps = {
  navigate(dir: string): void;
  openFileDefault(p: string): void;
  moveInto(destDir: string, items: ClipItem[]): Promise<void>;
};

export type GridInputCtx = {
  byId(id: string): MaybeNode;
  termW(): number;
  termH(): number;
  dblClickMs(): number;
  // the clock for the double-click window (absent = the wall clock). It is
  // injected so the window is TESTABLE, and so a backwards step (NTP, a
  // restored VM) can be pinned instead of guessed at.
  now?(): number;
  // config knob [ui] drag-threshold-cells (default 1); read live at drag time
  dragThresholdCells?(): number;
  setStatusMsg(msg: string): void;
  log(msg: string): void;
  // dual pane: focus this tile's pane on press. Tile mousedown stops
  // propagation, so the scroller's own focusPane never sees a file click —
  // without this, clicking a tile in pane 1 leaves pane 0 active (status,
  // preview and every keybind then target the wrong side).
  focusPane?(): void;
  // blur the embedded terminal on any tile press: tile mousedown stops
  // propagation so the scroller's blurTerminal never runs, and a stale
  // termFocused flag makes ownsKeyboard() swallow every key with a lying
  // "Terminal owns keyboard" toast
  blurTerminal?(): void;
  // hand the keyboard back to the grid on any tile press: the sidebar
  // swallows EVERY key while it holds keyboard focus, and clicking a file
  // is what takes the focus back (without it, j/k/enter stayed dead in the
  // grid after a keyboard focus of the sidebar)
  blurSidebar?(): void;
  // animate the tile hover (instant highlight + one-cell lift, [ui] file-
  // hover-animation). Absent = today's instant paint via setTileVisual.
  hoverAnim?(key: string, hovered: boolean): void;
  // true while a modal owns the screen — hover must not paint behind the dim
  // (a synthetic re-over after the modal opened left tiles highlighted)
  modalOpen?(): boolean;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
  // end any live rubber band (the marquee of a gesture whose release never
  // arrived — the pointer left the terminal and no up event came). A tile
  // press stops propagation, so the scroller never sees it.
  cancelBand?(): void;
} & GridSelectionDeps &
  GridMenuDeps &
  GridNavDeps;

export const DRAG_GHOST_ID = "tfm-drag-ghost";

export const commitPendingCtrlToggle = (ctx: GridInputCtx): void => {
  // the deferred toggle exists ONLY while a press is armed — once the press
  // became a drag the state carries no pending toggle at all, so the "never
  // toggle a drag" rule is structural instead of a guard
  const pending = dragPending(dragState());
  if (!pending) return;
  // consume it FIRST (a press whose tile vanished must not retry forever)
  dispatchDrag({ type: "consume-pending" });
  const refs = ctx.tileRefs.get(pending.key);
  if (!refs) return;
  refs.selected = pending.state;
  ctx.setTileVisual(pending.key, pending.state ? TileVisual.Selected : TileVisual.Rest);
  ctx.updateSelectionStatusReal();
  void ctx.renderPreview();
};

const updateDragGhost = (ctx: GridInputCtx, x: number, y: number): void => {
  const g = ctx.byId(DRAG_GHOST_ID);
  if (!g) return;
  try {
    const n = dragKeys(dragState())?.length ?? 0;
    const label = `moving ${n} item${n === 1 ? "" : "s"}`;
    const t = ctx.byId(`${DRAG_GHOST_ID}-label`);
    if (t && t.content !== label) t.content = label;
    g.width = label.length + 2;
    g.left = Math.max(0, Math.min(x + 1, ctx.termW() - label.length - 2));
    g.top = Math.max(0, Math.min(y + 1, ctx.termH() - 1));
    g.visible = true;
  } catch {}
};

const hideDragGhost = (ctx: GridInputCtx): void => {
  const g = ctx.byId(DRAG_GHOST_ID);
  if (g) {
    try {
      g.visible = false;
    } catch {}
  }
};

export const finishDragState = (ctx: GridInputCtx): void => {
  const state = dragState();
  // nothing to clean up: the drag is already over. Restoring the pointer here
  // would clobber whatever the surface under the cursor asked for (the
  // deferred cleanup lands a tick AFTER the drop, which already reset the
  // drag — the tile's own "pointer" must survive it).
  if (state.kind === "idle") return;
  const wasActive = state.kind === "dragging" || (state.kind === "released" && state.wasDragging);
  const dropTarget = dragDropTarget(state);
  ctx.log(`finishDragState active=${wasActive} target=${dropTarget}`);
  hideDragGhost(ctx);
  dispatchDrag({ type: "reset" });
  if (dropTarget) {
    const r = ctx.tileRefs.get(dropTarget);
    if (r && !r.selected) ctx.setTileVisual(dropTarget, TileVisual.Rest);
  }
  // central pointer restore: every cleanup path (tile drop, pane-background
  // drop, sidebar drop, deferred release) heals through here; the tile drop
  // re-applies its own pointer afterwards
  ctx.setPointer?.("default");
  // release without a drop: "Dragging N items…" must not linger — restore the
  // selection status (a real drop overwrites it with the move/copy progress)
  if (wasActive) ctx.updateSelectionStatusReal();
};

// release fires on the source before `drop` reaches the target — defer cleanup
export const scheduleDragCleanup = (ctx: GridInputCtx): void => {
  setTimeout(() => finishDragState(ctx), 0);
};

// --- Rubber-band selection (marquee over empty grid space) ---
// The band NODE is created by the boot layout (id: BAND_ID); this module owns
// the GESTURE and projects it onto the node.
//
// The gesture is ONE explicit phase, owned PER PANE: the scrollers are built
// per pane, and the old module-global origin let a band begun in pane 0 be
// finalized in pane 1 — a selection computed against pane 1's tiles but
// anchored at pane 0's screen coordinates. The node's `visible` flag used to
// be a SECOND truth (it could disagree with the gesture state); it is now
// DERIVED from the phase.

/** The marquee rectangle, in screen cells. */
export type BandRect = { x: number; y: number; width: number; height: number };

/** The band gesture phase — the ONE truth. */
export type BandPhase =
  /** no gesture */
  | { kind: "idle" }
  /** the button went down on empty pane space; the marquee is not shown yet */
  | { kind: "armed"; origin: { x: number; y: number } }
  /** the pointer moved: the marquee is shown and its rect is known */
  | { kind: "dragging"; origin: { x: number; y: number }; rect: BandRect };

export type BandCtx = {
  byId(id: string): MaybeNode;
  tileRefs: Map<string, { selected: boolean; tileId: string }>;
  clearTileSelection(): void;
  setTileVisual(key: string, mode: TileVisualMode): void;
  updateSelectionStatusReal(): void;
  renderPreview(): void | Promise<void>;
  // the band clears the range origin: the next extend starts fresh
  setAnchorPath(path: string | null): void;
  /** the gesture phase — the ONE truth (the node is its projection) */
  bandPhase(): BandPhase;
  setBandPhase(phase: BandPhase): void;
};

export const BAND_ID = "tfm-band";

// The node is a PROJECTION of the phase: its geometry and its visible flag
// are written from the phase, never set independently.
const projectBand = (ctx: BandCtx, phase: BandPhase): void => {
  const b = ctx.byId(BAND_ID);
  if (!b) return;
  try {
    if (phase.kind === "dragging") {
      b.x = phase.rect.x;
      b.y = phase.rect.y;
      b.width = phase.rect.width;
      b.height = phase.rect.height;
      b.visible = true;
    } else {
      b.visible = false;
    }
  } catch {}
};

const setPhase = (ctx: BandCtx, phase: BandPhase): void => {
  ctx.setBandPhase(phase);
  projectBand(ctx, phase);
};

// the marquee rectangle between the gesture's origin and a pointer position
const rectFrom = (origin: { x: number; y: number }, ev: { x: number; y: number }): BandRect => ({
  x: Math.min(origin.x, ev.x),
  y: Math.min(origin.y, ev.y),
  width: Math.abs(ev.x - origin.x) + 1,
  height: Math.abs(ev.y - origin.y) + 1,
});

/** the button went down on empty pane space — arm the band */
export const beginBand = (ctx: BandCtx, ev: { x: number; y: number; button: number }): void => {
  if (ev.button !== 0) return;
  setPhase(ctx, { kind: "armed", origin: { x: ev.x, y: ev.y } });
};

/** the pointer moved — the marquee is shown and its rect is known */
export const updateBandRect = (ctx: BandCtx, ev: { x: number; y: number }): void => {
  const phase = ctx.bandPhase();
  if (phase.kind === "idle") return;
  setPhase(ctx, { kind: "dragging", origin: phase.origin, rect: rectFrom(phase.origin, ev) });
};

/**
 * The ONE end path — the mouseup AND the dragend both land here.
 *
 * A band that never MOVED commits nothing: an ordinary click on empty pane
 * space must not sweep a selection out of the pane. A band that moved
 * commits the tiles under its rect.
 */
export const endBand = (ctx: BandCtx, ev: { x: number; y: number }): void => {
  const phase = ctx.bandPhase();
  if (phase.kind === "idle") return;
  // the RELEASE position is authoritative: the marquee ends where the button
  // came up (the last drag event can be a cell behind it)
  const rect = phase.kind === "dragging" ? rectFrom(phase.origin, ev) : null;
  setPhase(ctx, { kind: "idle" });
  // the range origin is cleared: the next extend starts fresh
  ctx.setAnchorPath(null);
  if (!rect) return;
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = x0 + rect.width - 1;
  const y1 = y0 + rect.height - 1;
  ctx.clearTileSelection();
  ctx.tileRefs.forEach((refs, key) => {
    const t = ctx.byId(refs.tileId);
    if (!t) return;
    // width/height carry OpenTUI's CssLike union; a mounted tile is always a
    // resolved number, so a percentage/auto miss means it never laid out
    const tx = t.screenX,
      ty = t.screenY,
      tw = typeof t.width === "number" ? t.width : 0,
      th = typeof t.height === "number" ? t.height : 0;
    if (tx < x1 + 1 && tx + tw > x0 && ty < y1 + 1 && ty + th > y0) {
      refs.selected = true;
      ctx.setTileVisual(key, TileVisual.Selected);
    }
  });
  ctx.updateSelectionStatusReal();
  void ctx.renderPreview();
};

/**
 * End the band from a release that may have landed OUTSIDE the scroller
 * (the scroller's own mouseup never fires then, and the marquee would stay
 * on screen with a stale origin).
 *
 * Only ONE pane can hold a live gesture (one pointer): the first live band
 * ends, any other stale phase is dropped WITHOUT committing.
 */
export const endBands = (ctxs: readonly BandCtx[], ev: { x: number; y: number }): void => {
  let ended = false;
  for (const ctx of ctxs) {
    if (ctx.bandPhase().kind === "idle") continue;
    if (ended) {
      setPhase(ctx, { kind: "idle" });
      continue;
    }
    endBand(ctx, ev);
    ended = true;
  }
};

// modal menus kill any in-flight band so a stale rect can't commit later
export const cancelBand = (ctx: BandCtx): void => {
  if (ctx.bandPhase().kind === "idle") return;
  setPhase(ctx, { kind: "idle" });
};

/** cancel every pane's band */
export const cancelBands = (ctxs: readonly BandCtx[]): void => {
  for (const ctx of ctxs) cancelBand(ctx);
};

// --- the double-click window ---
//
// ONE explicit phase per tile. The old state was a bare `lastClick = 0`
// timestamp, which carried TWO meanings: "no click yet" and "a click at the
// epoch". The wall clock made it worse — the window could not be tested, and
// a backwards step (NTP, a restored VM) turned the delta negative, which the
// old comparison read as "inside the window" (a SINGLE click opened the
// file).
type DoubleClickPhase = { kind: "idle" } | { kind: "armed"; at: number };

/**
 * The double-click window's ONE transition.
 *
 * - idle → armed: the first click of a gesture (it never opens).
 * - armed + a delta inside the window → idle + OPEN: the second click.
 * - armed + a delta outside the window → armed: the click starts a NEW
 *   gesture (the window is re-armed).
 * - armed + a NEGATIVE delta (the clock went backwards) → armed: the click
 *   starts a new gesture too. A backwards step must never open a file.
 */
const advanceDoubleClick = (
  phase: DoubleClickPhase,
  now: number,
  windowMs: number,
): { phase: DoubleClickPhase; open: boolean } => {
  if (phase.kind !== "armed") return { phase: { kind: "armed", at: now }, open: false };
  const delta = now - phase.at;
  if (delta < 0 || delta >= windowMs) return { phase: { kind: "armed", at: now }, open: false };
  return { phase: { kind: "idle" }, open: true };
};

export const makeEntryMouseHandlers = (ctx: GridInputCtx) => {
  return (entry: { isDir: boolean }, key: string, idx: number) => {
    // The double-click window: ONE explicit phase per tile (a double-click
    // is ONE tile's gesture). The old state was a bare `lastClick = 0`
    // timestamp: `0` doubled as "never clicked" AND as a real instant — a
    // clock at the epoch made the FIRST click open the file — and the WALL
    // clock made the window untestable.
    let dblClick: DoubleClickPhase = { kind: "idle" };

    const armDragPayload = (
      ev: TileMouseEvent,
      keys: ClipItem[],
      internal: boolean,
      pending: { key: string; state: boolean } | null = null,
    ): void => {
      // arming REPLACES the whole state — a pending toggle from an earlier
      // gesture can never outlive the press that armed it
      dispatchDrag({ type: "arm", keys, ctrl: internal, x: ev.x, y: ev.y, pending });
    };

    // Nautilus behavior: right-click selects the tile unless it's already
    // part of the live multi-selection, then opens the context menu.
    const handleRightClick = (ev: TileMouseEvent): boolean => {
      if (ev.button !== 2) return false;
      if (!ctx.tileRefs.get(key)?.selected) {
        ctx.clearTileSelection();
        const ref = ctx.tileRefs.get(key);
        if (ref) {
          ref.selected = true;
          ctx.setTileVisual(key, TileVisual.Selected);
        }
        ctx.updateSelectionStatusReal();
        void ctx.renderPreview();
      }
      ctx.openContextMenu(ev.x, ev.y, "", ctx.fileEntriesFor(key, entry.isDir, ev.x, ev.y));
      return true;
    };

    const handleDoubleClick = (ev: TileMouseEvent): boolean => {
      // a modifier means toggle (ctrl) / range (shift/alt), never open: two
      // fast ctrl-clicks must not launch the file. The phase is left alone, so
      // the modified press leaves the double-click clock as it was.
      const mods = ev.modifiers ?? {};
      if (mods.ctrl || mods.shift || mods.alt) return false;
      const now = ctx.now?.() ?? Date.now();
      const next = advanceDoubleClick(dblClick, now, ctx.dblClickMs());
      dblClick = next.phase;
      if (!next.open) return false;
      const archive = archiveBrowseUri(key, entry.isDir);
      if (archive) ctx.navigate(archive);
      else if (entry.isDir) ctx.navigate(key);
      else ctx.openFileDefault(key);
      return true;
    };

    // ctrl+click (no movement): toggle membership — coexists with ctrl+drag
    // which still means internal move once the drag threshold trips.
    // The toggle itself is DEFERRED to mouseup: applying it here unselected
    // the pressed tile, so ctrl+dragging a selected file moved 0 items and
    // rubber-band + ctrl+drag dropped the pressed file from the payload.
    const handleCtrlPress = (ev: TileMouseEvent): boolean => {
      if (!ev.modifiers?.ctrl) return false;
      const refs = ctx.tileRefs.get(key);
      const wasSelected = !!refs?.selected;
      const payload = wasSelected ? ctx.selPaths() : [...ctx.selPaths(), { path: key, isDir: entry.isDir }];
      ctx.updateSelectionStatusReal();
      void ctx.renderPreview();
      // the deferred toggle rides along with the arm — it exists ONLY in the
      // armed phase, so it cannot leak into a later gesture
      armDragPayload(ev, payload, true, { key, state: !wasSelected });
      ctx.log(`ctrl mousedown ${key} wasSel=${wasSelected} provisional=${payload.length}`);
      return true;
    };

    // shift+click / alt+click: range select. The anchor persists across
    // clicks so each alt+click re-extends from the SAME origin; plain and
    // ctrl clicks are what move/reset it.
    const handleRangePress = (ev: TileMouseEvent): boolean => {
      const mods = ev.modifiers ?? {};
      if (!(mods.shift || mods.alt)) return false;
      // ONE anchor rule (the pinned origin, else the focus, else the first
      // tile) — it is pinned here so the focus jump below keeps it
      const anchor = ctx.ensureAnchor();
      ctx.selectRange(anchor, idx);
      // the keyboard extend endpoint must follow the clicked tile, or the next
      // shift+arrow extends from a stale focus and collapses the range
      ctx.setFocusPath(key, { keepAnchor: true });
      ctx.updateSelectionStatusReal();
      void ctx.renderPreview();
      armDragPayload(ev, ctx.selPaths(), false);
      return true;
    };

    const handlePlainPress = (ev: TileMouseEvent): void => {
      const prevSel = ctx.selPaths();
      const wasSelected = !!ctx.tileRefs.get(key)?.selected;
      ctx.clearTileSelection();
      // a plain press moves the focus AND re-anchors the range origin
      ctx.setFocusPath(key);
      const ref = ctx.tileRefs.get(key);
      if (ref) {
        if (wasSelected && prevSel.length > 1) {
          for (const item of prevSel) {
            const itemRef = ctx.tileRefs.get(item.path);
            if (itemRef) {
              itemRef.selected = true;
              ctx.setTileVisual(item.path, TileVisual.Selected);
            }
          }
        } else {
          ref.selected = true;
          ctx.setTileVisual(key, TileVisual.Selected);
        }
      }
      ctx.updateSelectionStatusReal();
      void ctx.renderPreview();
      armDragPayload(ev, wasSelected && prevSel.length > 1 ? prevSel : [{ path: key, isDir: entry.isDir }], false);
      ctx.log(
        `tile mousedown ${key} wasSel=${wasSelected} prevN=${prevSel.length} -> keys=${dragKeys(dragState())?.length ?? 0} ctrl=${dragCtrl(dragState())}`,
      );
    };

    // mouseup / drag-end without a drop: commit a deferred ctrl-toggle, then
    // schedule the shared cleanup (a real drop overwrites the status first).
    const releasePress = (why: string): void => {
      if (!dragKeys(dragState())) return;
      ctx.log(`tile ${why} -> cleanup scheduled`);
      commitPendingCtrlToggle(ctx);
      // the gesture is over: the payload survives for the imminent drop, the
      // ctrl flag does not
      dispatchDrag({ type: "release" });
      scheduleDragCleanup(ctx);
    };

    // first motion past the threshold turns the press into an internal drag:
    // the click-toggle never happened, so select the payload for real.
    const tripDrag = (): void => {
      const state = dragState();
      if (state.kind !== "armed") return;
      // the trip DROPS the pending toggle — the click-toggle never happened
      dispatchDrag({ type: "trip" });
      const keys = state.keys;
      // payload tiles must actually be selected or the visual state lies
      for (const dragged of keys) {
        const ref = ctx.tileRefs.get(dragged.path);
        if (ref && !ref.selected) {
          ref.selected = true;
          ctx.setTileVisual(dragged.path, TileVisual.Selected);
        }
      }
      ctx.log(`internal drag start n=${keys.length}`);
      ctx.setPointer?.("grabbing");
      ctx.setStatusMsg(`Dragging ${keys.length} item${keys.length === 1 ? "" : "s"}…`);
    };

    return {
      onMouseDown: (ev: TileMouseEvent) => {
        try {
          ev.stopPropagation?.();
        } catch {}
        // a press ends any live rubber band: the marquee of a gesture whose
        // release never arrived (the pointer left the terminal) would
        // otherwise stay on screen — and the tile press stops propagation,
        // so the scroller never gets the chance to end it
        ctx.cancelBand?.();
        ctx.focusPane?.();
        ctx.blurTerminal?.();
        // the mouse takes the keyboard back from the sidebar
        ctx.blurSidebar?.();
        ctx.closeFileMenu();
        const rk = ctx.renameEditKey();
        if (rk && rk !== key) ctx.finishInlineRename(false);
        if (handleRightClick(ev)) return;
        // the ctrl modifier decides internal vs external for drags
        // (see the OSC 72 offer handler)
        if (handleDoubleClick(ev)) return;
        if (handleCtrlPress(ev)) return;
        if (handleRangePress(ev)) return;
        handlePlainPress(ev);
      },
      onMouseUp: () => releasePress("mouseup"),
      onMouseDragEnd: () => releasePress("dragend"),
      onMouseDrag: (ev: TileMouseEvent) => {
        const state = dragState();
        // the threshold is measured from the PRESS point — only an armed
        // press can trip (a released gesture is over)
        if (state.kind === "armed") {
          const thr = ctx.dragThresholdCells?.() ?? 1;
          if (Math.abs(ev.x - state.x) > thr || Math.abs(ev.y - state.y) > thr) tripDrag();
        }
        if (dragActive(dragState())) updateDragGhost(ctx, ev.x, ev.y);
      },
      onMouseDrop: () => {
        const keys = dragKeys(dragState());
        // The drop is delivered to the tile UNDER THE CURSOR (its own `key`),
        // so use that folder as the destination. Do NOT rely on the hover-set
        // drop target: over fires before the drag trips and doesn't re-fire
        // while the pointer stays on one tile, so the proxy is frequently null
        // at release (this is what broke cross-pane drops).
        const dest = entry.isDir ? key : null;
        ctx.log(
          `tile drop keys=${keys?.length ?? -1}[${keys?.map((item) => item.path.split("/").pop()).join(",") ?? ""}] dest=${dest} isDir=${entry.isDir}`,
        );
        finishDragState(ctx);
        // the cursor sits on a tile: re-apply its pointer after the central
        // default restore (a pane-background drop keeps default)
        ctx.setPointer?.("pointer");
        if (keys && dest && entry.isDir)
          void ctx.moveInto(
            dest,
            keys.filter((item) => item.path !== dest),
          );
      },
      onMouseOver: () => {
        const state = dragState();
        if (state.kind === "dragging") {
          const draggingSelf = state.keys.some((item) => item.path === key);
          if (entry.isDir && !draggingSelf) {
            ctx.log(`hover target set ${key}`);
            dispatchDrag({ type: "hover-target", key });
            ctx.setTileVisual(key, TileVisual.Selected);
            ctx.setPointer?.("grabbing");
          } else {
            ctx.setPointer?.("not-allowed");
          }
          return;
        }
        // a modal owns the screen: no hover paint under the dim (the scrim
        // normally blocks the move, but a synthetic re-over can still land)
        if (ctx.modalOpen?.()) return;
        // the pointer is an affordance (draggable/clickable), not a highlight:
        // it sets/restores even on selected tiles, which skip the paint below
        ctx.setPointer?.("pointer");
        const refs = ctx.tileRefs.get(key);
        if (refs?.selected) return;
        if (ctx.hoverAnim) ctx.hoverAnim(key, true);
        else ctx.setTileVisual(key, TileVisual.Hover);
      },
      onMouseOut: () => {
        const state = dragState();
        if (state.kind === "dragging") {
          if (state.dropTarget === key) {
            dispatchDrag({ type: "hover-target", key: null });
            ctx.setTileVisual(key, TileVisual.Rest);
          }
          ctx.setPointer?.("grabbing");
          return;
        }
        ctx.setPointer?.("default");
        const refs = ctx.tileRefs.get(key);
        if (refs?.selected) return;
        if (ctx.hoverAnim) ctx.hoverAnim(key, false);
        else ctx.setTileVisual(key, TileVisual.Rest);
      },
    };
  };
};
