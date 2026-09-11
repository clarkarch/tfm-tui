import { Box, Text } from "@opentui/core";
import { floatSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { clearChildren } from "../lib/uiutil";
import { FLOAT_Z, type Floats } from "./floats";

// --- Floating menu widget: right-click context menu + the file-menu panel row
// renderer. Ids tfm-filemenu / tfm-filemenu-panel stay byte-identical for
// rethemeChrome; theme/renderer access arrives via ctx (same seam as
// ui-dialogs). Open/close state routes through ./floats (the single source of
// truth): this module keeps only rendering + the raw teardown.
//
// Submenus: an entry with `submenu` renders a rasterized chevron and opens a
// sibling flyout panel (`tfm-filemenu-sub`) aligned to its row — flipped to the
// left / nudged up when it would overflow. The flyout is NOT a floats layer; it
// is part of the filemenu layer and torn down with it. ---

// menu panel width in cells — shared with the esc-menu root view (wiring
// passes it to both), so the two menus measure alike
export const MENU_W = 36;

export type ListEntry = {
  icon?: string;
  label: string;
  hint?: string;
  hintIcon?: string;
  action: () => void;
  sep?: boolean;
  // nested flyout items; a parent row is not directly actionable
  submenu?: ListEntry[];
};

type MenuCtx = {
  byId(id: string): any;
  rootAdd(node: any): void;
  termW(): number;
  termH(): number;
  stripSelectable(): void;
  drainIconQueue(): void;
  uiStyle(): UiStyle;
  colors(): Theme;
  menuW: number;
  floats: Floats;
  makeIconSlot(
    name: string,
    states: { fg: string; bg: string }[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: any) => void,
  ): { el: any; slotId: string; spec: any };
};

type MenuState = {
  idx: number;
  entries: ListEntry[];
  // index into entries[idx].submenu while the flyout is open, else null
  subIdx: number | null;
  // anchor of the main panel; the flyout positions relative to it
  px: number;
  py: number;
};

export const makeMenu = (ctx: MenuCtx) => {
  let state: MenuState | null = null;

  // raw teardown — registered with floats at open time, invoked by floats
  // (public closeFileMenu is floats.close("filemenu"))
  const removeSub = (): void => {
    const sub: any = ctx.byId("tfm-filemenu-sub");
    sub?.parent?.remove(sub);
  };
  const rawCloseMenu = () => {
    removeSub();
    const scrim: any = ctx.byId("tfm-filemenu");
    scrim?.parent?.remove(scrim);
    state = null;
  };

  const subEntries = (): ListEntry[] | null =>
    state && state.subIdx !== null ? (state.entries[state.idx]?.submenu ?? null) : null;

  // shared row builder for the main panel and its flyout
  const rowNode = (entry: ListEntry, active: boolean, onHover: () => void, onActivate: () => void) => {
    const colors = ctx.colors();
    if (entry.sep) return Box({ width: "100%", height: 1 });
    return Box(
      {
        width: "100%",
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: active ? colors.accentBg : undefined,
        onMouseDown: (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          onActivate();
        },
        onMouseMove: onHover,
      },
      ...(entry.icon
        ? [
            ctx.makeIconSlot(
              entry.icon,
              [
                { fg: colors.sidebarFg, bg: active ? colors.accentBg : colors.sidebarBg },
                { fg: colors.white, bg: colors.accentBg },
              ],
              1,
              active ? 1 : 0,
            ).el,
          ]
        : []),
      Text({ content: entry.label, fg: active ? colors.white : colors.sidebarFg }),
      Box({ flexGrow: 1 }),
      ...(entry.submenu
        ? [
            ctx.makeIconSlot(
              "chevron-right",
              [
                { fg: colors.sidebarFgMuted, bg: active ? colors.accentBg : colors.sidebarBg },
                { fg: colors.white, bg: colors.accentBg },
              ],
              1,
              active ? 1 : 0,
            ).el,
          ]
        : entry.hintIcon
          ? [
              ctx.makeIconSlot(
                entry.hintIcon,
                [
                  { fg: colors.sidebarFgMuted, bg: active ? colors.accentBg : colors.sidebarBg },
                  { fg: colors.white, bg: colors.accentBg },
                ],
                1,
                active ? 1 : 0,
              ).el,
            ]
          : entry.hint
            ? [Text({ content: `${entry.hint} `, fg: colors.sidebarFgMuted })]
            : []),
    );
  };

  const renderSubMenu = (): void => {
    removeSub();
    const items = subEntries();
    if (!items || !state || state.subIdx === null) return;
    const colors = ctx.colors();
    const w = ctx.menuW;
    const h = items.length + 1; // divider + rows
    // prefer the right of the parent; flip left / clamp when it would overflow
    let sx = state.px + w;
    if (sx + w > ctx.termW() - 1) sx = state.px - w;
    if (sx < 0 || sx + w > ctx.termW() - 1) sx = Math.max(0, ctx.termW() - w - 1);
    let sy = state.py + 1 + state.idx;
    if (sy + h > ctx.termH() - 1) sy = Math.max(0, ctx.termH() - h - 1);
    const panel = Box({ id: "tfm-filemenu-sub-panel", width: "100%", flexDirection: "column" });
    const sub = Box(
      {
        id: "tfm-filemenu-sub",
        position: "absolute",
        left: sx,
        top: sy,
        width: w,
        zIndex: FLOAT_Z.filemenu,
        ...floatSurface(ctx.uiStyle(), colors, colors.sidebarBg),
        flexDirection: "column",
      },
      panel,
    );
    ctx.rootAdd(sub);
    // add rows to the MOUNTED panel (the local VNode proxy no-ops post-add)
    const livePanel: any = ctx.byId("tfm-filemenu-sub-panel");
    if (!livePanel) return;
    livePanel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(w - 2)}`, fg: colors.divider }),
      ),
    );
    items.forEach((e, i) => {
      livePanel.add(
        rowNode(
          e,
          i === state!.subIdx,
          () => {
            if (state && state.subIdx !== i) {
              state.subIdx = i;
              renderSubMenu();
            }
          },
          () => {
            const it = items[i];
            if (it && !it.sep) it.action();
          },
        ),
      );
    });
    void ctx.drainIconQueue();
    ctx.stripSelectable();
  };

  const renderFileMenu = () => {
    const panel: any = ctx.byId("tfm-filemenu-panel");
    if (!panel || !state) return;
    const colors = ctx.colors();
    clearChildren(panel);
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(ctx.menuW - 2)}`, fg: colors.divider }),
      ),
    );
    state.entries.forEach((e, i) => {
      panel.add(
        rowNode(
          e,
          i === state!.idx,
          () => {
            // hovering another row swaps/closes the flyout; a freshly opened
            // flyout has NO cursor until the next move/hover
            if (state && state.idx !== i) {
              state.idx = i;
              state.subIdx = e.submenu ? -1 : null;
              renderFileMenu();
            }
          },
          () => {
            if (!state) return;
            if (e.submenu) {
              state.idx = i;
              state.subIdx = -1;
              renderFileMenu();
            } else {
              e.action();
            }
          },
        ),
      );
    });
    renderSubMenu();
    void ctx.drainIconQueue();
    ctx.stripSelectable();
  };

  // keyboard ops the router calls (state stays internal; see getFileMenuState)
  const openSubmenu = (): void => {
    if (!state) return;
    const subs = state.entries[state.idx]?.submenu;
    if (!subs?.length) return;
    // open with no cursor; the next arrow/hover selects
    state.subIdx = -1;
    renderFileMenu();
  };
  const closeSubmenu = (): void => {
    if (!state || state.subIdx === null) return;
    state.subIdx = null;
    renderFileMenu();
  };
  const moveSub = (delta: number): void => {
    const items = subEntries();
    if (!state || state.subIdx === null || !items || !items.length) return;
    const count = items.length;
    // from "no cursor" (-1): down fills first, up fills last
    let i = state.subIdx < 0 ? (delta >= 0 ? 0 : count - 1) : (state.subIdx + delta + count) % count;
    for (let n = 0; items[i]?.sep && n < count; n++) i = (i + delta + count) % count;
    state.subIdx = i;
    renderSubMenu();
  };
  const activateSub = (): void => {
    const items = subEntries();
    const it = items && state && state.subIdx !== null && state.subIdx >= 0 ? items[state.subIdx] : undefined;
    if (it && !it.sep) it.action();
  };

  // small unscoped box spawned at the cursor — no scrim. floats.open replaces
  // any open popup (the raw teardown removes the old node first)
  const openContextMenu = (x: number, y: number, _title: string, entries: ListEntry[]): void => {
    const colors = ctx.colors();
    ctx.floats.open("filemenu", rawCloseMenu);
    const w = ctx.menuW;
    const h = entries.length + 2;
    let px = x,
      py = y;
    if (px + w > ctx.termW() - 1) px = Math.max(0, ctx.termW() - w - 1);
    if (py + h > ctx.termH() - 1) py = Math.max(0, ctx.termH() - h - 1);
    // no cursor on open — the first arrow/hover selects (Nautilus-style). The
    // key router's step() treats idx -1 as "fill first (down) / last (up)".
    state = {
      idx: -1,
      entries,
      subIdx: null,
      px,
      py,
    };
    const menu = Box(
      {
        id: "tfm-filemenu",
        position: "absolute",
        left: px,
        top: py,
        width: w,
        // above every modal (props/prompt/conflict/toast) — context menus can be
        // spawned from inside any of them
        zIndex: FLOAT_Z.filemenu,
        ...floatSurface(ctx.uiStyle(), colors, colors.sidebarBg),
        flexDirection: "column",
      },
      Box({ id: "tfm-filemenu-panel", width: "100%", flexDirection: "column" }),
    );
    ctx.rootAdd(menu);
    renderFileMenu();
    ctx.stripSelectable();
  };

  // fileMenuState() returns the LIVE mutable state object — ./keymap's
  // keyboard nav mutates idx/subIdx in place (no setter) and calls
  // renderFileMenu() afterwards; do not snapshot it.
  return {
    closeFileMenu: () => ctx.floats.close("filemenu"),
    renderFileMenu,
    openContextMenu,
    openSubmenu,
    closeSubmenu,
    moveSub,
    activateSub,
    isFileMenuOpen: () => !!state,
    fileMenuState: () => state,
  };
};
