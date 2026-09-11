// --- Generic filter-list overlay: the api.ui.pick primitive. A centered
// floating panel with a filter Input + live-narrowed rows (mouse hover/click,
// up/down/enter/esc). Renderer-free core except the widget shell: fuzzy
// matching is pure (tested), rows are text-only (no icon slots, so no scrim
// or drain participation). The palette plugin opens this over api.commands();
// any future plugin gets fuzzy lists over arbitrary items for free.
// Widget-extraction seam (see ui-dialogs.ts): all live deps arrive via ctx. ---

import { Box, Input, RGBA, Text } from "@opentui/core";
import { floatSurface } from "./style";
import { invokeIsolated } from "../lib/uiutil";
import type { Theme } from "../config/config";
import type { UiStyle } from "../config/config-schema";
import type { Floats } from "./floats";

export type PickItem = {
  label: string;
  hint?: string;
  run: () => void;
};

type PickCtx = {
  renderer(): any;
  byId(id: string): any;
  rootAdd(node: any): void;
  clearChildren(node: any): void;
  stripSelectable(): void;
  colors(): Theme;
  uiStyle(): UiStyle;
  floats: Floats;
  // shared close-X widget (icon slot); mirrors prompt/props
  escHintBtn(id: string, onClose: () => void): any;
  drainIconQueue(): unknown;
  // live item source — read fresh on every open so remaps and plugin
  // contributions apply without rebuilds
  commands(): PickItem[];
  // runtime isolation for plugin-contributed items (optional; silent when absent)
  onError?: (err: unknown) => void;
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
  let idx = -1;
  let results: PickItem[] = [];

  const rawClose = (): void => {
    opened = false;
    query = "";
    idx = -1;
    results = [];
    try {
      const input: any = ctx.byId("tfm-pick-input");
      input?.blur?.();
    } catch {}
    const scrim: any = ctx.byId("tfm-pick");
    scrim?.parent?.remove(scrim);
  };

  const close = (): void => {
    ctx.floats.close("pick");
  };

  const renderList = (): void => {
    const list: any = ctx.byId("tfm-pick-list");
    if (!list) return;
    const colors = ctx.colors();
    results = filterItems(items, query).slice(0, MAX_ROWS);
    if (idx >= results.length) idx = results.length - 1;
    ctx.clearChildren(list);
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
      const active = i === idx;
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
              if (idx !== i) {
                idx = i;
                renderList();
              }
            },
          },
          Text({ content: item.label, fg: active ? colors.white : colors.sidebarFg }),
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
    idx = -1;
    const colors = ctx.colors();
    const scrim = Box(
      {
        id: "tfm-pick",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 3700,
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        onMouseDown: () => close(),
      },
      Box(
        {
          id: "tfm-pick-panel",
          width: PANEL_W,
          ...floatSurface(ctx.uiStyle(), ctx.colors(), ctx.colors().sidebarBg),
          paddingTop: 1,
          paddingBottom: 1,
          flexDirection: "column",
          onMouseDown: (ev: any) => {
            try {
              ev.stopPropagation?.();
            } catch {}
          },
        },
        Box(
          { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
          Text({ content: title, fg: colors.accent }),
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
      ),
    );
    ctx.rootAdd(scrim);
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    const input: any = ctx.byId("tfm-pick-input");
    if (input?.on) {
      input.on("input", () => {
        try {
          query = String(input.value ?? "");
        } catch {}
        idx = 0;
        renderList();
      });
    }
    // focus after mount (same deferred pattern as type-to-search: focusing a
    // pre-mount node is a silent no-op); best-effort, never throws
    setTimeout(() => {
      try {
        ctx.byId("tfm-pick-input")?.focus?.();
      } catch {}
    }, 10);
    renderList();
  };

  const move = (delta: number): void => {
    if (!results.length) return;
    // idx -1 = no cursor yet: down fills the first row, up the last
    idx = idx < 0 ? (delta >= 0 ? 0 : results.length - 1) : (idx + delta + results.length) % results.length;
    renderList();
  };

  const activate = (i = idx): void => {
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

  return {
    open,
    close,
    move,
    activate,
    handleKey,
    isOpen: (): boolean => opened,
    // test seam: drive the filter without Input events
    setFilter: (q: string): void => {
      query = q;
      idx = -1;
      renderList();
    },
  };
};
