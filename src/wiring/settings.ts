// --- Settings wiring: the settings model (rows -> config), the esc menu
// panel, and — as a separate wire call so the boot sequence can run between
// them, matching the original wiring order — the retheme/config-apply path
// (live theme switch, geometry rewrites, config persistence). ---

import { makeSettingModel } from "../ui/settings-model";
import { MENU_W } from "../ui/ui-menu";
import { makeEscMenu } from "../ui/ui-settings";
import { makeRetheme } from "../ui/ui-retheme";
import { clearIconCaches } from "../ui/icons";
import { cancelBand } from "../input/grid-input";
import { clearChildren } from "../ui/uiutil";
import { dlog } from "../app/log";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridWiring, NavWiring, SettingsWiring } from "./types";

export type RethemeWiring = ReturnType<typeof wireRetheme>;

export const wireSettings = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  grid: GridWiring;
  // retheme wiring runs after the boot sequence — deferred arrows (TDZ)
  getRetheme: () => RethemeWiring;
}) => {
  const { core, nav, chrome, grid, getRetheme } = deps;

  // --- Settings model: row type + pure semantics live in ./settings.ts, the
  // row->config wiring in ./settings-model, the panel in ./ui-settings ---
  const { settingGroups } = makeSettingModel({
    config: core.config,
    state: core.state,
    // arrow wrappers: applyConfig/scheduleSaveConfig belong to the retheme wiring (TDZ)
    applyConfig: (fresh) => getRetheme().applyConfig(fresh),
    scheduleSaveConfig: () => getRetheme().scheduleSaveConfig(),
    showRoot: () => escMenu.showRoot(),
    warn: (message, title) => chrome.notify(message, title ?? "tfm"),
  });

  const escMenu = makeEscMenu({
    renderer: () => chrome.renderer,
    byId: core.lookup.byId,
    floats: core.floats,
    clearChildren,
    stripSelectable: core.lookup.stripSelectable,
    escHintBtn: core.slots.escHintBtn,
    makeIconSlot: core.slots.makeIconSlot,
    drainIconQueue: () => core.slots.drainIconQueue(),
    setScrim: core.slots.setScrim,
    cancelBand: () => cancelBand(grid.bandCtx),
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    menuW: () => MENU_W,
    settingGroups: () => settingGroups(),
    warn: (message, title) => chrome.notify(message, title ?? "tfm"),
    log: (message) => dlog(message),
    quit: nav.quitApp,
  });

  return { settingGroups, escMenu };
};

export const wireRetheme = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  fileops: FileopsWiring;
  settings: SettingsWiring;
}) => {
  const { core, nav, chrome, fileops, settings } = deps;

  // --- Config application & persistence: lives in ./ui-retheme (rethemeChrome,
  // applyConfig, scheduleSaveConfig, live reload). Geometry rewrites go
  // through the core cell's setters — never bake them into consts. ---
  const retheme = makeRetheme({
    config: core.config,
    colors: core.colors,
    setOnId: core.lookup.setOnId,
    byId: core.lookup.byId,
    renderer: () => chrome.renderer,
    getSw: () => core.geometry.sw,
    setSw: (v) => {
      core.geometry.sw = v;
    },
    setTileW: (v) => {
      core.geometry.tileW = v;
    },
    setTileH: (v) => {
      core.geometry.tileH = v;
    },
    setIconCells: (v) => {
      core.geometry.iconCells = v;
    },
    sideInnerW: core.sideInnerW,
    renderAll: nav.renderAll,
    clearIconCaches,
    resetIconQueue: () => core.slots.resetIconQueue(),
    syncTerminalTheme: fileops.terminal.syncTerminalTheme,
    repaintButtons: chrome.toolbar.repaintButtons,
    renderCrumbs: chrome.toolbar.renderCrumbs,
    refreshNav: chrome.toolbar.refreshNav,
    escMenu: settings.escMenu,
    fileMenuIsOpen: chrome.menu.isFileMenuOpen,
    renderFileMenu: chrome.menu.renderFileMenu,
    setStatusMsg: nav.setStatusMsg,
  });

  return retheme;
};
