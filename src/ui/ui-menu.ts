import { Box, Text } from "@opentui/core";
import { chromeSurface } from "./style";
import type { Theme } from "../config/config";
import { clearChildren } from "./uiutil";
import { FLOAT_Z, type Floats } from "./floats";

// --- Floating menu widget: right-click context menu + the file-menu panel row
// renderer. Ids tfm-filemenu / tfm-filemenu-panel stay byte-identical for
// rethemeChrome; theme/renderer access arrives via ctx (same seam as
// ui-dialogs). Open/close state routes through ./floats (the single source of
// truth): this module keeps only rendering + the raw teardown. ---

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
};

export type MenuCtx = {
  byId(id: string): any;
  rootAdd(node: any): void;
  termW(): number;
  termH(): number;
  stripSelectable(): void;
  drainIconQueue(): void;
  uiStyle(): "solid" | "outline";
  colors(): Theme & Record<string, any>;
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

export const makeMenu = (ctx: MenuCtx) => {
  let state: { idx: number; entries: ListEntry[] } | null = null;

  // raw teardown — registered with floats at open time, invoked by floats
  // (public closeFileMenu is floats.close("filemenu"))
  const rawCloseMenu = () => {
    const scrim: any = ctx.byId("tfm-filemenu");
    scrim?.parent?.remove(scrim);
    state = null;
  };

  const renderFileMenu = () => {
    const panel: any = ctx.byId("tfm-filemenu-panel");
    if (!panel || !state) return;
    const colors = ctx.colors();
    clearChildren(panel);
    const row = (entry: ListEntry, i: number) => {
      if (entry.sep) {
        // plain spacer row — no divider glyph
        return Box({ width: "100%", height: 1 });
      }
      return Box(
        {
          width: "100%",
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: i === state!.idx ? colors.accentBg : undefined,
          onMouseDown: (ev: any) => {
            try {
              ev.stopPropagation?.();
            } catch {}
            entry.action();
          },
          onMouseOver: () => {
            if (state && state.idx !== i) {
              state.idx = i;
              renderFileMenu();
            }
          },
        },
        ...(entry.icon
          ? [
              ctx.makeIconSlot(
                entry.icon,
                [
                  { fg: colors.sidebarFg, bg: i === state!.idx ? colors.accentBg : colors.sidebarBg },
                  { fg: colors.white, bg: colors.accentBg },
                ],
                1,
                i === state!.idx ? 1 : 0,
              ).el,
            ]
          : []),
        Text({ content: entry.label, fg: i === state!.idx ? colors.white : colors.sidebarFg }),
        Box({ flexGrow: 1 }),
        ...(entry.hintIcon
          ? [
              ctx.makeIconSlot(
                entry.hintIcon,
                [
                  { fg: colors.sidebarFgMuted, bg: i === state!.idx ? colors.accentBg : colors.sidebarBg },
                  { fg: colors.white, bg: colors.accentBg },
                ],
                1,
                i === state!.idx ? 1 : 0,
              ).el,
            ]
          : entry.hint
            ? [Text({ content: `${entry.hint} `, fg: colors.sidebarFgMuted })]
            : []),
      );
    };
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(ctx.menuW - 2)}`, fg: colors.divider }),
      ),
    );
    state.entries.forEach((e2, i) => {
      panel.add(row(e2, i));
    });
    void ctx.drainIconQueue();
  };

  // small unscoped box spawned at the cursor — no scrim. floats.open replaces
  // any open popup (the raw teardown removes the old node first)
  const openContextMenu = (x: number, y: number, _title: string, entries: ListEntry[]): void => {
    const colors = ctx.colors();
    ctx.floats.open("filemenu", rawCloseMenu);
    state = { idx: 0, entries };
    const w = ctx.menuW;
    const h = entries.length + 2;
    let px = x,
      py = y;
    if (px + w > ctx.termW() - 1) px = Math.max(0, ctx.termW() - w - 1);
    if (py + h > ctx.termH() - 1) py = Math.max(0, ctx.termH() - h - 1);
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
        ...chromeSurface(ctx.uiStyle(), colors, colors.sidebarBg),
        flexDirection: "column",
      },
      Box({ id: "tfm-filemenu-panel", width: "100%", flexDirection: "column" }),
    );
    ctx.rootAdd(menu);
    renderFileMenu();
    ctx.stripSelectable();
  };

  // fileMenuState() returns the LIVE mutable state object — ./keymap's
  // keyboard nav mutates fmenu.idx in place (no setter) and calls
  // renderFileMenu() afterwards; do not snapshot it.
  return {
    closeFileMenu: () => ctx.floats.close("filemenu"),
    renderFileMenu,
    openContextMenu,
    isFileMenuOpen: () => !!state,
    fileMenuState: () => state,
  };
};
