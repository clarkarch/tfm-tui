import path from "node:path";
import { RECENT_URI, STARRED_URI } from "../fs/uri";

// --- Tabs model: each tab owns its own history; `state` is always the ACTIVE
// tab's view. Switching copies the live history refs into the outgoing tab
// slot and adopts the incoming one (ref identity is load-bearing — navigate()
// reassigns `state.history`, so syncs must copy the CURRENT ref). Pure data
// machine — rendering/session I/O stay in the wiring layer. ---

export type Tab = { history: string[]; histIdx: number };
export type TabStateRef = { history: string[]; histIdx: number; cwd: string };

// chip label: basename of the tab's current cwd, virtual places by name
export const tabTitle = (t: Tab): string => {
  const cwd = t.history[t.histIdx] ?? t.history[0] ?? "";
  if (cwd === RECENT_URI) return "Recent";
  if (cwd === STARRED_URI) return "Starred";
  const base = path.basename(cwd) || cwd || "/";
  return base.length > 16 ? `${base.slice(0, 15)}…` : base;
};

export type TabsHooks = {
  onChanged: () => void; // repaint chrome (renderAll)
  status: (msg: string) => void;
  quit: () => void; // closing the last tab quits, like a browser's last window
};

export const makeTabs = (state: TabStateRef, hooks: TabsHooks) => {
  const list: Tab[] = [{ history: [process.cwd()], histIdx: 0 }];
  let active = 0;

  const syncTabFromState = (): void => {
    const t = list[active];
    if (!t) return;
    t.history = state.history;
    t.histIdx = state.histIdx;
  };

  const adoptTab = (): void => {
    const t = list[active]!;
    state.history = t.history;
    state.histIdx = t.histIdx;
  };

  const switchTab = (i: number): void => {
    if (i < 0 || i >= list.length || i === active) return;
    syncTabFromState();
    active = i;
    adoptTab();
    hooks.onChanged();
  };

  // opens right of the active tab at the same folder, with a fresh history
  const newTab = (dir?: string): void => {
    const start = dir ?? state.cwd;
    list.splice(active + 1, 0, { history: [start], histIdx: 0 });
    syncTabFromState();
    active++;
    adoptTab();
    hooks.onChanged();
    hooks.status(`Tab ${active + 1}/${list.length}`);
  };

  const closeTab = (i: number = active): void => {
    if (i < 0 || i >= list.length) return;
    if (list.length === 1) {
      hooks.quit();
      return;
    }
    if (i === active) syncTabFromState();
    list.splice(i, 1);
    active = i < active ? active - 1 : Math.min(active, list.length - 1);
    adoptTab();
    hooks.onChanged();
    hooks.status(`Tab ${active + 1}/${list.length}`);
  };

  // bulk-adopt a restored session, clamping the active index
  const adoptTabs = (tabs: Tab[], activeIdx: number): void => {
    list.length = 0;
    list.push(...tabs);
    active = Math.min(Math.max(0, activeIdx), list.length - 1);
    adoptTab();
  };

  return {
    list,
    get active() {
      return active;
    },
    syncTabFromState,
    adoptTab,
    switchTab,
    newTab,
    closeTab,
    adoptTabs,
  };
};
