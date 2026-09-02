// --- Boot-time fixed nodes: the grid scroller, the rubber-band selection rect
// and the drag ghost are built ONCE, post-mount, and live for the whole app
// lifetime. Ids must stay byte-identical (`tfm-scroll`, BAND_ID,
// DRAG_GHOST_ID + its `-label`) — grid-input, hit-target and ui-lookup find
// them by id later. Mouse handlers arrive via ctx; the band gesture fns come
// straight from ./grid-input so the wiring can't drift from the gesture
// state machine. ---

import { ASCIIFont, Box, ScrollBoxRenderable, Text } from "@opentui/core";
import { chromeSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import {
  BAND_ID,
  DRAG_GHOST_ID,
  bandActive,
  beginBand,
  finalizeBand,
  updateBandRect,
  type BandCtx,
} from "../input/grid-input";

// --- Pre-mount skeleton: the sidebar title block and the three-panel app
// container. Ids are painted once at boot and repainted by rethemeChrome via
// findDescendantById — they must stay byte-identical. ---

// eager object, NOT a getter — these three ctxs read fields directly, so the
// type must reject the themeGet function (a bare Record<string, any> would
// silently accept it and every field read would be undefined at boot)
export const buildTitle = (opts: { width: number; colors: Theme }): any =>
  Box(
    {
      id: "tfm-title-box",
      width: opts.width,
      height: 5,
      flexDirection: "column",
      justifyContent: "center",
      paddingLeft: 1,
    },
    ASCIIFont({ id: "tfm-title-font", text: "tfm", font: "tiny", color: opts.colors.accent }),
    Text({ id: "tfm-title-sub", content: " terminal file manager", fg: opts.colors.sidebarFgMuted }),
  );

export type AppContainerOpts = {
  sw: number;
  sideInnerW: number;
  colors: Theme; // eager object — see buildTitle
  uiStyle: UiStyle;
  tabBarVisible: boolean;
  previewWidth: number;
  previewEnabled: boolean;
  title: any;
  toolbarShell: any;
};

export const buildAppContainer = (o: AppContainerOpts): any =>
  Box(
    { width: "100%", height: "100%", flexDirection: "row" },
    Box(
      {
        id: "tfm-sidebar-root",
        width: o.sw,
        height: "100%",
        ...chromeSurface(o.uiStyle, o.colors as any, o.colors.sidebarBg),
        flexDirection: "column",
      },
      o.title,
      Box({ id: "tfm-places", width: o.sideInnerW, flexDirection: "column" }),
    ),
    Box(
      {
        id: "tfm-main",
        flexGrow: 1,
        height: "100%",
        ...chromeSurface(o.uiStyle, o.colors as any, o.colors.bg),
        flexDirection: "column",
      },
      o.toolbarShell,
      Box({
        id: "tfm-tabbar",
        width: "100%",
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        visible: o.tabBarVisible,
      }),
      Box({ id: "tfm-grid-host", flexGrow: 1, width: "100%", flexDirection: "column" }),
      // status bar sits above the embedded terminal pane (zero-height until opened),
      // so with a terminal open the bar hugs its top edge instead of sinking below it
      Box(
        {
          id: "tfm-status",
          width: "100%",
          height: 1,
          flexDirection: "row",
          justifyContent: "flex-end",
          paddingRight: 1,
        },
        Text({ id: "tfm-status-label", content: "", fg: o.colors.sidebarFgMuted }),
      ),
      Box({ id: "tfm-term-host", width: "100%", height: 0, flexDirection: "column" }),
    ),
    Box({
      id: "tfm-preview",
      width: o.previewWidth,
      height: "100%",
      visible: o.previewEnabled, // display:none in yoga: takes no layout space when hidden
      ...chromeSurface(o.uiStyle, o.colors as any, o.colors.sidebarBg),
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    }),
  );

export type BootLayoutCtx = {
  renderer: any;
  byId: (id: string) => any;
  colors: Theme; // eager object — see buildTitle
  bandCtx: BandCtx;
  closeFileMenu: () => void;
  clearSearch: () => void;
  blurTerminal: () => void;
  pathEditMode: () => boolean;
  exitPathEdit: () => void;
  isRenaming: () => boolean;
  finishInlineRename: (commit: boolean) => void;
  clearTileSelection: () => void;
  openContextMenu: (x: number, y: number, title: string, entries: any[]) => void;
  emptyAreaEntries: (x: number, y: number) => any[];
};

// returns the scroller so index can keep its `scroller` live-let (the grid
// renderer reads it through a getter)
export const buildBootLayout = (ctx: BootLayoutCtx): ScrollBoxRenderable => {
  const scroller = new ScrollBoxRenderable(ctx.renderer, {
    id: "tfm-scroll",
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    viewportCulling: true,
    contentOptions: { flexDirection: "column" },
    onMouseDown: (ev: any) => {
      ctx.closeFileMenu();
      ctx.clearSearch();
      ctx.blurTerminal();
      if (ctx.pathEditMode()) {
        ctx.exitPathEdit();
        return;
      }
      if (ctx.isRenaming()) ctx.finishInlineRename(false);
      // left-click clears (and may start a rubber band); right-click opens the
      // background menu WITHOUT cancelling the selection (Nautilus behavior)
      if (ev.button === 0) ctx.clearTileSelection();
      // band shows only once a drag actually moves the pointer
      beginBand(ev);
      if (ev.button === 2) ctx.openContextMenu(ev.x, ev.y, "", ctx.emptyAreaEntries(ev.x, ev.y));
    },
    onMouseDrag: (ev: any) => updateBandRect(ctx.bandCtx, ev),
    onMouseDragEnd: (ev: any) => finalizeBand(ctx.bandCtx, ev),
    onMouseUp: (ev: any) => {
      if (bandActive()) finalizeBand(ctx.bandCtx, ev);
    },
  });
  const host: any = ctx.byId("tfm-grid-host");
  host.add(scroller);

  ctx.renderer.root.add(
    Box({
      id: BAND_ID,
      visible: false,
      position: "absolute",
      zIndex: 2500,
      border: true,
      borderStyle: "rounded",
      borderColor: ctx.colors.accent,
    }),
  );

  ctx.renderer.root.add(
    Box(
      {
        id: DRAG_GHOST_ID,
        visible: false,
        position: "absolute",
        left: 0,
        top: 0,
        width: 12,
        height: 1,
        zIndex: 4000,
        backgroundColor: ctx.colors.accent,
        flexDirection: "row",
        paddingLeft: 1,
      },
      Text({ id: `${DRAG_GHOST_ID}-label`, content: "moving 0 items", fg: ctx.colors.bg }),
    ),
  );

  return scroller;
};
