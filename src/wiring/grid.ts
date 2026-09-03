// --- Grid wiring, phase 2: preview pane (tree-sitter + thumbnails), the
// shared mouse-pipeline ctx (rubber band, selection, drag prep, drop-into),
// the grid renderer, properties dialog and the menu entry builders. Runs
// AFTER the fileops wiring — gridCtx takes moveInto directly. ---

import { registerSyntaxParsers } from "../ui/syntax";
import { makePreview } from "../ui/ui-preview";
import { finishDragState, makeEntryMouseHandlers, type BandCtx, type GridMenuEntry } from "../input/grid-input";
import { makeGridRenderer } from "../ui/ui-grid";
import { makeProps } from "../ui/ui-props";
import { makeMenuEntries } from "../ui/menu-entries";
import { waitForResolution } from "../ui/ui-lookup";
import { glyph } from "../ui/glyphs";
import { dlog } from "../app/log";
import type { ListEntry } from "../ui/ui-menu";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, NavWiring } from "./types";

export const wireGrid = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  fileops: FileopsWiring;
}) => {
  const { core, nav, chrome, gridFoundation, fileops } = deps;
  const { selection, rename } = gridFoundation;
  const { byId, stripSelectable } = core.lookup;
  const { themeGet, home, state } = core;
  const uiStyle = () => core.config.ui.uiStyle;

  // --- Preview pane — widget lives in ./ui-preview ---
  registerSyntaxParsers();
  const { renderPreview } = makePreview({
    renderer: chrome.renderer,
    byId,
    colors: themeGet,
    uiStyle,
    previewEnabled: () => core.config.ui.previewEnabled,
    previewWidth: () => core.config.ui.previewWidth,
    termH: () => chrome.renderer.terminalHeight,
    cellMetrics: core.slots.cellMetrics,
    focusKey: () =>
      selection.focusIdx() >= 0 && selection.focusKeys()[selection.focusIdx()]
        ? selection.focusKeys()[selection.focusIdx()]!
        : null,
    tileRefs: selection.tileRefs,
    pushThumbJob: core.slots.pushThumbJob,
    drainThumbs: () => core.slots.drainThumbs(),
    drainIconQueue: () => core.slots.drainIconQueue(),
    nextIconId: core.slots.nextIconId,
    fallbackGlyphFor: (name) => glyph[name] ?? glyph.file!,
  });

  // Rubber-band gesture state + commit logic live in ./grid-input; this is the
  // ctx object it renders through (built here because it closes over the live
  // selection/preview state below).
  const bandCtx: BandCtx = {
    byId,
    tileRefs: selection.tileRefs,
    clearTileSelection: selection.clearTileSelection,
    setTileVisual: selection.setTileVisual,
    updateSelectionStatusReal: selection.updateSelectionStatusReal,
    renderPreview,
    setSelAnchor: (v: number | null) => {
      selection.setSelAnchor(v);
    },
  };

  // Mouse behavior shared by grid tiles AND list rows: selection (plain/ctrl/
  // shift), double-click open, drag payload prep, drop-into-folder, hover. Both
  // view modes register the exact same logic on differently-shaped containers;
  // all state lives in tileRefs + the drag module vars, keyed by path.
  const gridCtx = {
    byId,
    termW: () => chrome.renderer.terminalWidth,
    termH: () => chrome.renderer.terminalHeight,
    // --- selection deps (GridSelectionDeps) ---
    tileRefs: selection.tileRefs,
    setTileVisual: selection.setTileVisual,
    updateSelectionStatusReal: selection.updateSelectionStatusReal,
    renderPreview,
    clearTileSelection: selection.clearTileSelection,
    selectRange: selection.selectRange,
    getSelAnchor: () => selection.selAnchor(),
    setSelAnchor: (v: number | null) => {
      selection.setSelAnchor(v);
    },
    getFocusIdx: () => selection.focusIdx(),
    selPaths: selection.selPaths,
    dblClickMs: () => core.config.ui.doubleClickMs,
    dragThresholdCells: () => core.config.ui.dragThresholdCells,
    // --- nav deps (GridNavDeps) ---
    navigate: nav.navigate,
    openFileDefault: chrome.openFileDefault,
    moveInto: fileops.fileops.moveInto,
    // --- menu deps (GridMenuDeps) ---
    openContextMenu: (x: number, y: number, title: string, entries: GridMenuEntry[]) =>
      chrome.menu.openContextMenu(x, y, title, entries as ListEntry[]),
    fileEntriesFor: (key: string, isDir: boolean, x: number, y: number): GridMenuEntry[] =>
      menuEntries.fileEntriesFor(key, isDir, x, y) as GridMenuEntry[],
    closeFileMenu: chrome.menu.closeFileMenu,
    renameEditKey: rename.renameEditKey,
    finishInlineRename: rename.finishInlineRename,
    // --- host ---
    setStatusMsg: nav.setStatusMsg,
    log: (msg: string) => dlog(msg),
  };
  const finishDragCtx = () => finishDragState(gridCtx);

  const entryMouseHandlers = makeEntryMouseHandlers(gridCtx);

  // --- Grid renderer lives in ./ui-grid (tile/list-row builders, empty and
  // restricted states, thumbnail handoff, gen-counter stale guards) ---
  const { renderGrid } = makeGridRenderer({
    termW: () => chrome.renderer.terminalWidth,
    termH: () => chrome.renderer.terminalHeight,
    scroller: () => core.scrollerRef.current,
    state,
    searchQuery: () => nav.search.getQuery(),
    pathEditMode: () => chrome.toolbar.pathEditMode(),
    sw: () => core.geometry.sw,
    tileW: () => core.geometry.tileW,
    tileH: () => core.geometry.tileH,
    iconCells: () => core.geometry.iconCells,
    listRowH: () => core.config.ui.listRowHeight,
    uiStyle,
    colors: themeGet,
    previewEnabled: () => core.config.ui.previewEnabled,
    previewWidth: () => core.config.ui.previewWidth,
    viewMode: () => core.config.ui.viewMode,
    wordWrap: () => core.config.ui.wordWrap,
    reservedRight: () => (core.config.ui.previewEnabled ? core.config.ui.previewWidth : 0),
    cellMetrics: core.slots.cellMetrics,
    makeIconSlot: core.slots.makeIconSlot,
    pushThumbJob: core.slots.pushThumbJob,
    nextIconId: () => core.slots.nextIconId(),
    drainIconQueue: () => core.slots.drainIconQueue(),
    drainThumbs: () => core.slots.drainThumbs(),
    stripSelectable,
    selection,
    entryMouseHandlers,
    isCutKey: core.isCutKey,
    waitForResolution: () => waitForResolution(chrome.renderer),
    clearRenameEdit: rename.clearRenameEdit,
  });

  const props = makeProps({
    byId,
    openDialog: chrome.dialogs.openDialog,
    closeDialog: chrome.dialogs.closeDialog,
    floats: core.floats,
    setTextOnId: core.lookup.setTextOnId,
    setOnId: core.lookup.setOnId,
    stripSelectable,
    drainIconQueue: () => core.slots.drainIconQueue(),
    drainThumbs: () => core.slots.drainThumbs(),
    pushThumbJob: core.slots.pushThumbJob,
    nextIconId: core.slots.nextIconId,
    escHintBtn: core.slots.escHintBtn,
    closeFileMenu: chrome.menu.closeFileMenu,
    openContextMenu: (x, y, title, entries) => chrome.menu.openContextMenu(x, y, title, entries),
    renderAll: nav.renderAll,
    setStatusMsg: nav.setStatusMsg,
    uiStyle,
    colors: themeGet,
    home,
    makeIconSlot: core.slots.makeIconSlot,
    setIconState: core.slots.setIconState,
    fallbackGlyphFor: (name) => glyph[name] ?? glyph.file!,
    cellMetrics: core.slots.cellMetrics,
  });

  // --- Menu entry builders (what the menus contain) live in ./menu-entries;
  // the floating menu widget itself lives in ./ui-menu ---
  const menuEntries = makeMenuEntries({
    closeFileMenu: chrome.menu.closeFileMenu,
    navigate: nav.navigate,
    renderAll: nav.renderAll,
    renderGrid,
    openTerminalHere: fileops.terminal.openTerminalHere,
    clipboard: fileops.fileops.clipboard,
    pasteSmart: fileops.fileops.pasteSmart,
    confirmEmptyTrash: fileops.confirmEmptyTrash,
    confirmDeleteForever: fileops.confirmDeleteForever,
    ejectDevice: chrome.chrome.ejectDevice,
    mountDevice: chrome.chrome.mountDevice,
    inTrashView: core.inTrashView,
    tileRefs: selection.tileRefs,
    selPaths: selection.selPaths,
    openFileDefault: chrome.openFileDefault,
    setClipboard: fileops.fileops.setClipboard,
    startInlineRename: rename.startInlineRename,
    startInlineCreate: rename.startInlineCreate,
    trashPaths: fileops.trash.trashPaths,
    restoreFromTrash: fileops.trash.restoreFromTrash,
    openProperties: props.openProperties,
    selectAll: selection.selectAll,
    cwd: () => state.cwd,
    sortState: state,
  });

  return {
    renderPreview,
    renderGrid,
    finishDrag: finishDragCtx,
    bandCtx,
    props,
    menuEntries,
  };
};
