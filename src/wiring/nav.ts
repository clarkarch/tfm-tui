// --- Nav wiring: renderAll orchestration, quit, status bar, history nav,
// tabs, session sync, type-to-search. renderAll is created FIRST (the widgets
// below hand it to their factories directly) but its steps close over
// later-built widgets through the injected getters — the same TDZ seam rule
// the old flat wiring used, just parameterized. ---

import { makeRenderAll } from "../app/render-all";
import { makeQuit } from "../app/quit";
import { makeStatus } from "../ui/ui-status";
import { makeNav, makeSessionSync } from "../app/nav";
import { makeTabs } from "../app/tabs";
import { makeSearch } from "../input/search";
import { appendLog } from "../app/log";
import { xtShiftEscapeFrame } from "../ui/ui-term";
import type { CoreWiring } from "./core";
import type { ChromeWiring, GridFoundationWiring, GridWiring } from "./types";

export const wireNav = (deps: {
  core: CoreWiring;
  // late clusters — every field below is only read at runtime, post-boot
  getChrome: () => ChromeWiring;
  getDnd: () => { disableDrops(): void };
  getGridFoundation: () => GridFoundationWiring;
  getGrid: () => GridWiring;
  getTermHasFocus: () => boolean;
  getWatcher: () => { syncCwdWatcher(): void };
}) => {
  const { core, getChrome, getDnd, getGridFoundation, getGrid, getTermHasFocus, getWatcher } = deps;

  // --- renderAll orchestration lives in ./render-all (tested): tab-sync +
  // cwd-sync, then the named steps in insertion order, each guarded. ---
  const renderAll = makeRenderAll({
    state: core.state,
    syncTabFromState: () => syncTabFromState(),
    scheduleSaveSession: () => scheduleSaveSession(),
    log: (msg) => appendLog(msg),
    steps: {
      cwdWatcher: () => getWatcher().syncCwdWatcher(),
      tabbar: () => getChrome().chrome.renderTabbar(),
      nav: () => getChrome().toolbar.refreshNav(),
      crumbs: () => getChrome().toolbar.renderCrumbs(),
      sidebar: () => getChrome().chrome.renderSidebar(),
      iconQueue: () => {
        void core.slots.drainIconQueue();
      },
      grid: () => {
        void getGrid().renderGrid();
      },
      preview: () => {
        void getGrid().renderPreview();
      },
      stripSelectable: () => core.lookup.stripSelectable(),
    },
  });

  // --- Quit: the single teardown path lives in ./quit (tested). ---
  const quitApp = makeQuit({
    disableDrops: () => getDnd().disableDrops(),
    releaseShiftCapture: () => process.stdout.write(xtShiftEscapeFrame(false)),
    destroy: () => getChrome().renderer.destroy(),
    exit: (code) => process.exit(code),
  });

  // --- Status bar writes live in ./ui-status (tested). The refresh target is
  // selection's, created further down the wiring — arrow defers it. ---
  const { setStatusMsg } = makeStatus({
    byId: core.lookup.byId,
    refresh: () => getGridFoundation().selection.updateSelectionStatusReal(),
  });

  // --- History navigation — pure state machine lives in ./nav (tested);
  // hooks close over later-defined bindings (TDZ seam rule) ---
  const { canBack, canFwd, goBack, goFwd, navigate } = makeNav(core.state, {
    renderAll,
    clearSearch: () => clearSearch(),
    exitPathEdit: () => getChrome().toolbar.exitPathEdit(),
    closeFileMenuIfOpen: () => {
      if (getChrome().menu.isFileMenuOpen()) getChrome().menu.closeFileMenu();
    },
  });

  // --- Tabs: `state` is always the ACTIVE tab's view; switching copies the
  // live history refs into the outgoing tab slot and adopts the incoming one.
  // Model lives in ./tabs (pure, tested) — rendering/session I/O stay out. ---
  const tabModel = makeTabs(core.state, {
    onChanged: renderAll,
    status: setStatusMsg,
    quit: quitApp,
  });
  const { switchTab, newTab, closeTab, syncTabFromState } = tabModel;

  // --- Session save/restore scheduling — logic lives in ./nav (tested) ---
  const { scheduleSaveSession, restoreSession } = makeSessionSync({
    state: core.state,
    tabModel,
    config: core.config,
    isVirtualCwd: core.isVirtualCwd,
  });

  // --- Type-to-search: query state + begin/clear/input-wiring live in ./search;
  // the keymap drives begin/clear, the grid reads the query via getQuery(). ---
  const search = makeSearch({
    byId: core.lookup.byId,
    // arrow wrappers: termHasFocus/renderGrid belong to later wirings (TDZ)
    termHasFocus: () => getTermHasFocus(),
    renderGrid: () => getGrid().renderGrid(),
  });
  const { clearSearch, beginTypeToSearch, wireSearchInput } = search;

  return {
    renderAll,
    quitApp,
    setStatusMsg,
    canBack,
    canFwd,
    goBack,
    goFwd,
    navigate,
    tabModel,
    switchTab,
    newTab,
    closeTab,
    syncTabFromState,
    scheduleSaveSession,
    restoreSession,
    search,
    clearSearch,
    beginTypeToSearch,
    wireSearchInput,
  };
};
