import { Box, type MouseEvent, Text } from "@opentui/core";
import { floatSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import {
  advanceCursor,
  CLOSED_FLYOUT,
  cursorAt,
  cursorIndex,
  destroyChildren,
  NO_CURSOR,
  openFlyout,
  type Cursor,
  type FlyoutCursor,
} from "../lib/uiutil";
import { FLOAT_Z, type FloatOpenOpts, type Floats } from "./floats";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { MakeIconSlot } from "./ui-slots";
import { isActionEntry, type ListEntry } from "../lib/menu-entry";
import { ActiveIdx } from "../lib/icon-state";

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

type MenuCtx = {
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  termW(): number;
  termH(): number;
  stripSelectable(): void;
  drainIconQueue(): void;
  uiStyle(): UiStyle;
  colors(): Theme;
  menuW: number;
  floats: Floats;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
  makeIconSlot: MakeIconSlot;
};

type MenuState = {
  // the MAIN panel's row cursor (an explicit value, not the `-1` sentinel)
  cursor: Cursor;
  entries: ListEntry[];
  // the flyout's own machine: closed / open with no row / open on a row.
  // The flyout hangs off the main cursor's row, so the two are separate.
  flyout: FlyoutCursor;
  // anchor of the main panel; the flyout positions relative to it
  px: number;
  py: number;
};

export const makeMenu = (ctx: MenuCtx) => {
  let state: MenuState | null = null;

  // raw teardown — registered with floats at open time, invoked by floats
  // (public closeFileMenu is floats.close("filemenu"))
  const removeSub = (): void => {
    const sub = ctx.byId("tfm-filemenu-sub");
    sub?.parent?.remove(sub);
  };
  const rawCloseMenu = () => {
    removeSub();
    const scrim = ctx.byId("tfm-filemenu");
    scrim?.parent?.remove(scrim);
    state = null;
    // the hovered row's out never fires (its node is gone) — restore here or
    // the pointer sticks until the next move (same stale-until-move rule as
    // the highlight paint)
    ctx.setPointer?.("default");
  };

  // the flyout's rows — only a FLYOUT row has them (the kind says so; the
  // old shape spelled it as an optional `submenu` on every row)
  const subEntries = (): ListEntry[] | null => {
    if (state?.flyout.kind !== "open") return null;
    const row = state.entries[cursorIndex(state.cursor)];
    return row?.kind === "flyout" ? row.submenu : null;
  };

  // shared row builder for the main panel and its flyout
  const rowNode = (entry: ListEntry, active: boolean, onHover: () => void, onActivate: () => void) => {
    const colors = ctx.colors();
    if (entry.kind === "sep") return Box({ width: "100%", height: 1 });
    return Box(
      {
        width: "100%",
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: active ? colors.accentBg : undefined,
        onMouseDown: (ev: MouseEvent) => {
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
                { fg: colors.white, bg: active ? colors.accentBg : colors.sidebarBg },
                { fg: colors.white, bg: colors.accentBg },
              ],
              1,
              active ? ActiveIdx.Active : ActiveIdx.Rest,
            ).el,
          ]
        : []),
      Text({ content: entry.label, fg: colors.white }),
      Box({ flexGrow: 1 }),
      ...(entry.kind === "flyout"
        ? [
            ctx.makeIconSlot(
              "chevron-right",
              [
                { fg: colors.sidebarFgMuted, bg: active ? colors.accentBg : colors.sidebarBg },
                { fg: colors.white, bg: colors.accentBg },
              ],
              1,
              active ? ActiveIdx.Active : ActiveIdx.Rest,
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
                active ? ActiveIdx.Active : ActiveIdx.Rest,
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
    if (!items || !state || state.flyout.kind !== "open") return;
    const colors = ctx.colors();
    const w = ctx.menuW;
    const h = items.length + 1; // divider + rows
    // prefer the right of the parent; flip left / clamp when it would overflow
    let sx = state.px + w;
    if (sx + w > ctx.termW() - 1) sx = state.px - w;
    if (sx < 0 || sx + w > ctx.termW() - 1) sx = Math.max(0, ctx.termW() - w - 1);
    let sy = state.py + 1 + cursorIndex(state.cursor);
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
    const livePanel = ctx.byId("tfm-filemenu-sub-panel");
    if (!livePanel) return;
    livePanel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(w - 2)}`, fg: colors.divider }),
      ),
    );
    // capture the flyout's cursor for the row paints (the closure below
    // cannot narrow `state` — it is a `let` that rawCloseMenu nulls out)
    const flyCursor = state.flyout.cursor;
    items.forEach((e, i) => {
      livePanel.add(
        rowNode(
          e,
          i === cursorIndex(flyCursor),
          () => {
            // position truth (pointer) before change truth (highlight): the
            // keyboard cursor may already sit here, in which case no repaint
            // runs but the shape must still set
            ctx.setPointer?.("pointer");
            if (state && state.flyout.kind === "open" && cursorIndex(state.flyout.cursor) !== i) {
              state.flyout = openFlyout(cursorAt(i));
              renderSubMenu();
            }
          },
          () => {
            const it = items[i];
            if (it && isActionEntry(it)) it.action();
          },
        ),
      );
    });
    void ctx.drainIconQueue();
    ctx.stripSelectable();
  };

  const renderFileMenu = () => {
    const panel = ctx.byId("tfm-filemenu-panel");
    if (!panel || !state) return;
    const colors = ctx.colors();
    destroyChildren(panel);
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
          i === cursorIndex(state?.cursor ?? NO_CURSOR),
          () => {
            // position truth (pointer) before change truth (highlight) —
            // same rule as the submenu hover above. Hovering another row
            // swaps/closes the flyout; a freshly opened flyout has NO cursor
            // until the next move/hover
            ctx.setPointer?.("pointer");
            if (state && cursorIndex(state.cursor) !== i) {
              state.cursor = cursorAt(i);
              // hovering a parent row opens ITS flyout (no row highlighted
              // yet); hovering a leaf closes whatever flyout was open
              state.flyout = e.kind === "flyout" ? openFlyout() : CLOSED_FLYOUT;
              renderFileMenu();
            }
          },
          () => {
            if (!state) return;
            // a parent row's action is directly clickable (hover / → still
            // open the flyout for the variants) — a click fires it. A
            // separator is a GAP: it has no action (the kind says so).
            if (isActionEntry(e)) e.action();
          },
        ),
      );
    });
    renderSubMenu();
    void ctx.drainIconQueue();
    ctx.stripSelectable();
  };

  // keyboard ops the router calls (the menu owns the cursor — the router
  // asks, it never writes the state; see getFileMenuState)
  const moveMain = (delta: number): void => {
    if (!state) return;
    const count = state.entries.length;
    if (count === 0) return;
    state.cursor = advanceCursor(state.cursor, delta, count, state.entries);
    state.flyout = CLOSED_FLYOUT; // moving to another row closes the flyout
    renderFileMenu();
  };
  const openSubmenu = (): void => {
    if (!state) return;
    if (state.flyout.kind === "open") return; // already open — keep its cursor
    const row = state.entries[cursorIndex(state.cursor)];
    const subs = row?.kind === "flyout" ? row.submenu : undefined;
    if (!subs?.length) return;
    // open with no cursor; the next arrow/hover selects
    state.flyout = openFlyout();
    renderFileMenu();
  };
  const closeSubmenu = (): void => {
    if (!state || state.flyout.kind === "closed") return;
    state.flyout = CLOSED_FLYOUT;
    renderFileMenu();
  };
  const moveSub = (delta: number): void => {
    const items = subEntries();
    if (state?.flyout.kind !== "open" || !items || !items.length) return;
    state.flyout = openFlyout(advanceCursor(state.flyout.cursor, delta, items.length, items));
    renderSubMenu();
  };
  const activateSub = (): void => {
    const items = subEntries();
    const at = state && state.flyout.kind === "open" ? cursorIndex(state.flyout.cursor) : -1;
    const it = at >= 0 ? items?.[at] : undefined;
    if (it && isActionEntry(it)) it.action();
  };
  // Enter: the flyout's row while the flyout is open, else the cursor's row.
  // A flyout with NO highlighted row has no target — enter is a no-op (the
  // first arrow picks a row).
  const activate = (): void => {
    if (!state) return;
    if (state.flyout.kind === "open") {
      activateSub();
      return;
    }
    const at = cursorIndex(state.cursor);
    if (at < 0) return; // no cursor yet: enter is a no-op
    // parent rows are directly clickable — enter fires the action, → opens
    // the flyout for the variants. A separator is a GAP: no action.
    const row = state.entries[at];
    if (row && isActionEntry(row)) row.action();
  };

  // small unscoped box spawned at the cursor — no scrim. floats.open replaces
  // any open popup (the raw teardown removes the old node first) and clears
  // the desktop: a DESKTOP context menu replaces whatever was open (one
  // floating UI at a time). `opts.keepModalBelow` marks the popup as
  // belonging to the modal underneath it (the props permission menu).
  const openContextMenu = (x: number, y: number, _title: string, entries: ListEntry[], opts?: FloatOpenOpts): void => {
    const colors = ctx.colors();
    ctx.floats.open("filemenu", rawCloseMenu, opts);
    const w = ctx.menuW;
    const h = entries.length + 2;
    let px = x,
      py = y;
    if (px + w > ctx.termW() - 1) px = Math.max(0, ctx.termW() - w - 1);
    if (py + h > ctx.termH() - 1) py = Math.max(0, ctx.termH() - h - 1);
    // no cursor on open — the first arrow/hover selects (Nautilus-style). The
    // key router's step() advances from NO cursor to the first (down) / last
    // (up) row.
    state = {
      cursor: NO_CURSOR,
      entries,
      flyout: CLOSED_FLYOUT,
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

  // fileMenuState() returns the LIVE state object — the router READS it (is
  // the flyout open?) but never writes it: the menu is the ONE owner of the
  // cursor (the router calls moveMain/activate). Do not snapshot it.
  return {
    closeFileMenu: () => ctx.floats.close("filemenu"),
    renderFileMenu,
    openContextMenu,
    moveMain,
    activate,
    openSubmenu,
    closeSubmenu,
    moveSub,
    activateSub,
    isFileMenuOpen: () => !!state,
    fileMenuState: () => state,
  };
};
