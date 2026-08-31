// --- Grid input: the tile/row mouse pipeline (selection, deferred ctrl
// toggle, internal drag state, drop targeting, drag ghost) as a factory with
// injected UI callbacks. Owns the shared drag state singleton (`gridDrag`)
// that the sidebar, OSC 72 bridge and keyboard paths read. No module-level
// imports from the renderer — everything flows through ctx. ---

export type ClipItem = { path: string; isDir: boolean };

// structural view of a tile ref — the full TileRefs in index.ts satisfies this
export type GridTileRef = { selected: boolean; isDir: boolean };

export type GridMenuEntry = {
  icon?: string;
  label: string;
  hint?: string;
  hintIcon?: string;
  action: () => void;
  sep?: boolean;
};

// shared drag state: one plain mutable object so closures in index.ts and
// here see the same fields without getter/setter plumbing
export const gridDrag = {
  keys: null as ClipItem[] | null,
  ctrl: false, // ctrl+drag = internal move, plain drag = external OSC 72
  active: false,
  dropTarget: null as string | null,
  startX: 0,
  startY: 0,
  // ctrl+press defers its toggle until we know it was a click, not a drag —
  // toggling at mousedown unselected the pressed tile and emptied the payload
  pendingKey: null as string | null,
  pendingState: false,
};

export type GridInputCtx = {
  byId(id: string): any;
  termW(): number;
  termH(): number;
  tileRefs: Map<string, GridTileRef>;
  setTileVisual(key: string, mode: 0 | 1 | 2): void;
  updateSelectionStatusReal(): void;
  renderPreview(): void | Promise<void>;
  clearTileSelection(): void;
  selectRange(from: number, to: number): void;
  getSelAnchor(): number | null;
  setSelAnchor(v: number | null): void;
  getFocusIdx(): number;
  selPaths(): ClipItem[];
  dblClickMs(): number;
  // config knob [ui] drag-threshold-cells (default 1); read live at drag time
  dragThresholdCells?(): number;
  navigate(dir: string): void;
  openFileDefault(p: string): void;
  openContextMenu(x: number, y: number, title: string, entries: GridMenuEntry[]): void;
  fileEntriesFor(key: string, isDir: boolean, x: number, y: number): GridMenuEntry[];
  closeFileMenu(): void;
  renameEditKey(): string | null;
  finishInlineRename(commit: boolean): void;
  setStatusMsg(msg: string): void;
  log(msg: string): void;
  moveInto(destDir: string, items: ClipItem[]): Promise<void>;
};

export const DRAG_GHOST_ID = "tfm-drag-ghost";

export const commitPendingCtrlToggle = (ctx: GridInputCtx): void => {
  const k = gridDrag.pendingKey;
  gridDrag.pendingKey = null;
  if (!k || gridDrag.active) return;
  const refs = ctx.tileRefs.get(k);
  if (!refs) return;
  refs.selected = gridDrag.pendingState;
  ctx.setTileVisual(k, gridDrag.pendingState ? 2 : 0);
  ctx.updateSelectionStatusReal();
  void ctx.renderPreview();
};

const updateDragGhost = (ctx: GridInputCtx, x: number, y: number): void => {
  const g: any = ctx.byId(DRAG_GHOST_ID);
  if (!g) return;
  try {
    const n = gridDrag.keys?.length ?? 0;
    const label = `moving ${n} item${n === 1 ? "" : "s"}`;
    const t: any = ctx.byId(`${DRAG_GHOST_ID}-label`);
    if (t && t.content !== label) t.content = label;
    g.width = label.length + 2;
    g.left = Math.max(0, Math.min(x + 1, ctx.termW() - label.length - 2));
    g.top = Math.max(0, Math.min(y + 1, ctx.termH() - 1));
    g.visible = true;
  } catch {}
};

const hideDragGhost = (ctx: GridInputCtx): void => {
  const g: any = ctx.byId(DRAG_GHOST_ID);
  if (g) {
    try {
      g.visible = false;
    } catch {}
  }
};

export const finishDragState = (ctx: GridInputCtx): void => {
  const wasActive = gridDrag.active;
  ctx.log(`finishDragState active=${gridDrag.active} target=${gridDrag.dropTarget}`);
  gridDrag.pendingKey = null;
  hideDragGhost(ctx);
  gridDrag.ctrl = false;
  if (gridDrag.dropTarget) {
    const r = ctx.tileRefs.get(gridDrag.dropTarget);
    if (r && !r.selected) ctx.setTileVisual(gridDrag.dropTarget, 0);
  }
  gridDrag.dropTarget = null;
  gridDrag.active = false;
  gridDrag.keys = null;
  // release without a drop: "Dragging N items…" must not linger — restore the
  // selection status (a real drop overwrites it with the move/copy progress)
  if (wasActive) ctx.updateSelectionStatusReal();
};

// release fires on the source before `drop` reaches the target — defer cleanup
export const scheduleDragCleanup = (ctx: GridInputCtx): void => {
  setTimeout(() => finishDragState(ctx), 0);
};

// --- Rubber-band selection (marquee over empty grid space) ---
// Owns the band gesture state: the band NODE is created by the boot layout
// (id: BAND_ID), this module only moves/hides it and commit-picks tiles.
// Module-level state mirrors the gridDrag singleton above.

export type BandCtx = {
  byId(id: string): any;
  tileRefs: Map<string, { selected: boolean; tileId: string }>;
  clearTileSelection(): void;
  setTileVisual(key: string, mode: 0 | 1 | 2): void;
  updateSelectionStatusReal(): void;
  renderPreview(): void | Promise<void>;
  setSelAnchor(v: number | null): void;
};

export const BAND_ID = "tfm-band";

let bandStart: { x: number; y: number } | null = null;

export const bandActive = (): boolean => bandStart !== null;

export const beginBand = (ev: { x: number; y: number; button: number }): void => {
  if (ev.button !== 0) return;
  bandStart = { x: ev.x, y: ev.y };
};

export const updateBandRect = (ctx: BandCtx, ev: { x: number; y: number }): void => {
  if (!bandStart) return;
  const b: any = ctx.byId(BAND_ID);
  if (!b) return;
  try {
    b.x = Math.min(bandStart.x, ev.x);
    b.y = Math.min(bandStart.y, ev.y);
    b.width = Math.abs(ev.x - bandStart.x) + 1;
    b.height = Math.abs(ev.y - bandStart.y) + 1;
    b.visible = true;
  } catch {}
};

export const finalizeBand = (ctx: BandCtx, ev: { x: number; y: number }): void => {
  const start = bandStart;
  bandStart = null;
  ctx.setSelAnchor(null);
  const b: any = ctx.byId(BAND_ID);
  if (b) {
    try {
      b.visible = false;
    } catch {}
  }
  if (!start) return;
  const x0 = Math.min(start.x, ev.x),
    y0 = Math.min(start.y, ev.y);
  const x1 = Math.max(start.x, ev.x),
    y1 = Math.max(start.y, ev.y);
  ctx.clearTileSelection();
  ctx.tileRefs.forEach((refs, key) => {
    const t: any = ctx.byId(refs.tileId);
    if (!t) return;
    const tx = t.screenX,
      ty = t.screenY,
      tw = t.width,
      th = t.height;
    if (tx < x1 + 1 && tx + tw > x0 && ty < y1 + 1 && ty + th > y0) {
      refs.selected = true;
      ctx.setTileVisual(key, 2);
    }
  });
  ctx.updateSelectionStatusReal();
  void ctx.renderPreview();
};

// modal menus kill any in-flight band so a stale rect can't commit later
export const cancelBand = (ctx: BandCtx): void => {
  bandStart = null;
  const b: any = ctx.byId(BAND_ID);
  if (b) {
    try {
      b.visible = false;
    } catch {}
  }
};

export const makeEntryMouseHandlers = (ctx: GridInputCtx) => {
  return (e: { isDir: boolean }, key: string, idx: number) => {
    let lastClick = 0;
    return {
      onMouseDown: (ev: any) => {
        try {
          ev.stopPropagation?.();
        } catch {}
        ctx.closeFileMenu();
        const rk = ctx.renameEditKey();
        if (rk && rk !== key) ctx.finishInlineRename(false);
        if (ev.button === 2) {
          // Nautilus behavior: right-click selects the tile unless it's already
          // part of the live multi-selection
          if (!ctx.tileRefs.get(key)?.selected) {
            ctx.clearTileSelection();
            const r = ctx.tileRefs.get(key);
            if (r) {
              r.selected = true;
              ctx.setTileVisual(key, 2);
            }
            ctx.updateSelectionStatusReal();
            void ctx.renderPreview();
          }
          ctx.openContextMenu(ev.x, ev.y, "", ctx.fileEntriesFor(key, e.isDir, ev.x, ev.y));
          return;
        }
        // the ctrl modifier decides internal vs external for drags
        // (see the OSC 72 offer handler)
        const now = Date.now();
        if (now - lastClick < ctx.dblClickMs()) {
          if (e.isDir) ctx.navigate(key);
          else ctx.openFileDefault(key);
          lastClick = 0;
          return;
        }
        lastClick = now;
        const mods = ev.modifiers ?? {};

        // ctrl+click (no movement): toggle membership — coexists with ctrl+drag
        // which still means internal move once the drag threshold trips.
        // The toggle itself is DEFERRED to mouseup: applying it here unselected
        // the pressed tile, so ctrl+dragging a selected file moved 0 items and
        // rubber-band + ctrl+drag dropped the pressed file from the payload.
        if (mods.ctrl) {
          const refs = ctx.tileRefs.get(key);
          const wasSel = !!refs?.selected;
          gridDrag.pendingKey = key;
          gridDrag.pendingState = !wasSel;
          ctx.updateSelectionStatusReal();
          void ctx.renderPreview();
          gridDrag.keys = wasSel ? ctx.selPaths() : [...ctx.selPaths(), { path: key, isDir: e.isDir }];
          ctx.log(`ctrl mousedown ${key} wasSel=${wasSel} provisional=${gridDrag.keys.length}`);
          gridDrag.active = false;
          gridDrag.startX = ev.x;
          gridDrag.startY = ev.y;
          gridDrag.ctrl = true;
          return;
        }

        // shift+click / alt+click: range select. The anchor persists across
        // clicks so each alt+click re-extends from the SAME origin; plain and
        // ctrl clicks are what move/reset it.
        if (mods.shift || mods.alt) {
          if (ctx.getSelAnchor() === null) ctx.setSelAnchor(ctx.getFocusIdx() >= 0 ? ctx.getFocusIdx() : 0);
          ctx.selectRange(ctx.getSelAnchor()!, idx);
          ctx.updateSelectionStatusReal();
          void ctx.renderPreview();
          gridDrag.keys = ctx.selPaths();
          gridDrag.active = false;
          gridDrag.startX = ev.x;
          gridDrag.startY = ev.y;
          gridDrag.ctrl = false;
          return;
        }

        const prevSel = ctx.selPaths();
        const wasSelected = !!ctx.tileRefs.get(key)?.selected;
        ctx.clearTileSelection();
        ctx.setSelAnchor(idx);
        const refs = ctx.tileRefs.get(key);
        if (refs) {
          if (wasSelected && prevSel.length > 1) {
            for (const s of prevSel) {
              const r2 = ctx.tileRefs.get(s.path);
              if (r2) {
                r2.selected = true;
                ctx.setTileVisual(s.path, 2);
              }
            }
          } else {
            refs.selected = true;
            ctx.setTileVisual(key, 2);
          }
        }
        ctx.updateSelectionStatusReal();
        void ctx.renderPreview();
        gridDrag.keys = wasSelected && prevSel.length > 1 ? prevSel : [{ path: key, isDir: e.isDir }];
        gridDrag.active = false;
        gridDrag.startX = ev.x;
        gridDrag.startY = ev.y;
        gridDrag.ctrl = !!ev.modifiers?.ctrl;
        ctx.log(
          `tile mousedown ${key} wasSel=${wasSelected} prevN=${prevSel.length} -> keys=${gridDrag.keys.length} ctrl=${gridDrag.ctrl}`,
        );
      },
      onMouseUp: () => {
        if (gridDrag.keys) {
          ctx.log("tile mouseup -> cleanup scheduled");
          commitPendingCtrlToggle(ctx);
          scheduleDragCleanup(ctx);
        }
      },
      onMouseDragEnd: () => {
        if (gridDrag.keys) {
          ctx.log("tile dragend -> cleanup scheduled");
          commitPendingCtrlToggle(ctx);
          scheduleDragCleanup(ctx);
        }
      },
      onMouseDrag: (ev: any) => {
        if (!gridDrag.keys) return;
        const thr = ctx.dragThresholdCells?.() ?? 1;
        if (!gridDrag.active && (Math.abs(ev.x - gridDrag.startX) > thr || Math.abs(ev.y - gridDrag.startY) > thr)) {
          gridDrag.active = true;
          gridDrag.pendingKey = null; // it became a drag — the click-toggle never happened
          // payload tiles must actually be selected or the visual state lies
          for (const k of gridDrag.keys) {
            const r = ctx.tileRefs.get(k.path);
            if (r && !r.selected) {
              r.selected = true;
              ctx.setTileVisual(k.path, 2);
            }
          }
          ctx.log(`internal drag start n=${gridDrag.keys.length}`);
          ctx.setStatusMsg(`Dragging ${gridDrag.keys.length} item${gridDrag.keys.length === 1 ? "" : "s"}…`);
        }
        if (gridDrag.active) updateDragGhost(ctx, ev.x, ev.y);
      },
      onMouseDrop: () => {
        const keys = gridDrag.keys;
        const dest = gridDrag.dropTarget;
        ctx.log(
          `tile drop keys=${keys?.length ?? -1}[${keys?.map((k) => k.path.split("/").pop()).join(",") ?? ""}] dest=${dest} isDir=${e.isDir}`,
        );
        finishDragState(ctx);
        if (keys && dest && e.isDir)
          void ctx.moveInto(
            dest,
            keys.filter((k) => k.path !== dest),
          );
      },
      onMouseOver: () => {
        if (gridDrag.active) {
          const draggingSelf = !!gridDrag.keys?.some((k) => k.path === key);
          if (e.isDir && !draggingSelf) {
            ctx.log(`hover target set ${key}`);
            gridDrag.dropTarget = key;
            ctx.setTileVisual(key, 2);
          }
          return;
        }
        const refs = ctx.tileRefs.get(key);
        if (!refs?.selected) ctx.setTileVisual(key, 1);
      },
      onMouseOut: () => {
        if (gridDrag.active && gridDrag.dropTarget === key) {
          gridDrag.dropTarget = null;
          ctx.setTileVisual(key, 0);
          return;
        }
        const refs = ctx.tileRefs.get(key);
        if (!refs?.selected) ctx.setTileVisual(key, 0);
      },
    };
  };
};
