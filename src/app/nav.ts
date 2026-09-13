// --- History navigation + session scheduling: pure state mutation on
// AppState.history/histIdx — rendering, search-clearing and menu-closing
// arrive as injected hooks (same seam as tabs.ts: no renderer, no state
// module). `state.cwd` is synced by the caller's renderAll, so navigate()
// only mutates history/histIdx and lets the repaint settle it. ---

import path from "node:path";
import { statSync } from "node:fs";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import type { SortMode } from "../lib/sort";
import type { Config } from "../config/config";
import type { Tab } from "./tabs";
import { debounced } from "../lib/uiutil";
import { readRestoredSession, saveSession, type PaneTabs } from "../fs/session";
import { debugLog } from "./log";

export type AppState = {
  cwd: string;
  history: string[];
  histIdx: number;
  showHidden: boolean;
  sortBy: SortMode;
  sortAsc: boolean;
  // one-shot: a launch FILE path (`tfm some/file.txt`) the first grid build
  // highlights, then clears (see ui-grid's rebuild tail)
  pendingSelect?: string | null;
};

// boot state: the start dir is its own one-entry history; sort defaults to
// name-ascending (the settings/menu own changes afterwards)
export const initialAppState = (
  config: Config,
  cwd: string = process.cwd(),
  pendingSelect: string | null = null,
): AppState => ({
  cwd,
  history: [cwd],
  histIdx: 0,
  showHidden: config.ui.showHidden,
  sortBy: "name",
  sortAsc: true,
  pendingSelect,
});

type NavHooks = {
  renderAll: () => void;
  clearSearch: () => void;
  // close the inline path edit + any open file menu — navigate must leave no
  // transient UI pointing at the old folder (fires on every path, even no-ops)
  exitPathEdit: () => void;
  closeFileMenuIfOpen: () => void;
  // plugin event fan-out (optional; never throws into navigation)
  onNavigate?: (dir: string) => void;
};

export const makeNav = (state: AppState, hooks: NavHooks) => {
  const canBack = () => state.histIdx > 0;
  const canFwd = () => state.histIdx < state.history.length - 1;
  // history-button/back-key moves are navigations too — plugins watching
  // navigate must see them, not just navigate() calls.
  const step = (delta: number): void => {
    if (delta < 0 ? !canBack() : !canFwd()) return;
    state.histIdx += delta;
    hooks.renderAll();
    emitNavigate(state.history[state.histIdx]!);
  };
  const goBack = (): void => step(-1);
  const goFwd = (): void => step(1);

  const pushHistory = (dir: string): void => {
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(dir);
    state.histIdx++;
  };

  const emitNavigate = (dir: string): void => {
    try {
      hooks.onNavigate?.(dir);
    } catch {}
  };

  const navigate = (dir: string) => {
    debugLog(`navigate -> ${dir}`);
    hooks.exitPathEdit();
    hooks.closeFileMenuIfOpen();
    if (dir === RECENT_URI || dir === STARRED_URI) {
      if (dir === state.cwd) {
        hooks.renderAll();
        return;
      }
      pushHistory(dir);
      hooks.clearSearch();
      hooks.renderAll();
      emitNavigate(dir);
      return;
    }
    let target: string;
    try {
      target = path.resolve(dir);
      if (!statSync(target).isDirectory()) return;
    } catch {
      return;
    }
    if (target === path.resolve(state.cwd)) {
      hooks.renderAll();
      return;
    }
    pushHistory(target);
    hooks.clearSearch();
    hooks.renderAll();
    emitNavigate(target);
  };

  return { canBack, canFwd, goBack, goFwd, navigate };
};

// --- Session save/restore scheduling: each pane's tab list is written after
// the navigation settles (renderAll calls this); restore adopts both panes at
// boot. Off unless [ui] restore-session = true. ---
type SessionSyncCtx = {
  paneTabs: () => [PaneTabs, PaneTabs];
  syncTabsFromState: () => void;
  adoptPaneTabs: (pane: 0 | 1, tabs: Tab[], activeTab: number) => void;
  adoptDefaultTabs: () => void;
  activePane: () => 0 | 1;
  setActivePane: (i: 0 | 1) => void;
  config: Config;
  isVirtualCwd: () => boolean;
};

export const makeSessionSync = (ctx: SessionSyncCtx) => {
  const scheduleSaveSession = debounced(400, () => {
    ctx.syncTabsFromState();
    if (ctx.isVirtualCwd()) return;
    void saveSession(ctx.paneTabs(), ctx.activePane()).catch(() => {});
  });

  const restoreSession = (): void => {
    if (!ctx.config.ui.restoreSession) return;
    const restored = readRestoredSession();
    if (restored) {
      ctx.adoptPaneTabs(0, restored.panes[0].tabs, restored.panes[0].activeTab);
      ctx.adoptPaneTabs(1, restored.panes[1].tabs, restored.panes[1].activeTab);
      // a session saved with pane 1 active must not leave input targeting a
      // hidden pane when dual pane is off
      ctx.setActivePane(ctx.config.ui.dualPane ? restored.activePane : 0);
    } else {
      ctx.adoptDefaultTabs();
    }
  };

  return { scheduleSaveSession, restoreSession };
};
