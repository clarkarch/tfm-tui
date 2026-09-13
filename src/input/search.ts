// --- Type-to-search: Nautilus-style incremental search. The QUERY lives here
// (single source of truth — the keymap and the grid read it through getters);
// the search Input node itself is built by the boot layout (id `tfm-search`).
// Renderer-free — node access goes through byId; renderGrid/termHasFocus
// arrive as getters so the factory can exist pre-boot (TDZ seam rule). ---

import { debounced, type Scheduler } from "../lib/uiutil";

type SearchCtx = {
  byId: (id: string) => any;
  // this pane's search input id (toolbar nodes are per-pane now)
  inputId: string;
  renderGrid: () => void | Promise<void>;
  // the embedded terminal owns the keyboard — never hijack into search
  termHasFocus: () => boolean;
  // injectable clock (tests use a virtual one); defaults to the real timers
  sched?: Scheduler;
};

export const makeSearch = (ctx: SearchCtx) => {
  const sched: Scheduler = ctx.sched ?? globalThis;
  let searchQuery = "";
  let focusTimer: unknown = null;

  const clearSearch = (): void => {
    searchQuery = "";
    if (focusTimer !== null) {
      sched.clearTimeout(focusTimer);
      focusTimer = null;
    }
    try {
      const el: any = ctx.byId(ctx.inputId);
      if (el) {
        el.value = "";
        el.visible = false;
        // the boot-baked input keeps renderer focus otherwise: its input
        // handler keeps updating searchQuery (debounced renderGrid filters
        // the folder) with the box invisible and no structural escape —
        // the type-to-search catch-all needs searchVisible(), so the keymap
        // never sees the keystrokes
        try {
          el.blur?.();
        } catch {}
      }
    } catch {}
  };

  // a printable char with the grid focused opens the search box seeded with
  // that char instead of doing legacy jump-ahead
  const beginTypeToSearch = (ch: string): void => {
    if (ctx.termHasFocus()) return;
    const el: any = ctx.byId(ctx.inputId);
    if (!el) return;
    el.visible = true;
    el.value = ch;
    searchQuery = ch;
    void ctx.renderGrid();
    if (focusTimer !== null) sched.clearTimeout(focusTimer);
    focusTimer = sched.setTimeout(() => {
      focusTimer = null;
      try {
        el.focus();
      } catch {}
    }, 10);
  };

  // wire the Input's typed characters into the query; enter/escape semantics
  // live in the global key handler (enter commits into the first match,
  // escape cancels) — no listeners for those here by design
  const wireSearchInput = (): void => {
    const inputEl: any = ctx.byId(ctx.inputId);
    if (!inputEl?.on) return;
    const renderSearchResults = debounced(150, () => void ctx.renderGrid(), sched);
    inputEl.on("input", () => {
      try {
        searchQuery = String(inputEl.value ?? "");
      } catch {}
      renderSearchResults();
    });
  };

  return { getQuery: (): string => searchQuery, clearSearch, beginTypeToSearch, wireSearchInput };
};
