// --- Selection + keyboard-focus state: the single source of truth for "which
// tiles are selected/focused" shared by the grid render, mouse pipeline
// (grid-input), OSC 72 drop targeting, keyboard router and status bar. The
// focus/anchor lets and the tileRefs map live HERE (not index) so ui-grid and
// keymap reach them through one injected object. Visual painting (surfaces,
// icon states) still flows through ctx — no renderer imports. ---
import { readdir } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { fmtBytes, inodeKey } from "../fs/propsinfo";
import type { Theme } from "../config/config";
import type { ClipItem } from "../lib/file-op-protocol";
import { TileVisual, type TileVisualMode } from "./grid-input";
import { SelectIdx, type IconSpec, type SetIconState } from "../lib/icon-state";

import type { MaybeNode, ScrollerLike } from "../lib/node-like";

export type SelTileRef = {
  // Are this ref's nodes LIVE? The windowed grid registers a ref for EVERY
  // entry up front (the selection contract is window-blind) and a row that
  // slides out of the window is REAPED — its nodes are destroyed. The old
  // encoding was the PRESENCE of the optional fields (iconSpec/iconSlotId):
  // a reaped row KEPT them, so a paint aimed at it named a dead icon spec
  // and wrote to destroyed renderables. ONE explicit flag, owned by the grid
  // (it builds the rows and reaps them).
  mounted: boolean;
  // the tile's icon lives in the SELECT family (rest / hover / selected / cut)
  iconSpec?: IconSpec<"select">;
  iconSlotId?: string;
  selected: boolean;
  baseFg: string;
  tileId: string;
  labelId: string;
  isDir: boolean;
  // Width available to the inline rename editor for this entry. Grid tiles
  // publish their label width; list rows publish their name-column width so
  // the editor never inherits the unrelated grid tile-width setting.
  renameWidth?: number;
  // grid tiles with room for the configured hover distance/direction move
  // their icon on hover (rest layout untouched); the rest keep the highlight.
  hoverLift?: boolean;
};

export type SelectionCtx = {
  colors(): Theme;
  byId(id: string): MaybeNode;
  setText(id: string, s: string): void;
  setIconState: SetIconState;
  isCutKey(key: string): boolean;
  scroller(): ScrollerLike | null;
  viewH(): number;
  rowHInit(): number;
  renderPreview(): void | Promise<void>;
  onSelection?: (paths: string[]) => void;
  // false for an inactive pane: its selection must not drive the shared status
  // bar or emit plugin selection events (the active pane owns those). Absent =
  // always active (single-pane callers / tests).
  isActive?: () => boolean;
  // the directory listing behind the "N items" count. Injectable so the
  // stale-async guard can be decided by a test instead of an fs race;
  // absent = the real fs read.
  readDir?: (dir: string) => Promise<string[]>;
  // paint the tile surface for a visual state. The surface RULES (solid vs
  // outline, rest/hover/selected/cut, transparent-bg force) live in ui/style.ts;
  // they arrive through ctx so input/ never imports the ui/ PAINT layer
  // upward. input/ owns the selection STATE, ui/ owns the look.
  paintTile(node: MaybeNode, state: "rest" | "hover" | "selected" | "cut"): void;
};

export type Selection = ReturnType<typeof makeSelection>;

// --- the focus state: ONE explicit record ---
//
// The focus used to be an INDEX into `focusKeys` (an array replaced wholesale
// on every rebuild) plus a SECOND sentinel (`selAnchor: number | null`) that
// two different call sites resolved with two different policies. Both are now
// PATHS — stable identities that survive a re-sort — and the navigable index
// is DERIVED from them, so it can never point past the end of the listing.

/** Where the keyboard focus is. */
export type FocusState =
  /** no tile holds the focus; a range origin may still be remembered */
  | { kind: "none"; anchorPath: string | null }
  /** a tile holds the focus; `anchorPath` is the range-extend origin */
  | { kind: "focused"; path: string; anchorPath: string | null };

/**
 * A snapshot of the focus, taken before a rebuild that may span an await.
 *
 * The restore re-applies it ONLY when nothing else claimed the focus in the
 * meantime — a click during the park owns the keyboard, the pre-rebuild
 * snapshot must not steal it back.
 */
export type FocusSnapshot = {
  readonly focusPath: string | null;
  readonly anchorPath: string | null;
};

export const makeSelection = (ctx: SelectionCtx) => {
  const tileRefs = new Map<string, SelTileRef>();
  // the directory listing behind the "N items" count — the seam lets a test
  // decide when the (async) count lands instead of racing the filesystem
  const readDir = ctx.readDir ?? ((dir: string) => readdir(dir));

  // keyboard focus over tiles
  let focusKeys: string[] = [];
  let focus: FocusState = { kind: "none", anchorPath: null };
  let colsAtBuild = 1;
  // per-row height of the last build (TILE_H for grid, 1 for list) — keyboard
  // scrolling uses it to page by the right amount in either view mode
  let rowHAtBuild = ctx.rowHInit();
  // the DERIVED focus index — cached, invalidated by every focus/keys write
  // (the listing can hold thousands of entries; the index is read per keypress)
  let focusIdxCache = -1;
  let focusIdxDirty = true;

  const invalidateFocusIdx = (): void => {
    focusIdxDirty = true;
  };

  // the navigable index of the focused tile (-1 = no focus in this listing)
  const currentFocusIdx = (): number => {
    if (!focusIdxDirty) return focusIdxCache;
    focusIdxCache = focus.kind === "focused" ? focusKeys.indexOf(focus.path) : -1;
    focusIdxDirty = false;
    return focusIdxCache;
  };

  // The listing is replaced wholesale on every rebuild: the focus and the
  // range origin follow their FILES (an index would point at a DIFFERENT
  // file after a re-sort), and a file that left the listing drops them.
  const setFocusKeys = (keys: string[]): void => {
    focusKeys = keys;
    const anchorPath = focus.anchorPath !== null && keys.includes(focus.anchorPath) ? focus.anchorPath : null;
    focus =
      focus.kind === "focused" && keys.includes(focus.path)
        ? { kind: "focused", path: focus.path, anchorPath }
        : { kind: "none", anchorPath };
    invalidateFocusIdx();
  };

  // Move the focus to a FILE. A plain move re-anchors the range origin (the
  // mouse press does too); a range-extend keeps its own origin.
  const setFocusPath = (path: string | null, opts?: { keepAnchor?: boolean }): void => {
    if (path === null) {
      focus = { kind: "none", anchorPath: focus.anchorPath };
    } else {
      focus = { kind: "focused", path, anchorPath: opts?.keepAnchor ? focus.anchorPath : path };
    }
    invalidateFocusIdx();
  };

  // Pin (or clear) the range origin. It is independent of the focus: a range
  // origin outlives the focused file (the file was deleted mid-range).
  const setAnchorPath = (path: string | null): void => {
    focus = focus.kind === "focused" ? { ...focus, anchorPath: path } : { kind: "none", anchorPath: path };
  };

  // THE anchor default — ONE rule for every site: the pinned origin, else
  // the focus, else the first tile. The resolved origin is PINNED so it
  // survives the focus moving away from it (the old code had two policies:
  // some sites defaulted to the focus, others to null).
  const ensureAnchor = (): number => {
    const pinned = focus.anchorPath !== null ? focusKeys.indexOf(focus.anchorPath) : -1;
    if (pinned >= 0) return pinned;
    if (focus.kind === "focused") {
      const focused = focusKeys.indexOf(focus.path);
      if (focused >= 0) {
        focus = { ...focus, anchorPath: focus.path };
        return focused;
      }
    }
    const first = focusKeys[0];
    if (first !== undefined) focus = { ...focus, anchorPath: first };
    return 0;
  };

  // A snapshot of the focus, taken before a rebuild that may span an await.
  const captureFocus = (): FocusSnapshot => ({
    focusPath: focus.kind === "focused" ? focus.path : null,
    anchorPath: focus.anchorPath,
  });

  // Re-apply a snapshot after a rebuild that spanned an await. It NEVER
  // overwrites a live focus: a click during the park owns the keyboard, and
  // the pre-rebuild snapshot must not steal it back. A file that vanished
  // while the rebuild ran is not restored either.
  const restoreFocus = (snap: FocusSnapshot): boolean => {
    if (focus.kind === "focused") return false;
    if (snap.focusPath === null) return false;
    if (!focusKeys.includes(snap.focusPath)) return false;
    const anchorPath = snap.anchorPath !== null && focusKeys.includes(snap.anchorPath) ? snap.anchorPath : null;
    focus = { kind: "focused", path: snap.focusPath, anchorPath };
    invalidateFocusIdx();
    return true;
  };

  const setTileVisual = (key: string, mode: TileVisualMode): void => {
    const refs = tileRefs.get(key);
    if (!refs) return;
    // a ref whose nodes are GONE (a reaped window row) is not painted: the
    // icon-state event would name a dead spec and the node writes would land
    // on destroyed renderables. The selection STATE (selected) still lives
    // in the ref — it is re-painted when the row is built again.
    if (!refs.mounted) return;
    const cut = mode === TileVisual.Rest && !refs.selected && ctx.isCutKey(key);
    ctx.setIconState(refs.iconSpec, cut ? SelectIdx.Cut : mode);
    if (!refs.iconSpec) {
      // thumbnail slots have no state rasters — fade the whole slot instead
      try {
        const slot = ctx.byId(refs.iconSlotId ?? "");
        if (slot) slot.opacity = cut ? 0.45 : 1;
      } catch {}
    }
    const labelReal = ctx.byId(refs.labelId);
    if (labelReal) {
      try {
        // hover lifts the label to white (readable on the blue hover fill);
        // rest keeps the tile's own baseFg. No-op in presets (white == fg).
        labelReal.fg =
          mode === TileVisual.Selected
            ? ctx.colors().accent
            : mode === TileVisual.Hover
              ? ctx.colors().white
              : cut
                ? ctx.colors().sidebarFgMuted
                : refs.baseFg;
      } catch {}
    }
    const tileReal = ctx.byId(refs.tileId);
    if (tileReal) {
      const state =
        mode === TileVisual.Selected ? "selected" : mode === TileVisual.Hover ? "hover" : cut ? "cut" : "rest";
      ctx.paintTile(tileReal, state);
    }
  };

  const tileStates = (dim: boolean): Array<{ fg: string; bg: string }> => {
    const norm = dim ? ctx.colors().sidebarFgMuted : ctx.colors().sidebarFg;
    return [
      { fg: norm, bg: ctx.colors().bg }, // Rest
      { fg: norm, bg: ctx.colors().hoverBg }, // Hover
      { fg: ctx.colors().accent, bg: ctx.colors().accentBg }, // Selected
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg }, // Cut (pending move)
    ];
  };

  const selPaths = (): ClipItem[] => {
    const out: ClipItem[] = [];
    tileRefs.forEach((r, k) => {
      if (r.selected) out.push({ path: k, isDir: r.isDir });
    });
    return out;
  };

  // --- the status label: one writer, two guards ---
  //
  // The label ("tfm-status-label") is GLOBAL (both panes share it) and the
  // "N items" count of a directory selection is ASYNC, so a write can land
  // long after the request that asked for it. Two guards sit AT THE WRITE:
  //
  //   - the ticket: an opaque token, replaced by every newer request. Only
  //     the CURRENT request may write. (The old bare integer counter said
  //     the same thing, but an integer is easy to compare against the wrong
  //     thing, and "no request yet" had no representation at all.)
  //   - the pane: the label belongs to the ACTIVE pane, so a pane that lost
  //     the focus while its count was in flight must not paint over the new
  //     pane's status.
  type StatusTicket = { readonly kind: "status-ticket" };
  let statusTicket: StatusTicket | null = null;

  // The last emitted selection signature (the paths joined): rubber-band
  // moves and rebuilds call updateSelectionStatusReal constantly with
  // unchanged paths — plugins must not be spammed with identical events.
  // `null` = NOTHING has been emitted yet; `""` = the EMPTY selection was
  // emitted. The two must not collide: with `""` as the initial value the
  // first observation of an empty selection looked like a repeat, so the
  // transition INTO the empty selection never reached the plugin stream.
  let lastEmittedSel: string | null = null;

  const updateSelectionStatusReal = (): void => {
    // an inactive pane's selection never drives the shared status/events
    if (ctx.isActive && !ctx.isActive()) return;
    try {
      const paths = selPaths().map((s) => s.path);
      const sig = paths.join("\0");
      if (sig !== lastEmittedSel) {
        lastEmittedSel = sig;
        ctx.onSelection?.(paths);
      }
    } catch {}
    // this request owns the label from here on
    const ticket: StatusTicket = { kind: "status-ticket" };
    statusTicket = ticket;
    const sel: { key: string; isDir: boolean }[] = [];
    tileRefs.forEach((r, k) => {
      if (r.selected) sel.push({ key: k, isDir: r.isDir });
    });
    const setStatus = (s: string) => {
      // a newer request owns the label now
      if (statusTicket !== ticket) return;
      // the pane may have lost the focus while the directory count was in
      // flight — the label is shared, so a stale write would land on the
      // NEW pane's status
      if (ctx.isActive && !ctx.isActive()) return;
      ctx.setText("tfm-status-label", s);
    };
    if (sel.length === 0) {
      setStatus("");
      return;
    }
    // total size is on-disk cost: links count their own bytes (the copy engine
    // preserves them via readlink/symlink, never the target), and hardlinked
    // names sharing one dev:ino count their body once — like du. lstat never
    // reports a link as a directory, so links-to-dirs land in bytes while real
    // dirs contribute their item count below instead.
    let bytes = 0;
    const seen = new Set<string>();
    for (const s of sel) {
      try {
        const lst = lstatSync(s.key);
        if (lst.isDirectory()) continue;
        const k = inodeKey(lst);
        if (seen.has(k)) continue;
        seen.add(k);
        bytes += lst.size;
      } catch {}
    }
    const dirs = sel.filter((s) => s.isDir);
    if (dirs.length === 0) {
      setStatus(`${sel.length} selected${bytes > 0 ? ` · ${fmtBytes(bytes)}` : ""}`);
      return;
    }
    void (async () => {
      let contained = 0;
      await Promise.all(
        dirs.map(async (d) => {
          try {
            contained += (await readDir(d.key)).length;
          } catch {}
        }),
      );
      const bits = [`${sel.length} selected`];
      if (bytes > 0) bits.push(fmtBytes(bytes));
      if (dirs.length === 1 && sel.length === 1) bits.push(`${contained} items`);
      setStatus(bits.join(" · "));
    })();
  };

  const clearTileSelection = (): void => {
    tileRefs.forEach((refs, k) => {
      if (refs.selected) {
        refs.selected = false;
        setTileVisual(k, TileVisual.Rest);
      }
    });
    updateSelectionStatusReal();
  };

  const selectRange = (from: number, to: number): void => {
    clearTileSelection();
    if (focusKeys.length === 0) return;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(focusKeys.length - 1, Math.max(from, to));
    for (let i = lo; i <= hi; i++) {
      const k = focusKeys[i];
      if (k === undefined) continue;
      const r = tileRefs.get(k);
      if (r) {
        r.selected = true;
        setTileVisual(k, TileVisual.Selected);
      }
    }
  };

  // arrows and clicks drive the SAME single selection; there is no separate
  // focus highlight
  const selectTileAt = (idx: number, keepAnchor = false): boolean => {
    if (idx < 0 || idx >= focusKeys.length) return false;
    clearTileSelection();
    const key = focusKeys[idx];
    if (key === undefined) return false;
    const refs = tileRefs.get(key);
    if (refs) {
      refs.selected = true;
      setTileVisual(key, TileVisual.Selected);
    }
    // a plain move re-anchors (the mouse press does too); range-extend passes
    // keepAnchor so its own origin survives the focus jump
    setFocusPath(key, { keepAnchor });
    void ctx.renderPreview();
    const scroller = ctx.scroller();
    if (scroller) {
      try {
        const row = Math.floor(idx / colsAtBuild);
        const vh = ctx.viewH();
        const top = scroller.scrollTop;
        if (row * rowHAtBuild < top) scroller.scrollTo?.({ x: 0, y: row * rowHAtBuild });
        else if ((row + 1) * rowHAtBuild > top + vh) scroller.scrollTo?.({ x: 0, y: (row + 1) * rowHAtBuild - vh });
      } catch {}
    }
    return true;
  };

  const moveFocus = (dx: number, dy: number): boolean => {
    if (focusKeys.length === 0) return false;
    const current = currentFocusIdx();
    let next = current === -1 ? 0 : current + dx + dy * colsAtBuild;
    next = Math.max(0, Math.min(focusKeys.length - 1, next));
    if (next === current) return false;
    return selectTileAt(next);
  };

  // page jump for the pageUp/pageDown keybinds: visible rows (viewH/rowH
  // from the build tail) times the column count, clamped to the listing
  const pageBy = (dir: number): boolean => {
    if (focusKeys.length === 0) return false;
    const rows = Math.max(1, Math.floor(ctx.viewH() / Math.max(1, rowHAtBuild)));
    const step = rows * Math.max(1, colsAtBuild);
    const current = currentFocusIdx();
    const base = current === -1 ? (dir > 0 ? -1 : focusKeys.length) : current;
    const next = Math.max(0, Math.min(focusKeys.length - 1, base + dir * step));
    if (next === current) return false;
    return selectTileAt(next);
  };

  const selectAll = (): void => {
    tileRefs.forEach((r, k) => {
      r.selected = true;
      setTileVisual(k, TileVisual.Selected);
    });
    // re-anchor to the focus: a later shift+arrow must extend from here, not
    // from a stale pre-selectAll origin
    setAnchorPath(focus.kind === "focused" ? focus.path : null);
    updateSelectionStatusReal();
  };

  // flip every tile's membership (yazi ctrl+r)
  const invertSelection = (): void => {
    tileRefs.forEach((r, k) => {
      r.selected = !r.selected;
      setTileVisual(k, r.selected ? TileVisual.Selected : TileVisual.Rest);
    });
    setAnchorPath(focus.kind === "focused" ? focus.path : null);
    updateSelectionStatusReal();
  };

  // flip the focused tile only, focus stays put (yazi space toggles; unlike
  // yazi there is no auto-advance — repeat space walks with arrows)
  const toggleFocused = (): boolean => {
    const idx = currentFocusIdx();
    if (idx < 0 || idx >= focusKeys.length) return false;
    const key = focusKeys[idx];
    if (key === undefined) return false;
    const refs = tileRefs.get(key);
    if (!refs) return false;
    refs.selected = !refs.selected;
    setTileVisual(key, refs.selected ? TileVisual.Selected : TileVisual.Rest);
    updateSelectionStatusReal();
    void ctx.renderPreview();
    return true;
  };

  // select an explicit set of paths (plugin api.select). Paths not currently
  // listed are ignored; focus lands on the first match. Used to drive the
  // selection from outside the mouse/keyboard pipeline.
  const selectPaths = (paths: string[]): void => {
    // clear refs inline: clearTileSelection() would emit a spurious empty
    // selection event to plugins before the real one
    tileRefs.forEach((refs, k) => {
      if (refs.selected) {
        refs.selected = false;
        setTileVisual(k, TileVisual.Rest);
      }
    });
    const want = new Set(paths);
    let firstIdx = -1;
    for (let i = 0; i < focusKeys.length; i++) {
      const k = focusKeys[i];
      if (k === undefined || !want.has(k)) continue;
      const r = tileRefs.get(k);
      if (!r) continue;
      r.selected = true;
      setTileVisual(k, TileVisual.Selected);
      if (firstIdx < 0) firstIdx = i;
    }
    // focus/anchor always follow the new selection (none when nothing matched)
    if (firstIdx >= 0) {
      const key = focusKeys[firstIdx];
      if (key !== undefined) setFocusPath(key);
    } else {
      setFocusPath(null);
      setAnchorPath(null);
    }
    if (firstIdx >= 0) {
      void ctx.renderPreview();
      const scroller = ctx.scroller();
      if (scroller) {
        try {
          const row = Math.floor(firstIdx / colsAtBuild);
          const vh = ctx.viewH();
          const top = scroller.scrollTop;
          if (row * rowHAtBuild < top) scroller.scrollTo?.({ x: 0, y: row * rowHAtBuild });
          else if ((row + 1) * rowHAtBuild > top + vh) scroller.scrollTo?.({ x: 0, y: (row + 1) * rowHAtBuild - vh });
        } catch {}
      }
    }
    updateSelectionStatusReal();
  };

  // re-apply resting visuals after a cut/copy/paste so dimming tracks the clipboard
  const refreshCutVisuals = (): void => {
    tileRefs.forEach((refs, key) => {
      if (!refs.selected) setTileVisual(key, TileVisual.Rest);
    });
  };

  return {
    tileRefs,
    // let accessors — renderGrid (ui-grid) writes at every rebuild tail, the
    // keyboard router reads for paging/extend; never snapshot these
    focusKeys: (): string[] => focusKeys,
    setFocusKeys,
    // the focus state — ONE record: the focused FILE and the range origin.
    // The navigable index is derived, so it can never point past the end of
    // the listing.
    focusState: (): FocusState => focus,
    focusPath: (): string | null => (focus.kind === "focused" ? focus.path : null),
    focusIdx: (): number => currentFocusIdx(),
    anchorPath: (): string | null => focus.anchorPath,
    anchorIdx: (): number => (focus.anchorPath !== null ? focusKeys.indexOf(focus.anchorPath) : -1),
    // THE anchor default (one rule for every site) — resolves AND pins it
    ensureAnchor,
    setFocusPath,
    setAnchorPath,
    // the rebuild protocol: capture before an await, restore after
    captureFocus,
    restoreFocus,
    colsAtBuild: (): number => colsAtBuild,
    setCols: (v: number): void => {
      colsAtBuild = v;
    },
    rowHAtBuild: (): number => rowHAtBuild,
    setRowH: (v: number): void => {
      rowHAtBuild = v;
    },
    // methods
    setTileVisual,
    tileStates,
    selPaths,
    updateSelectionStatusReal,
    clearTileSelection,
    selectRange,
    selectTileAt,
    moveFocus,
    pageBy,
    selectAll,
    invertSelection,
    toggleFocused,
    selectPaths,
    refreshCutVisuals,
  };
};
