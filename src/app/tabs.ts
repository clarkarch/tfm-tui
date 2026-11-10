// --- Tabs model: a browser-style tab list, ONE PER PANE. Each pane owns its
// own model instance; `state.history/histIdx` are ALWAYS this pane's active
// tab (sync via syncTabFromState()/adoptTab() — navigate reassigns `history`,
// so refs must be copied, not values). Pure data machine — rendering/session
// I/O stay in the wiring layer. ---

import type { Tab } from "../fs/session";
import { dlog } from "../lib/log";
import { clampPair } from "./history";

export type TabStateRef = { history: string[]; histIdx: number; cwd: string };

export type TabsHooks = {
  onChanged: () => void; // repaint chrome (renderAll)
  status: (msg: string) => void;
  quit: () => void; // closing the last tab quits, like a browser's last window
};

// The log sink is injectable (default: the always-on dlog) so the model's
// refusals and broken-invariant reports are PINNABLE.
export const makeTabs = (state: TabStateRef, hooks: TabsHooks, log: (msg: string) => void = dlog) => {
  const list: Tab[] = [{ history: [process.cwd()], histIdx: 0 }];
  let active = 0;

  // The model's ONE invariant: the list is NEVER empty and the active index
  // is always INSIDE it. The old clamp (`Math.min(Math.max(0, activeIdx),
  // list.length - 1)`) yielded -1 for an EMPTY list — `list[-1]` is
  // undefined, so every reader silently no-op'd and the pane kept showing
  // the PREVIOUS folder while its tab strip showed none. `adoptTabs` is the
  // only path that could empty the list, and it refuses an empty adopt.
  //
  // `activeTab()` is the ONE reader of the active entry: a missing entry is
  // a BROKEN invariant (the list is exposed by reference, so an outside
  // mutation can break it), so it is ANNOUNCED instead of silently ignored.
  const activeTab = (): Tab | undefined => {
    const t = list[active];
    if (!t) log(`tabs: no active tab (active=${active}, tabs=${list.length}) — the tab invariant is broken`);
    return t;
  };

  const syncTabFromState = (): void => {
    const t = activeTab();
    if (!t) return;
    // the state's pair is clamped by its owner (./history) BEFORE it is
    // copied — a broken index would otherwise be copied INTO the tab (and
    // back out again on the next adopt)
    if (clampPair(state)) log("tabs: the history index was out of range — reset");
    t.history = state.history;
    t.histIdx = state.histIdx;
  };

  const adoptTab = (): void => {
    // same shape as syncTabFromState: a missing entry leaves the state alone
    const t = activeTab();
    if (!t) return;
    // the tab's own pair is clamped before it is adopted — the tab is a
    // persisted shape (a session file), so its index can be out of range
    if (clampPair(t)) log("tabs: the adopted tab's history index was out of range — reset");
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

  // opens right of the active tab at the given folder, with a fresh history
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

  // bulk-adopt a restored session, clamping the active index.
  //
  // An EMPTY adopt is a REFUSAL: the model's own tab is the floor, so the
  // list is never empty and the active index can never fall out of range.
  // The refusal is ANNOUNCED — a broken session must not vanish silently.
  // The incoming list is COPIED: the adopt clears the model's list before
  // filling it, so adopting the model's OWN array would clear the very
  // array it is filling.
  const adoptTabs = (tabs: Tab[], activeIdx: number): void => {
    if (tabs.length === 0) {
      log("tabs: refusing an empty tab adopt — the tab list is never empty");
      return;
    }
    const adopted = tabs.slice();
    list.length = 0;
    list.push(...adopted);
    // the clamp runs AFTER the list is filled, against its real length
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

// cycle the active tab, wrapping (ctrl+tab / ctrl+shift+tab). No-op with <2 tabs.
export const nextTab = (model: ReturnType<typeof makeTabs>): void => {
  if (model.list.length > 1) model.switchTab(model.active === model.list.length - 1 ? 0 : model.active + 1);
};

export const prevTab = (model: ReturnType<typeof makeTabs>): void => {
  if (model.list.length > 1) model.switchTab(model.active === 0 ? model.list.length - 1 : model.active - 1);
};
