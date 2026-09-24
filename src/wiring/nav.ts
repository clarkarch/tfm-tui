// --- Nav wiring: renderAll orchestration, quit, status bar, history nav,
// tabs, session sync, type-to-search. renderAll is created FIRST (the widgets
// below hand it to their factories directly) but its steps close over
// later-built widgets through the injected getters — the same TDZ seam rule
// the old flat wiring used, just parameterized. ---

import { makeRenderAll } from "../app/render-all";
import { makeQuit } from "../app/quit";
import { makeRestart, restartArgs } from "../app/restart";
import { sharedOpQueue } from "../lib/op-queue";
import { makeStatus } from "../ui/ui-status";
import { makeNav, makeSessionSync } from "../app/nav";
import { saveSessionSync, type PaneTabs } from "../fs/session";
import { makeTabs, nextTab as cycleNextTab, prevTab as cyclePrevTab } from "../app/tabs";
import { makeSearch } from "../input/search";
import { appendLog } from "../app/log";
import { xtShiftEscapeFrame } from "../ui/ui-term";
import { sharedPluginEvents } from "../lib/plugin-events";
import type { CoreWiring } from "./core";
import type { ChromeWiring, GridFoundationWiring, GridWiring } from "./types";

export const wireNav = (deps: {
  core: CoreWiring;
  // late clusters — every field below is only read at runtime, post-boot
  getChrome: () => ChromeWiring;
  getDnd: () => { disableDrops(): void; enableDrops(): void };
  getGridFoundation: () => GridFoundationWiring;
  getGrid: () => GridWiring;
  getTermHasFocus: () => boolean;
  getTerm: () => { closeTerminalPane(): void };
  getWatcher: () => { syncCwdWatcher(): void };
  // plugin teardown at quit (wired after nav; lazy getter). Best-effort sync.
  getPlugins?: () => {
    deactivateAll(): void;
    refreshSlots?(): void;
    disposeSlots?(): void;
  };
}) => {
  const { core, getChrome, getDnd, getGridFoundation, getGrid, getTermHasFocus, getTerm, getWatcher, getPlugins } =
    deps;

  // --- renderAll orchestration lives in ./render-all (tested): tab-sync +
  // cwd-sync, then the named steps in insertion order, each guarded. ---
  const renderAll = makeRenderAll({
    state: core.state,
    syncTabFromState: () => syncTabsFromState(),
    scheduleSaveSession: () => scheduleSaveSession(),
    syncPaneCwds: () => {
      for (const s of core.panes.states) s.cwd = s.history[s.histIdx] ?? s.cwd;
    },
    log: (msg) => appendLog(msg),
    steps: {
      cwdWatcher: () => getWatcher().syncCwdWatcher(),
      tabbar: () => {
        getChrome().chrome.renderTabbar(0);
        getChrome().chrome.renderTabbar(1);
      },
      nav: () => {
        for (const t of getChrome().toolbars) t.refreshNav();
      },
      crumbs: () => {
        for (const t of getChrome().toolbars) t.renderCrumbs();
      },
      sidebar: () => getChrome().chrome.renderSidebar(),
      iconQueue: () => {
        void core.slots.drainIconQueue();
      },
      grid: () => {
        void getGrid().renderGrid();
      },
      paneFocus: () => core.refreshPaneFocus(),
      preview: () => {
        void getGrid().renderPreview();
      },
      pluginSlots: () => getPlugins?.().refreshSlots?.(),
      stripSelectable: () => core.lookup.stripSelectable(),
    },
  });

  // --- Quit: the single teardown path lives in ./quit (tested). closeTerminal
  // kills the PTY child (it would otherwise rely on EIO from the dead master —
  // a shell with a foreground child can linger) and flushSession writes the
  // final session.json synchronously (process.exit kills pending async IO, so
  // the debounced save loses the last navigation). Both arrive as arrows —
  // they close over later-defined bindings. The same step object feeds restart
  // below (RestartCtx extends QuitCtx), so the two teardowns can't drift. ---
  const quitSteps = {
    disableDrops: () => getDnd().disableDrops(),
    releaseShiftCapture: () => process.stdout.write(xtShiftEscapeFrame(false)),
    onQuit: () => {
      sharedPluginEvents().emit("quit", {});
      // best-effort: call each plugin's deactivate (sync prefix only — quit is
      // synchronous, see docs/plugins.md)
      try {
        getPlugins?.().disposeSlots?.();
        getPlugins?.().deactivateAll();
      } catch {}
    },
    closeTerminal: () => getTerm().closeTerminalPane(),
    stopGpm: () => getChrome().stopGpm(),
    flushSession: () => {
      // no isVirtualCwd() guard: restore deliberately accepts recent:// and
      // starred:// tabs, so quitting from a virtual place must still persist
      // the session (the old guard silently dropped BOTH panes' real-dir tabs)
      syncTabsFromState();
      saveSessionSync(paneTabs(), core.panes.active);
    },
    destroy: () => getChrome().renderer.destroy(),
    exit: (code: number) => process.exit(code),
  };
  const quitApp = makeQuit(quitSteps);

  // --- Restart: same binary+args, parent WAITS (spawnSync) so the shell never
  // wakes mid-handoff — fire-and-forget left the child competing with the
  // shell for input (echoed mouse bytes, dead keys). Notify/recover arrive
  // lazily; recover re-arms drops + shift-capture and re-renders (the renderer
  // survives a failed spawn; the PTY pane and plugin instances don't — the
  // failure toast says so). ---
  const restartApp = makeRestart({
    ...quitSteps,
    execPath: process.execPath,
    // NOT slice(1): the compiled binary's argv carries the /$bunfs/ virtual
    // entry at [1] — re-passing it makes the child treat it as a PATH (exit
    // 1). The dev runner (argv[0] === execPath) keeps its script instead.
    argv: restartArgs(process.argv, process.execPath),
    // the shared serial queue: a live op would race the child's orphan sweep
    // while the parent loop is frozen inside spawnSync (see app/restart)
    isBusy: () => !sharedOpQueue().isIdle(),
    recover: () => {
      try {
        getDnd().enableDrops();
      } catch {}
      try {
        process.stdout.write(xtShiftEscapeFrame(true));
      } catch {}
      renderAll();
    },
    notify: (msg, title, level) => getChrome().notify(msg, title, level),
  });

  // --- Status bar writes live in ./ui-status (tested). The refresh target is
  // selection's, created further down the wiring — arrow defers it. ---
  const { setStatusMsg } = makeStatus({
    setText: core.lookup.setTextOnId,
    refresh: () => getGridFoundation().selection.updateSelectionStatusReal(),
  });

  // --- History navigation — pure state machine lives in ./nav (tested);
  // hooks close over later-defined bindings (TDZ seam rule) ---
  const { canBack, canFwd, goBack, goFwd, navigate } = makeNav(core.state, {
    renderAll,
    clearSearch: () => clearSearch(),
    exitPathEdit: () => getChrome().activeToolbar().exitPathEdit(),
    closeFileMenuIfOpen: () => {
      if (getChrome().menu.isFileMenuOpen()) getChrome().menu.closeFileMenu();
    },
    onNavigate: (dir) => sharedPluginEvents().emit("navigate", { dir }),
  });

  // --- Tabs: ONE model per pane — each pane is a browser-like tab list. The
  // focused pane's model backs the tab keybinds/menu; both get painted. Model
  // lives in ./tabs (pure, tested) — rendering/session I/O stay out. ---
  const tabModels: [ReturnType<typeof makeTabs>, ReturnType<typeof makeTabs>] = [
    makeTabs(core.panes.states[0], { onChanged: renderAll, status: setStatusMsg, quit: quitApp }),
    makeTabs(core.panes.states[1], { onChanged: renderAll, status: setStatusMsg, quit: quitApp }),
  ];
  const activeTabModel = () => tabModels[core.panes.active];
  const syncTabsFromState = (): void => {
    tabModels[0].syncTabFromState();
    tabModels[1].syncTabFromState();
  };
  const paneTabs = (): [PaneTabs, PaneTabs] => [
    { tabs: tabModels[0].list, activeTab: tabModels[0].active },
    { tabs: tabModels[1].list, activeTab: tabModels[1].active },
  ];
  const switchTab = (i: number): void => activeTabModel().switchTab(i);
  const newTab = (dir?: string): void => activeTabModel().newTab(dir);
  const closeTab = (i?: number): void => activeTabModel().closeTab(i);
  const nextTab = (): void => cycleNextTab(activeTabModel());
  const prevTab = (): void => cyclePrevTab(activeTabModel());

  // --- Session save/restore scheduling — logic lives in ./nav (tested) ---
  const { scheduleSaveSession, restoreSession } = makeSessionSync({
    paneTabs,
    syncTabsFromState,
    adoptPaneTabs: (pane, tabs, activeTab) => tabModels[pane].adoptTabs(tabs, activeTab),
    adoptDefaultTabs: () => {
      tabModels[0].adoptTab();
      tabModels[1].adoptTab();
    },
    activePane: () => core.panes.active,
    setActivePane: (i) => core.setActivePane(i),
    config: core.config,
    isVirtualCwd: core.isVirtualCwd,
  });

  // --- Type-to-search: ONE query + input per pane (each pane's toolbar has
  // its own search box). The keymap drives the focused pane's; its grid reads
  // its own query so a search filters only that side. ---
  const mkSearch = (pane: 0 | 1) =>
    makeSearch({
      byId: core.lookup.byId,
      inputId: `tfm-p${pane}-search`,
      // arrow wrappers: termHasFocus/renderGrid belong to later wirings (TDZ)
      termHasFocus: () => getTermHasFocus(),
      renderGrid: () => getGrid().renderPane(pane),
    });
  const searches: [ReturnType<typeof makeSearch>, ReturnType<typeof makeSearch>] = [mkSearch(0), mkSearch(1)];
  const activeSearch = () => searches[core.panes.active];
  const clearSearch = (): void => activeSearch().clearSearch();
  const beginTypeToSearch = (ch: string): void => activeSearch().beginTypeToSearch(ch);
  const wireSearchInput = (): void => {
    searches[0].wireSearchInput();
    searches[1].wireSearchInput();
  };

  return {
    renderAll,
    quitApp,
    restartApp,
    setStatusMsg,
    canBack,
    canFwd,
    goBack,
    goFwd,
    navigate,
    get tabModel() {
      return activeTabModel();
    },
    tabModels,
    activeTabModel,
    switchTab,
    newTab,
    closeTab,
    nextTab,
    prevTab,
    restoreSession,
    get search() {
      return activeSearch();
    },
    searches,
    activeSearch,
    clearSearch,
    beginTypeToSearch,
    wireSearchInput,
  };
};
