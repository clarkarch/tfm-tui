// --- Generic filter-list overlay: the api.ui.pick primitive. A centered
// floating panel with a filter Input + live-narrowed rows (mouse hover/click,
// up/down/enter/esc). Renderer-free core except the widget shell: fuzzy
// matching is pure (tested), rows are text-only (no icon slots, so no scrim
// or drain participation). The core command palette (ctrl+p) and api.ui.pick
// both open this over the merged api.commands() list; any plugin gets fuzzy
// lists over arbitrary items for free.
// Widget-extraction seam (see ui-dialogs.ts): all live deps arrive via ctx. ---

import { Box, Input, Text } from "@opentui/core";
import { applySurface, floatSurface } from "./style";
import { makeModalScrim } from "./ui-dialogs";
import { advanceCursor, cursorAt, cursorIndex, invokeIsolated, NO_CURSOR, type Cursor } from "../lib/uiutil";
import type { Theme } from "../config/config";
import type { UiStyle } from "../config/config-schema";
import type { Floats } from "./floats";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { SlotElement } from "./ui-slots";

export type PickItem = {
  label: string;
  hint?: string;
  run: () => void;
};

type PickCtx = {
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  destroyChildren(node: unknown): void;
  stripSelectable(): void;
  colors(): Theme;
  uiStyle(): UiStyle;
  floats: Floats;
  // shared close-X widget (icon slot); mirrors prompt/props
  escHintBtn(id: string, onClose: () => void): SlotElement;
  drainIconQueue(): unknown;
  // live item source — read fresh on every open so remaps and plugin
  // contributions apply without rebuilds
  commands(): PickItem[];
  // runtime isolation for plugin-contributed items (optional; silent when absent)
  onError?: (err: unknown) => void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

// subsequence score, case-insensitive; lower = better. Null when query is
// not a subsequence of text. Prefix matches beat word starts beat gappy
// matches; empty query matches everything at zero (stable order kept).
export const fuzzyScore = (query: string, text: string): number | null => {
  if (!query) return 0;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const i = lower.indexOf(ch, ti);
    if (i < 0) return null;
    score += i - ti; // skipped chars = gaps
    if (i === ti && ti > 0) score -= 1; // adjacency bonus
    ti = i + 1;
  }
  // full-query prefix only: a first-char-at-0 partial ("qu-ickly" for "quit")
  // must not outrank a contiguous mid-string match
  if (lower.startsWith(q)) score -= 10; // prefix bonus
  return score;
};

export const filterItems = (items: PickItem[], query: string): PickItem[] => {
  if (!query) return [...items];
  return items
    .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
    .filter((e): e is { item: PickItem; score: number } => e.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((e) => e.item);
};

const PANEL_W = 60;
const MAX_ROWS = 12;

export const makePick = (ctx: PickCtx) => {
  let opened = false;
  let items: PickItem[] = [];
  let title = "";
  let query = "";
  // the row cursor — an explicit value, not the `-1` sentinel
  let cursor: Cursor = NO_CURSOR;
  let results: PickItem[] = [];
  // the deferred focus (the Input can only be focused after it is mounted)
  // — TRACKED, so a pick that is closed or replaced before the focus lands
  // cannot focus a node it no longer owns
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelFocusTimer = (): void => {
    if (!focusTimer) return;
    try {
      clearTimeout(focusTimer);
    } catch {}
    focusTimer = null;
  };

  const rawClose = (): void => {
    opened = false;
    query = "";
    cursor = NO_CURSOR;
    results = [];
    cancelFocusTimer();
    try {
      const input = ctx.byId("tfm-pick-input");
      input?.blur?.();
    } catch {}
    const scrim = ctx.byId("tfm-pick");
    scrim?.parent?.remove(scrim);
    // hovered rows have no out (their nodes are gone) — restore here
    ctx.setPointer?.("default");
  };

  const close = (): void => {
    ctx.floats.close("pick");
  };

  const renderList = (): void => {
    const list = ctx.byId("tfm-pick-list");
    if (!list) return;
    const colors = ctx.colors();
    const next = filterItems(items, query).slice(0, MAX_ROWS);
    // The cursor names a POSITION in the CURRENT results. When the list
    // changes, the row it named is a DIFFERENT item → the cursor is dropped
    // (never silently moved onto another row: Enter would then run a
    // command the user never chose). A cursor that points past the end is
    // dropped the same way. ONE place reconciles the cursor with the list.
    const changed = next.length !== results.length || next.some((item, i) => item !== results[i]);
    results = next;
    if (changed || cursorIndex(cursor) >= results.length) cursor = NO_CURSOR;
    ctx.destroyChildren(list);
    if (!results.length) {
      list.add(
        Box(
          { width: "100%", height: 1, paddingLeft: 2, paddingRight: 1 },
          Text({ content: "No matching items", fg: colors.sidebarFgMuted }),
        ),
      );
      return;
    }
    results.forEach((item, i) => {
      const active = i === cursorIndex(cursor);
      list.add(
        Box(
          {
            id: `tfm-pick-row-${i}`,
            width: "100%",
            height: 1,
            flexDirection: "row",
            columnGap: 1,
            paddingLeft: 2,
            paddingRight: 1,
            backgroundColor: active ? colors.accentBg : undefined,
            onMouseDown: () => activate(i),
            // move, not over: OpenTUI re-fires synthetic "over" after every
            // hit-grid-changing render (recheckHoverState), which would snap
            // the cursor back to the row under a stationary mouse and fight
            // arrow-key nav. Real motion dispatches "move".
            onMouseMove: () => {
              // position truth (pointer) before change truth (highlight)
              ctx.setPointer?.("pointer");
              if (cursorIndex(cursor) !== i) {
                cursor = cursorAt(i);
                renderList();
              }
            },
          },
          Text({ content: item.label, fg: colors.white }),
          Box({ flexGrow: 1 }),
          ...(item.hint ? [Text({ content: `${item.hint} `, fg: colors.sidebarFgMuted })] : []),
        ),
      );
    });
  };

  const open = (opts: { title: string; items?: PickItem[]; placeholder?: string }): void => {
    // re-invoking while open replaces title/items (palette re-run with fresh
    // commands) — routed through close() so the floats stack never holds two
    // pick entries (a stale entry would keep isOpen true after closing).
    if (opened) close();
    ctx.floats.open("pick", rawClose);
    opened = true;
    title = opts.title;
    items = opts.items ?? ctx.commands();
    query = "";
    cursor = NO_CURSOR;
    const colors = ctx.colors();
    const scrim = makeModalScrim(
      { uiStyle: ctx.uiStyle, colors: ctx.colors },
      {
        id: "tfm-pick",
        zIndex: 3700,
        panelWidth: PANEL_W,
        onClose: () => close(),
      },
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
        Text({ id: "tfm-pick-title", content: title, fg: colors.accent }),
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-pick-close", () => close()),
      ),
      Box(
        // no fixed height: height 1 + paddingTop 1 overflows a 1-row box
        { width: "100%", paddingLeft: 2, paddingRight: 2, paddingTop: 1 },
        Input({
          id: "tfm-pick-input",
          width: PANEL_W - 6,
          placeholder: opts.placeholder ?? "Type a command…",
          backgroundColor: colors.accentBg,
          focusedBackgroundColor: colors.accentBg,
          textColor: colors.white,
        }),
      ),
      Box({ id: "tfm-pick-list", width: "100%", flexDirection: "column", paddingTop: 1 }),
    );
    ctx.rootAdd(scrim);
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    const input = ctx.byId("tfm-pick-input");
    if (input?.on) {
      input.on("input", () => {
        try {
          query = String(input.value ?? "");
        } catch {}
        // the filter changed — the cursor is reconciled by renderList (the
        // row it named is a different item now). The handler never CHOOSES
        // a row: the cursor is the user's explicit choice.
        renderList();
      });
    }
    // focus after mount (same deferred pattern as type-to-search: focusing a
    // pre-mount node is a silent no-op); best-effort, never throws. The
    // timer is TRACKED — a pick that is closed or replaced before it lands
    // must not focus a node it no longer owns.
    cancelFocusTimer();
    focusTimer = setTimeout(() => {
      focusTimer = null;
      try {
        ctx.byId("tfm-pick-input")?.focus?.();
      } catch {}
    }, 10);
    renderList();
  };

  const move = (delta: number): void => {
    if (!results.length) return;
    // NO cursor yet: down fills the first row, up the last
    cursor = advanceCursor(cursor, delta, results.length);
    renderList();
  };

  const activate = (i = cursorIndex(cursor)): void => {
    if (i < 0) return;
    const item = results[i];
    if (!item) return;
    close();
    // invokeIsolated: items may be async (typed sync) — sync try/catch alone
    // would leave rejections unhandled and unreported.
    invokeIsolated(
      () => item.run(),
      (err) => ctx.onError?.(err),
    );
  };

  const handleKey = (ev: { name?: string }): boolean => {
    if (ev.name === "escape") close();
    else if (ev.name === "up") move(-1);
    else if (ev.name === "down") move(1);
    else if (ev.name === "return") activate();
    // everything else (typing) reaches the focused Input natively — the
    // keymap swallows the event around us either way
    return true;
  };

  // theme-switch repaint while open: panel + input + title by id plus a
  // list rebuild (live colors, same query/cursor — the Input node itself is
  // untouched, so focus and typed text survive). No-op when closed.
  const repaint = (): void => {
    if (!opened) return;
    const c = ctx.colors();
    try {
      const panel = ctx.byId("tfm-pick-panel");
      if (panel) applySurface(panel, floatSurface(ctx.uiStyle(), c, c.sidebarBg));
    } catch {}
    try {
      const input = ctx.byId("tfm-pick-input");
      if (input) {
        input.backgroundColor = c.accentBg;
        input.focusedBackgroundColor = c.accentBg;
        input.textColor = c.white;
      }
    } catch {}
    try {
      const title = ctx.byId("tfm-pick-title");
      if (title) title.fg = c.accent;
    } catch {}
    try {
      renderList();
    } catch {}
  };

  return {
    open,
    close,
    move,
    activate,
    handleKey,
    isOpen: (): boolean => opened,
    repaint,
    // test seam: drive the filter without Input events — the SAME path the
    // input handler takes (the cursor is reconciled by renderList, never
    // chosen here)
    setFilter: (q: string): void => {
      query = q;
      renderList();
    },
  };
};
