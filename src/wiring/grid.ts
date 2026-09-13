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
import {
  finishDragState,
  gridDrag,
  makeEntryMouseHandlers,
  type BandCtx,
  type GridMenuEntry,
} from "../input/grid-input";
import { makeGridRenderer } from "../ui/ui-grid";
import { makeFileAnim } from "../ui/ui-grid-anim";
import { makeProps } from "../ui/ui-props";
import { makeMenuEntries } from "../ui/menu-entries";
import { waitForResolution } from "../ui/ui-lookup";
import { glyph } from "../ui/glyphs";
import { activeFacade } from "../app/panes";
import { isVirtualUri } from "../fs/uri";
import { isTrashFilesDir } from "../fs/fsutil";
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
  const { selection, selections, rename } = gridFoundation;
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
    // skip preview rebuilds while the pane is collapsed (auto-hide) — the
    // effective width is 0 then, and the work is invisible native churn
    visible: () => core.geometry.previewEff > 0 && core.config.ui.previewEnabled,
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

  // Focus a pane on mouse press WITHOUT a full renderAll: a grid rebuild mid-
  // gesture would destroy the pressed tile's node and break the drag. Only the
  // focus-dependent things repaint — pane dim, the sidebar cwd highlight (moved
  // in place, no rebuild), the newly-active preview + status. The per-pane top
  // bars and tab strips already show the right thing, so re-rendering them here
  // only re-created their icon slots (fallback-glyph flash on every pane click).
  const focusPane = (pane: 0 | 1): void => {
    if (!core.config.ui.dualPane) return;
    const prev = core.panes.active;
    if (prev === pane) return;
    // a selection must not survive a pane switch: drop the pane we're leaving
    selections[prev]!.clearTileSelection();
    core.setActivePane(pane);
    core.refreshPaneFocus();
    try {
      chrome.chrome.normalizePlaces();
      plugins.refreshSlots?.();
    } catch {}
    void renderPreview();
    selections[pane].updateSelectionStatusReal();
  };

  // Mouse behavior shared by grid tiles AND list rows: selection (plain/ctrl/
  // shift), double-click open, drag payload prep, drop-into-folder, hover. Built
  // PER PANE so a tile's handlers always act on their own pane's selection/map
  // regardless of focus timing. All state lives in tileRefs + the drag module
  // vars, keyed by path.
  const makePaneGridCtx = (pane: 0 | 1) => {
    const s = selections[pane];
    return {
      byId,
      termW: () => chrome.renderer.terminalWidth,
      termH: () => chrome.renderer.terminalHeight,
      // --- selection deps (GridSelectionDeps) ---
      tileRefs: s.tileRefs,
      setTileVisual: s.setTileVisual,
      updateSelectionStatusReal: s.updateSelectionStatusReal,
      renderPreview,
      clearTileSelection: s.clearTileSelection,
      selectRange: s.selectRange,
      getSelAnchor: () => s.selAnchor(),
      setSelAnchor: (v: number | null) => {
        s.setSelAnchor(v);
      },
      getFocusIdx: () => s.focusIdx(),
      setFocusIdx: (v: number) => {
        s.setFocusIdx(v);
      },
      selPaths: s.selPaths,
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
      focusPane: () => focusPane(pane),
      blurTerminal: () => fileops.terminal.blurTerminal(),
      log: (msg: string) => dlog(msg),
    };
  };
  const gridCtxs = [makePaneGridCtx(0), makePaneGridCtx(1)] as const;
  // active-facing ctx for drag commit/cleanup — its tileRefs resolve to the
  // active pane's map through the facade
  const gridCtx = activeFacade(() => gridCtxs[core.panes.active]);
  const finishDragCtx = () => finishDragState(gridCtx);

  // A drag released over a pane's EMPTY background moves into that pane's cwd
  // (the tile drop handles dropping onto a specific folder tile).
  const dropIntoPane = (pane: 0 | 1): void => {
    const keys = gridDrag.keys;
    if (!keys?.length) return;
    const dest = core.panes.states[pane]!.cwd;
    finishDragCtx();
    if (isVirtualUri(dest) || isTrashFilesDir(dest)) return;
    if (dest === core.state.cwd) {
      chrome.notify("Already here", "move", "info");
      return;
    }
    const items = keys.filter((k) => k.path !== dest);
    if (items.length) void fileops.fileops.moveInto(dest, items);
  };

  const entryMouseHandlers = [makeEntryMouseHandlers(gridCtxs[0]), makeEntryMouseHandlers(gridCtxs[1])] as const;

  // --- Grid renderer lives in ./ui-grid (tile/list-row builders, empty and
  // restricted states, thumbnail handoff, gen-counter stale guards) ---
  // per-pane grid renderers: each reads its own pane's state/selection/scroller
  // and a unique tile-id prefix (ids are global in the renderable registry).
  // Dual pane splits the main area in half (minus the 1-cell divider).
  const paneAvailW = (): number => {
    const main = chrome.renderer.terminalWidth - core.geometry.sidebarEff - core.geometry.previewEff;
    return core.config.ui.dualPane ? Math.floor((main - 1) / 2) : main;
  };
  // one animator per pane (each owns its reused timeline so a rebuild in one
  // pane can't clobber the other's); reads [ui] file-animation live
  const makeFileAnimator = () =>
    makeFileAnim({
      renderer: chrome.renderer,
      byId: core.lookup.byId,
      style: () => core.config.ui.fileAnimation,
      ms: () => core.config.ui.fileAnimationMs,
    });
  const fileAnims = [makeFileAnimator(), makeFileAnimator()] as const;
  const makeRenderer = (pane: 0 | 1) =>
    makeGridRenderer({
      termW: () => chrome.renderer.terminalWidth,
      termH: () => chrome.renderer.terminalHeight,
      scroller: () => core.scrollerRefs[pane]!.current,
      state: core.panes.states[pane],
      searchQuery: () => nav.searches[pane]!.getQuery(),
      recursiveSearch: () => core.config.ui.recursiveSearch,
      pathEditMode: () => chrome.toolbars[pane]!.pathEditMode(),
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
      availW: paneAvailW,
      tileIdPrefix: `tfm-tile-p${pane}-`,
      cellMetrics: core.slots.cellMetrics,
      makeIconSlot: core.slots.makeIconSlot,
      pushThumbJob: core.slots.pushThumbJob,
      nextIconId: () => core.slots.nextIconId(),
      drainIconQueue: () => core.slots.drainIconQueue(),
      drainThumbs: () => core.slots.drainThumbs(),
      stripSelectable,
      fileAnim: (target) => fileAnims[pane].play(target),
      selection: selections[pane],
      entryMouseHandlers: entryMouseHandlers[pane],
      isCutKey: core.isCutKey,
      waitForResolution: () => waitForResolution(chrome.renderer),
      clearRenameEdit: rename.clearRenameEdit,
    });
  const renderers = [makeRenderer(0), makeRenderer(1)] as const;
  const renderPane = (pane: 0 | 1): Promise<void> => renderers[pane].renderGrid();
  // render pane 0 always; pane 1 only while dual pane is on (its scroller is
  // hidden otherwise, so building its tiles would be wasted native allocs)
  const renderGrid = async (): Promise<void> => {
    await renderers[0].renderGrid();
    if (core.config.ui.dualPane) await renderers[1].renderGrid();
  };

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
    dualPane: () => core.config.ui.dualPane,
    transferToOtherPane: (op, paths) => {
      if (!paths.length) return;
      const dest = core.otherState().cwd;
      if (core.isVirtualCwd() || isVirtualUri(dest) || isTrashFilesDir(dest)) {
        chrome.notify(`Can't ${op} to the other pane`, op, "error");
        return;
      }
      void fileops.fileops.runTransfer(op, dest, paths, `${op} to other pane`);
    },
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
    renderPane,
    focusPane,
    dropIntoPane,
    finishDrag: finishDragCtx,
    bandCtx,
    props,
    menuEntries,
  };
};
