// --- Grid wiring, phase 2: preview pane (tree-sitter + thumbnails), the
// shared mouse-pipeline ctx (rubber band, selection, drag prep, drop-into),
// the grid renderer, properties dialog and the menu entry builders. Runs
// AFTER the fileops wiring — gridCtx takes moveInto directly. ---

import path from "node:path";
import { registerSyntaxParsers } from "../ui/syntax";
import { availableCompressionFormats, canExtract, compressionExt, compressionHint } from "../fs/archive";
import { appsForFile, launchApp } from "../fs/apps";
import type { makePick } from "../ui/ui-pick";
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
import type { PluginsWiring } from "./plugins";

export const wireGrid = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  fileops: FileopsWiring;
  plugins: PluginsWiring;
  // pick overlay wires LAST (wiring/keymap) — lazy getter, action-time only
  getPick(): ReturnType<typeof makePick>;
}) => {
  const { core, nav, chrome, gridFoundation, fileops, plugins, getPick } = deps;
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
    pluginPreview: async (filePath) => {
      // path.extname, not split(".").pop(): dotfiles (".bashrc") have no ext,
      // "foo." has none either — the naive split claims "bashrc"/"".
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (!ext) return null;
      // first matching ext in load order wins; a throwing/empty render falls
      // through to the next plugin, then to core — never a blank pane.
      for (const p of plugins.plugins) {
        for (const pv of p.preview) {
          if (!pv.exts.includes(ext)) continue;
          try {
            const text = await pv.render(filePath);
            if (typeof text === "string" && text.length) return text;
          } catch {}
        }
      }
      return null;
    },
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
    recursiveSearch: () => core.config.ui.recursiveSearch,
    pathEditMode: () => chrome.toolbar.pathEditMode(),
    // column math reads the EFFECTIVE sidebar width (hover drawer rewrites it
    // as the sidebar collapses); core.geometry.sw is the config width used for
    // sidebar content, which stays baked at full size and clips
    sw: () => core.geometry.sidebarEff,
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
    reservedRight: () => core.geometry.previewEff,
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
    notify: chrome.notify,
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
    newTab: nav.newTab,
    // "Open With…": enumerate handlers for the file's mime, then let the
    // generic pick overlay choose (same pick instance the compress picker uses)
    openWith: (p) => {
      void appsForFile(p).then((apps) => {
        if (!apps.length) {
          chrome.notify("No applications found", "open", "error");
          return;
        }
        getPick().open({
          title: "Open with…",
          placeholder: "Filter applications…",
          items: apps.map((a) => ({
            label: a.name,
            hint: a.id.replace(/\.desktop$/, ""),
            run: () => {
              launchApp(a.file, p, (err) => dlog(`gio launch failed: ${err.message}`));
              chrome.notify(`Opening ${path.basename(p)} · ${a.name}`, "open");
            },
          })),
        });
      });
    },
    renderAll: nav.renderAll,
    renderGrid,
    openTerminalHere: fileops.terminal.openTerminalHere,
    connectServer: chrome.connectServer,
    disconnectServer: chrome.disconnectServer,
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
    duplicate: (paths) => void fileops.fileops.duplicate(paths),
    startInlineRename: rename.startInlineRename,
    startInlineCreate: rename.startInlineCreate,
    startBulkRename: gridFoundation.startBulkRename,
    trashPaths: fileops.trash.trashPaths,
    restoreFromTrash: fileops.trash.restoreFromTrash,
    openProperties: props.openProperties,
    selectAll: selection.selectAll,
    cwd: () => state.cwd,
    canExtract: (p) => canExtract(p),
    extractArchive: (files, dest) => {
      void fileops.fileops.extractArchive(files, dest);
    },
    compressionFormats: () => availableCompressionFormats(),
    compressTo: (paths) => {
      const cwd = state.cwd;
      getPick().open({
        title: "Compress to…",
        placeholder: "Filter formats…",
        items: availableCompressionFormats().map((fmt) => ({
          label: compressionExt(fmt),
          hint: compressionHint(fmt),
          run: () => {
            void fileops.fileops.compressPaths(paths, fmt, cwd);
          },
        })),
      });
    },
    sortState: state,
    plugins: () => plugins.plugins,
    onPluginError: (name, err) => {
      const msg = `plugin ${name} failed: ${err instanceof Error ? err.message : err}`;
      dlog(msg);
      try {
        chrome.notify(msg, "plugins");
      } catch {}
    },
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
