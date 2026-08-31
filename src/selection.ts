// --- Selection + keyboard-focus state: the single source of truth for "which
// tiles are selected/focused" shared by the grid render, mouse pipeline
// (grid-input), OSC 72 drop targeting, keyboard router and status bar. The
// focus/anchor lets and the tileRefs map live HERE (not index) so ui-grid and
// keymap reach them through one injected object. Visual painting (surfaces,
// icon states) still flows through ctx — no renderer imports. ---
import { readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { applySurface, tileSurface, type UiStyle } from "./style";
import { fmtBytes } from "./propsinfo";
import type { Theme } from "./config";
import type { ClipItem } from "./grid-input";

export type SelTileRef = {
  iconSpec?: any;
  iconSlotId?: string;
  selected: boolean;
  baseFg: string;
  tileId: string;
  labelId: string;
  isDir: boolean;
};

export type SelectionCtx = {
  colors(): Theme & Record<string, any>;
  uiStyle(): UiStyle;
  byId(id: string): any;
  setIconState(spec: any, mode: number): void;
  isCutKey(key: string): boolean;
  scroller(): any | null;
  viewH(): number;
  rowHInit(): number;
  renderPreview(): void | Promise<void>;
};

export type Selection = ReturnType<typeof makeSelection>;

export const makeSelection = (ctx: SelectionCtx) => {
  const tileRefs = new Map<string, SelTileRef>();

  // keyboard focus over tiles
  let focusKeys: string[] = [];
  let focusIdx = -1;
  let colsAtBuild = 1;
  // per-row height of the last build (TILE_H for grid, 1 for list) — keyboard
  // scrolling uses it to page by the right amount in either view mode
  let rowHAtBuild = ctx.rowHInit();
  // anchor tile for shift+click range selection (index into focusKeys)
  let selAnchor: number | null = null;

  const setTileVisual = (key: string, mode: 0 | 1 | 2): void => {
    const refs = tileRefs.get(key);
    if (!refs) return;
    const cut = mode === 0 && !refs.selected && ctx.isCutKey(key);
    ctx.setIconState(refs.iconSpec, cut ? 3 : mode);
    if (!refs.iconSpec) {
      // thumbnail slots have no state rasters — fade the whole slot instead
      try {
        const slot: any = ctx.byId(refs.iconSlotId ?? "");
        if (slot) slot.opacity = cut ? 0.45 : 1;
      } catch {}
    }
    const labelReal: any = ctx.byId(refs.labelId);
    if (labelReal) {
      try { labelReal.fg = mode === 2 ? ctx.colors().accent : cut ? ctx.colors().sidebarFgMuted : refs.baseFg; } catch {}
    }
    const tileReal: any = ctx.byId(refs.tileId);
    if (tileReal) {
      const state = mode === 2 ? "selected" : mode === 1 ? "hover" : cut ? "cut" : "rest";
      applySurface(tileReal, tileSurface(ctx.uiStyle(), ctx.colors(), state));
    }
  };

  const tileStates = (dim: boolean): Array<{ fg: string; bg: string }> => {
    const norm = dim ? ctx.colors().sidebarFgMuted : ctx.colors().sidebarFg;
    return [
      { fg: norm, bg: ctx.colors().bg },
      { fg: norm, bg: ctx.colors().hoverBg },
      { fg: ctx.colors().accent, bg: ctx.colors().accentBg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg }, // 3 = cut (pending move)
    ];
  };

  const selPaths = (): ClipItem[] => {
    const out: ClipItem[] = [];
    tileRefs.forEach((r, k) => { if (r.selected) out.push({ path: k, isDir: r.isDir }); });
    return out;
  };

  let selStatusGen = 0;
  const updateSelectionStatusReal = (): void => {
    const gen = ++selStatusGen;
    const sel: { key: string; isDir: boolean }[] = [];
    tileRefs.forEach((r, k) => { if (r.selected) sel.push({ key: k, isDir: r.isDir }); });
    const setStatus = (s: string) => {
      if (gen !== selStatusGen) return;
      const status: any = ctx.byId("tfm-status-label");
      if (status) { try { status.content = s; } catch {} }
    };
    if (sel.length === 0) { setStatus(""); return; }
    // total size of the selected files (dirs contribute their item count instead)
    let bytes = 0;
    for (const s of sel) {
      if (!s.isDir) { try { bytes += statSync(s.key).size; } catch {} }
    }
    const dirs = sel.filter((s) => s.isDir);
    if (dirs.length === 0) {
      setStatus(`${sel.length} selected${bytes > 0 ? ` · ${fmtBytes(bytes)}` : ""}`);
      return;
    }
    void (async () => {
      let contained = 0;
      await Promise.all(dirs.map(async (d) => {
        try { contained += (await readdir(d.key)).length; } catch {}
      }));
      const bits = [`${sel.length} selected`];
      if (bytes > 0) bits.push(fmtBytes(bytes));
      if (dirs.length === 1 && sel.length === 1) bits.push(`${contained} items`);
      setStatus(bits.join(" · "));
    })();
  };

  const clearTileSelection = (): void => {
    tileRefs.forEach((refs, k) => {
      if (refs.selected) { refs.selected = false; setTileVisual(k, 0); }
    });
    updateSelectionStatusReal();
  };

  const selectRange = (from: number, to: number): void => {
    clearTileSelection();
    if (focusKeys.length === 0) return;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(focusKeys.length - 1, Math.max(from, to));
    for (let i = lo; i <= hi; i++) {
      const k = focusKeys[i]!;
      const r = tileRefs.get(k);
      if (r) { r.selected = true; setTileVisual(k, 2); }
    }
  };

  // arrows and clicks drive the SAME single selection; there is no separate
  // focus highlight
  const selectTileAt = (idx: number): boolean => {
    if (idx < 0 || idx >= focusKeys.length) return false;
    clearTileSelection();
    const key = focusKeys[idx]!;
    const refs = tileRefs.get(key);
    if (refs) { refs.selected = true; setTileVisual(key, 2); }
    focusIdx = idx;
    void ctx.renderPreview();
    const scroller = ctx.scroller();
    if (scroller) {
      try {
        const row = Math.floor(idx / colsAtBuild);
        const vh = ctx.viewH();
        const top = scroller.scrollTop;
        if (row * rowHAtBuild < top) scroller.scrollTo({ x: 0, y: row * rowHAtBuild });
        else if ((row + 1) * rowHAtBuild > top + vh) scroller.scrollTo({ x: 0, y: (row + 1) * rowHAtBuild - vh });
      } catch {}
    }
    return true;
  };

  const moveFocus = (dx: number, dy: number): boolean => {
    if (focusKeys.length === 0) return false;
    let next = focusIdx === -1 ? 0 : focusIdx + dx + dy * colsAtBuild;
    next = Math.max(0, Math.min(focusKeys.length - 1, next));
    if (next === focusIdx) return false;
    return selectTileAt(next);
  };

  const selectAll = (): void => {
    tileRefs.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
    updateSelectionStatusReal();
  };

  // re-apply resting visuals after a cut/copy/paste so dimming tracks the clipboard
  const refreshCutVisuals = (): void => {
    tileRefs.forEach((refs, key) => { if (!refs.selected) setTileVisual(key, 0); });
  };

  return {
    tileRefs,
    // let accessors — renderGrid (ui-grid) writes at every rebuild tail, the
    // keyboard router reads for paging/extend; never snapshot these
    focusKeys: (): string[] => focusKeys,
    setFocusKeys: (keys: string[]): void => { focusKeys = keys; },
    focusIdx: (): number => focusIdx,
    setFocusIdx: (v: number): void => { focusIdx = v; },
    colsAtBuild: (): number => colsAtBuild,
    setCols: (v: number): void => { colsAtBuild = v; },
    rowHAtBuild: (): number => rowHAtBuild,
    setRowH: (v: number): void => { rowHAtBuild = v; },
    selAnchor: (): number | null => selAnchor,
    setSelAnchor: (v: number | null): void => { selAnchor = v; },
    // methods
    setTileVisual,
    tileStates,
    selPaths,
    updateSelectionStatusReal,
    clearTileSelection,
    selectRange,
    selectTileAt,
    moveFocus,
    selectAll,
    refreshCutVisuals,
  };
};
