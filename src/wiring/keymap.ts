// --- Keyboard wiring: the modal precedence chain router lives in ./keymap
// (quit > conflict > yes/no > rename > props > esc-menu > terminal >
// path-edit > file menu > search > sidebar > grid > chords) + sidebar
// kb-focus state. Last wiring step — everything it reads exists by now. ---

import { makeKeyRouter } from "../input/keymap";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring, SettingsWiring } from "./types";

export type KeymapWiring = ReturnType<typeof wireKeymap>;

export const wireKeymap = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
  settings: SettingsWiring;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops, settings } = deps;
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
    pathInputVisible: () => !!(byId("tfm-path-input") as any)?.visible,
    searchVisible: () => !!(byId("tfm-search") as any)?.visible,
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
    openFileDefault: chrome.openFileDefault,
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
    setClipboard: fileops.fileops.setClipboard,
    isVirtualCwd: core.isVirtualCwd,
    pasteSmart: fileops.fileops.pasteSmart,
    undoLast: fileops.undo.undoLast,
    redoLast: fileops.undo.redoLast,
  });

  chrome.renderer.keyInput.on("keypress", (e: any) => keyRouter.handleKey(e));

  return { keyRouter };
};
