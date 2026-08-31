// --- Type-to-search: Nautilus-style incremental search. The QUERY lives here
// (single source of truth — the keymap and the grid read it through getters);
// the search Input node itself is built by the boot layout (id `tfm-search`).
// Renderer-free — node access goes through byId; renderGrid/termHasFocus
// arrive as getters so the factory can exist pre-boot (TDZ seam rule). ---

import { debounced } from "./uiutil";

export type SearchCtx = {
  byId: (id: string) => any;
  renderGrid: () => void | Promise<void>;
  // the embedded terminal owns the keyboard — never hijack into search
  termHasFocus: () => boolean;
};

export const makeSearch = (ctx: SearchCtx) => {
  let searchQuery = "";

  const clearSearch = (): void => {
    searchQuery = "";
    try {
      const el: any = ctx.byId("tfm-search");
      if (el) {
        el.value = "";
        el.visible = false;
      }
    } catch {}
  };

  // a printable char with the grid focused opens the search box seeded with
  // that char instead of doing legacy jump-ahead
  const beginTypeToSearch = (ch: string): void => {
    if (ctx.termHasFocus()) return;
    const el: any = ctx.byId("tfm-search");
    if (!el) return;
    el.visible = true;
    el.value = ch;
    searchQuery = ch;
    void ctx.renderGrid();
    setTimeout(() => {
      try {
        el.focus();
      } catch {}
    }, 10);
  };

  // wire the Input's typed characters into the query; enter/escape semantics
  // live in the global key handler (enter commits into the first match,
  // escape cancels) — no listeners for those here by design
  const wireSearchInput = (): void => {
    const inputEl: any = ctx.byId("tfm-search");
    if (!inputEl?.on) return;
    const renderSearchResults = debounced(150, () => void ctx.renderGrid());
    inputEl.on("input", () => {
      try {
        searchQuery = String(inputEl.value ?? "");
      } catch {}
      renderSearchResults();
    });
  };

  return { getQuery: (): string => searchQuery, clearSearch, beginTypeToSearch, wireSearchInput };
};
