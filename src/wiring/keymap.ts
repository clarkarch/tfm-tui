// --- Keyboard wiring: the modal precedence chain router lives in ./keymap
// (quit > conflict > yes/no > rename > props > esc-menu > terminal >
// path-edit > file menu > search > sidebar > grid > chords) + sidebar
// kb-focus state. Last wiring step — everything it reads exists by now. ---

import { makeKeyRouter } from "../input/keymap";
import { zoomUiPatch } from "../ui/settings";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring, SettingsWiring } from "./types";
import type { RethemeWiring } from "./settings";

export type KeymapWiring = ReturnType<typeof wireKeymap>;

export const wireKeymap = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
  settings: SettingsWiring;
  getRetheme: () => RethemeWiring;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops, settings, getRetheme } = deps;
  const { state, floats } = core;
  const { byId } = core.lookup;

  const keyRouter = makeKeyRouter({
    byId,
    state,
    keybinds: (action) => core.config.keys[action] ?? [],
    quit: nav.quitApp,
    // layer-open reads go through floats — the single source of truth; the
    // close fns are the widgets' (they route back through floats themselves)
    conflict: {
      isOpen: () => floats.isOpen("conflict"),
      closeConflict: (p: "skip") => fileops.conflict.closeConflict(p),
    },
    yesNo: { isOpen: () => floats.isOpen("yesno"), close: () => fileops.yesNo.close() },
    isRenaming: gridFoundation.rename.isRenaming,
    propsIsOpen: () => floats.isOpen("props"),
    closeProps: grid.props.closeProps,
    escMenu: { ...settings.escMenu, isOpen: () => floats.isOpen("escmenu") },
    termOwnsKeyboard: fileops.terminal.ownsKeyboard,
    pathEditMode: chrome.toolbar.pathEditMode,
    pathInputVisible: () => !!byId("tfm-path-input")?.visible,
    searchVisible: () => !!byId("tfm-search")?.visible,
    searchQuery: () => nav.search.getQuery(),
    clearSearch: nav.clearSearch,
    exitPathEdit: chrome.toolbar.exitPathEdit,
    beginTypeToSearch: nav.beginTypeToSearch,
    renderGrid: grid.renderGrid,
    renderPreview: grid.renderPreview,
    renderAll: nav.renderAll,
    selection: gridFoundation.selection,
    placesHost: chrome.chrome.placesHost,
    normalizePlaces: chrome.chrome.normalizePlaces,
    mountDevice: chrome.chrome.mountDevice,
    navigate: nav.navigate,
    goBack: nav.goBack,
    goFwd: nav.goFwd,
    openFileDefault: chrome.openFileDefault,
    home: core.home,
    getFileMenuState: chrome.menu.fileMenuState,
    closeFileMenu: chrome.menu.closeFileMenu,
    renderFileMenu: chrome.menu.renderFileMenu,
    tabModel: nav.tabModel,
    newTab: nav.newTab,
    closeTab: nav.closeTab,
    switchTab: nav.switchTab,
    inTrashView: core.inTrashView,
    confirmDeleteForever: fileops.confirmDeleteForever,
    trashPaths: fileops.trash.trashPaths,
    restoreFromTrash: fileops.trash.restoreFromTrash,
    startInlineRename: gridFoundation.rename.startInlineRename,
    startInlineCreate: gridFoundation.rename.startInlineCreate,
    openProperties: grid.props.openProperties,
    enterPathEdit: chrome.toolbar.enterPathEdit,
    openTerminal: () => fileops.terminal.openTerminalHere(),
    // config flips go through the single applyConfig -> save path (same as
    // the settings GUI rows) so geometry repaints and persistence stay in sync
    togglePreview: () => {
      const ui = core.config.ui;
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, previewEnabled: !ui.previewEnabled } });
      getRetheme().scheduleSaveConfig();
    },
    toggleViewMode: () => {
      const ui = core.config.ui;
      const viewMode = ui.viewMode === "grid" ? "list" : "grid";
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, viewMode } });
      getRetheme().scheduleSaveConfig();
    },
    zoomTiles: (dir) => {
      const ui = core.config.ui;
      const patch = zoomUiPatch(ui, dir);
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.some((k) => patch[k] !== ui[k])) return; // saturated at min/max
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, ...patch } });
      getRetheme().scheduleSaveConfig();
    },
    setClipboard: fileops.fileops.setClipboard,
    isVirtualCwd: core.isVirtualCwd,
    pasteSmart: fileops.fileops.pasteSmart,
    undoLast: fileops.undo.undoLast,
    redoLast: fileops.undo.redoLast,
  });

  chrome.renderer.keyInput.on("keypress", (e: any) => keyRouter.handleKey(e));

  return { keyRouter };
};
