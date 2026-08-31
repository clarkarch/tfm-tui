// --- History navigation + session scheduling: pure state mutation on
// AppState.history/histIdx — rendering, search-clearing and menu-closing
// arrive as injected hooks (same seam as tabs.ts: no renderer, no state
// module). `state.cwd` is synced by the caller's renderAll, so navigate()
// only mutates history/histIdx and lets the repaint settle it. ---

import path from "node:path";
import { statSync } from "node:fs";
import { RECENT_URI, STARRED_URI } from "./uri";
import type { SortMode } from "./menu-entries";
import type { Config } from "./config";
import type { TabStateRef } from "./tabs";
import { makeTabs } from "./tabs";
import { debounced } from "./uiutil";
import { readRestoredSession, saveSession } from "./session";
import { debugLog } from "./log";

export type AppState = {
  cwd: string;
  history: string[];
  histIdx: number;
  showHidden: boolean;
  sortBy: SortMode;
  sortAsc: boolean;
};

// boot state: the start dir is its own one-entry history; sort defaults to
// name-ascending (the settings/menu own changes afterwards)
export const initialAppState = (config: Config, cwd: string = process.cwd()): AppState => ({
  cwd,
  history: [cwd],
  histIdx: 0,
  showHidden: config.ui.showHidden,
  sortBy: "name",
  sortAsc: true,
});

export type NavHooks = {
  renderAll: () => void;
  clearSearch: () => void;
  // close the inline path edit + any open file menu — navigate must leave no
  // transient UI pointing at the old folder (fires on every path, even no-ops)
  exitPathEdit: () => void;
  closeFileMenuIfOpen: () => void;
};

export const makeNav = (state: AppState, hooks: NavHooks) => {
  const canBack = () => state.histIdx > 0;
  const canFwd = () => state.histIdx < state.history.length - 1;
  const goBack = () => { if (canBack()) { state.histIdx--; hooks.renderAll(); } };
  const goFwd = () => { if (canFwd()) { state.histIdx++; hooks.renderAll(); } };

  const pushHistory = (dir: string): void => {
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(dir);
    state.histIdx++;
  };

  const navigate = (dir: string) => {
    debugLog(`navigate -> ${dir}`);
    hooks.exitPathEdit();
    hooks.closeFileMenuIfOpen();
    if (dir === RECENT_URI || dir === STARRED_URI) {
      if (dir === state.cwd) { hooks.renderAll(); return; }
      pushHistory(dir);
      hooks.clearSearch();
      hooks.renderAll();
      return;
    }
    let target: string;
    try {
      target = path.resolve(dir);
      if (!statSync(target).isDirectory()) return;
    } catch {
      return;
    }
    if (target === path.resolve(state.cwd)) { hooks.renderAll(); return; }
    pushHistory(target);
    hooks.clearSearch();
    hooks.renderAll();
  };

  return { canBack, canFwd, goBack, goFwd, navigate };
};

// --- Session save/restore scheduling: the debounced write fires after the
// navigation settles (renderAll calls it), restore adopts the saved tabs into
// the live model at boot. Off unless [ui] restore-session = true. ---
export type SessionSyncCtx = {
  state: TabStateRef;
  tabModel: ReturnType<typeof makeTabs>;
  config: Config;
  isVirtualCwd: () => boolean;
};

export const makeSessionSync = (ctx: SessionSyncCtx) => {
  const scheduleSaveSession = debounced(400, () => {
    ctx.tabModel.syncTabFromState();
    if (ctx.isVirtualCwd()) return;
    void saveSession(ctx.state.cwd, ctx.tabModel.list, ctx.tabModel.active).catch(() => {});
  });

  const restoreSession = (): void => {
    if (!ctx.config.ui.restoreSession) return;
    const restored = readRestoredSession();
    if (restored) {
      ctx.tabModel.adoptTabs(restored.tabs, restored.activeTab);
    } else {
      ctx.tabModel.adoptTab();
    }
  };

  return { scheduleSaveSession, restoreSession };
};
