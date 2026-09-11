// --- Keyboard wiring: the modal precedence chain router lives in ./keymap
// (capture > quit > overlay-modals (prompt/bulk-rename/conflict/yes-no/rename/props) >
// pick > esc-menu > terminal > path-edit > file menu > search > sidebar >
// grid > actions — mirrored from its header) + sidebar kb-focus state + the
// generic pick overlay widget (api.ui.pick primitive) and the single-line
// prompt overlay (plugin git-URL entry). Last wiring step — everything it
// reads exists by now. ---

import { makeKeyRouter } from "../input/keymap";
import { makePick } from "../ui/ui-pick";
import { makePrompt } from "../ui/ui-prompt";
import { zoomUiPatch } from "../ui/settings";
import { clearChildren } from "../lib/uiutil";
import { flattenPluginCommands, getPluginCommandBinds } from "../plugins/plugin-api";
import { dlog } from "../app/log";
import type { Command } from "../lib/command";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring, SettingsWiring } from "./types";
import type { PluginsWiring } from "./plugins";
import type { RethemeWiring } from "./settings";

export const wireKeymap = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
  settings: SettingsWiring;
  plugins: PluginsWiring;
  getRetheme: () => RethemeWiring;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops, settings, plugins, getRetheme } = deps;
  const { state, floats } = core;
  const { byId } = core.lookup;

  // --- Generic pick overlay (api.ui.pick): created before the router so the
  // interception branch closes over it directly; its item source reads the
  // merged core+plugin command list fresh on every open (remaps and plugin
  // contributions apply without rebuilds). coreCommands is backfilled after
  // the router exists — keypresses can't precede the wiring return. ---
  let coreCommands: () => Command[] = () => [];
  const pick = makePick({
    renderer: () => chrome.renderer,
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    clearChildren,
    stripSelectable: core.lookup.stripSelectable,
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats,
    commands: () =>
      [...coreCommands(), ...flattenPluginCommands(plugins.plugins)].map((c) => ({
        label: c.title,
        hint: c.hint || undefined,
        run: c.run,
      })),
    onError: (err) => {
      dlog(`plugin command failed: ${err instanceof Error ? err.message : err}`);
    },
  });

  // --- Single-line prompt overlay (plugin git-URL entry): same Input-native
  // typing rule as pick; the router delegates to it above pick so pasting a
  // URL never leaks keys into the grid or type-to-search. ---
  const prompt = makePrompt({
    renderer: () => chrome.renderer,
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    stripSelectable: core.lookup.stripSelectable,
    escHintBtn: core.slots.escHintBtn,
    drainIconQueue: () => core.slots.drainIconQueue(),
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats,
  });

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
    bulkRename: {
      isOpen: () => floats.isOpen("bulkrename"),
      handleKey: (ev) => gridFoundation.bulkRename.handleKey(ev),
    },
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
    startBulkRename: gridFoundation.startBulkRename,
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
    setStatusMsg: nav.setStatusMsg,
    undoLast: fileops.undo.undoLast,
    redoLast: fileops.undo.redoLast,
    pluginCommands: () =>
      plugins.plugins.flatMap((p) =>
        p.commands.map((c) => ({ id: c.id, binds: getPluginCommandBinds(p, c.id), run: c.run })),
      ),
    pick: {
      isOpen: () => pick.isOpen(),
      handleKey: (ev) => pick.handleKey(ev),
    },
    prompt: {
      isOpen: () => prompt.isOpen(),
      handleKey: (ev) => prompt.handleKey(ev),
    },
  });

  coreCommands = () => keyRouter.commands();

  chrome.renderer.keyInput.on("keypress", (e: any) => keyRouter.handleKey(e));

  return { keyRouter, pick, prompt };
};
