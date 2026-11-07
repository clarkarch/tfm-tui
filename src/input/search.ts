// --- Type-to-search: Nautilus-style incremental search.
//
// The search is ONE explicit state, owned HERE: `closed` or `open{query}`.
// The input node's `visible` flag is a PROJECTION of that state — the
// type-to-search catch-all AND the toolbar's search button both go through
// this module, so the node can never disagree with the router's view (the
// router used to read the NODE while the module owned the QUERY: two
// truths, and the toolbar's button was a third writer).
//
// An OPEN search ALWAYS owns the keyboard: the input is focused
// SYNCHRONOUSLY when the search opens. The old code deferred the focus by
// 10 ms, so in that window the router believed the search owned the keys
// (the box was visible) while the input did not have the focus — the first
// character typed after opening was swallowed and lost.
//
// Renderer-free — node access goes through byId; renderGrid/termHasFocus
// arrive as getters so the factory can exist pre-boot (TDZ seam rule). ---

import { debounced, stripControlChars, type Scheduler } from "../lib/uiutil";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

/** The search's state — the ONE truth about "is the search open". */
export type SearchState =
  /** the search box is closed (no query, no keyboard ownership) */
  | { kind: "closed" }
  /** the search box is open and OWNS the keyboard (the input is focused) */
  | { kind: "open"; query: string };

type SearchCtx = {
  byId: (id: string) => MaybeNode;
  // this pane's search input id (toolbar nodes are per-pane now)
  inputId: string;
  renderGrid: () => void | Promise<void>;
  // the embedded terminal owns the keyboard — never hijack into search
  termHasFocus: () => boolean;
  // injectable clock (tests use a virtual one); defaults to the real timers
  sched?: Scheduler;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

export const makeSearch = (ctx: SearchCtx) => {
  const sched: Scheduler = ctx.sched ?? globalThis;
  let state: SearchState = { kind: "closed" };
  // the debounced re-render of the filtered grid — cancellable, so a closed
  // search leaves no pending work behind
  const renderResults = debounced(150, () => void ctx.renderGrid(), sched);

  const isOpen = (): boolean => state.kind === "open";
  const getQuery = (): string => (state.kind === "open" ? state.query : "");

  // --- close: the search is gone ---
  const close = (): void => {
    // the state flips FIRST: the value write below fires the input event,
    // and a closed search ignores it
    state = { kind: "closed" };
    renderResults.cancel();
    // the input is gone — default (stale-until-move, same rule as menus)
    ctx.setPointer?.("default");
    try {
      const el = ctx.byId(ctx.inputId);
      if (el) {
        el.value = "";
        el.visible = false;
        // the boot-baked input keeps renderer focus otherwise: its input
        // handler keeps updating searchQuery (debounced renderGrid filters
        // the folder) with the box invisible and no structural escape —
        // the type-to-search catch-all needs the search to be open, so the
        // keymap never sees the keystrokes
        try {
          el.blur?.();
        } catch {}
      }
    } catch {}
  };

  // --- open: the search takes the keyboard ---
  const open = (seed: string): void => {
    // the embedded terminal owns the keyboard — never hijack into search
    if (ctx.termHasFocus()) return;
    const el = ctx.byId(ctx.inputId);
    if (!el) return;
    // beginTypeToSearch is exported — any future caller with an unvetted
    // string would throw NativeError on the write (0.6.0 Input rejects C0).
    // Query follows the stripped seed so filter and box never disagree.
    const text = stripControlChars(seed);
    state = { kind: "open", query: text };
    try {
      el.visible = true;
      el.value = text;
      // the input owns the keyboard NOW — a deferred focus left a window in
      // which the search swallowed the keys and the input never saw them
      el.focus();
    } catch {
      // the focus failed: the search cannot own the keyboard, so it does not
      // open at all (an open box that eats the keys is worse than none)
      state = { kind: "closed" };
      renderResults.cancel();
      try {
        el.visible = false;
        el.value = "";
        el.blur?.();
      } catch {}
      return;
    }
    // the input owns the keyboard now — text pointer until it clears
    ctx.setPointer?.("text");
    void ctx.renderGrid();
  };

  // a printable char with the grid focused opens the search box seeded with
  // that char instead of doing legacy jump-ahead
  const beginTypeToSearch = (ch: string): void => open(ch);

  // the toolbar's search button: open an empty search, or close the open one
  const toggleSearch = (): void => {
    if (isOpen()) {
      close();
      return;
    }
    open("");
  };

  // wire the Input's typed characters into the query; enter/escape semantics
  // live in the global key handler (enter commits into the first match,
  // escape cancels) — no listeners for those here by design
  const wireSearchInput = (): void => {
    const inputEl = ctx.byId(ctx.inputId);
    if (!inputEl?.on) return;
    inputEl.on("input", () => {
      let value = "";
      try {
        value = String(inputEl.value ?? "");
      } catch {}
      // a closed search ignores a stray input event (the clear writes an
      // empty value back into the node)
      if (state.kind !== "open") return;
      // the opener wrote the seed itself and renders right away — the same
      // value is not a new edit
      if (state.query === value) return;
      state = { kind: "open", query: value };
      renderResults();
    });
  };

  return {
    /** the ONE state */
    state: (): SearchState => state,
    /** is the search open (derived from the state, never from the node) */
    isOpen,
    getQuery,
    clearSearch: close,
    beginTypeToSearch,
    toggleSearch,
    wireSearchInput,
  };
};
