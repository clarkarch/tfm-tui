// --- Boot-time fixed nodes: the grid scroller, the rubber-band selection rect
// and the drag ghost are built ONCE, post-mount, and live for the whole app
// lifetime. Ids must stay byte-identical (`tfm-scroll`, BAND_ID,
// DRAG_GHOST_ID + its `-label`) — grid-input, hit-target and ui-lookup find
// them by id later. Mouse handlers arrive via ctx; the band gesture fns come
// straight from ./grid-input so the wiring can't drift from the gesture
// state machine. ---

import { Box, ScrollBoxRenderable, Text } from "@opentui/core";
import {
  BAND_ID,
  DRAG_GHOST_ID,
  bandActive,
  beginBand,
  finalizeBand,
  updateBandRect,
  type BandCtx,
} from "./grid-input";

export type BootLayoutCtx = {
  renderer: any;
  byId: (id: string) => any;
  colors: Record<string, any>;
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
      if (ctx.pathEditMode()) { ctx.exitPathEdit(); return; }
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
    onMouseUp: (ev: any) => { if (bandActive()) finalizeBand(ctx.bandCtx, ev); },
  });
  const host: any = ctx.byId("tfm-grid-host");
  host.add(scroller);

  ctx.renderer.root.add(Box({
    id: BAND_ID,
    visible: false,
    position: "absolute",
    zIndex: 2500,
    border: true,
    borderStyle: "rounded",
    borderColor: ctx.colors.accent,
  }));

  ctx.renderer.root.add(Box({
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
  }, Text({ id: `${DRAG_GHOST_ID}-label`, content: "moving 0 items", fg: ctx.colors.bg })));

  return scroller;
};
