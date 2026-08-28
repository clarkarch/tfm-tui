import { Box, RGBA, Text } from "@opentui/core";
import { applySurface, btnSurface, chromeSurface } from "./style";
import type { Theme } from "./config";

// --- Shared skeleton for the centered floating dialogs (conflict / props /
// yesno): full-screen dimmed scrim + a chrome panel that swallows clicks,
// teardown is one scrim removal. Callers supply id/zIndex/width and build
// their panel rows fresh (they close over live state). Theme and renderer
// access arrive through ctx. ---

export type DialogsCtx = {
  byId(id: string): any;
  rootAdd(node: any): void;
  stripSelectable(): void;
  termH(): number;
  uiStyle(): "solid" | "outline";
  colors(): Theme & Record<string, any>;
};

export const makeDialogs = (ctx: DialogsCtx) => {
  const openDialog = (opts: {
    id: string;
    zIndex: number;
    width: number;
    paddingDiv?: number; // vertical centering divisor: terminalHeight / this (3, props uses 4)
    rows: () => any[];
    onClose: () => void;
  }): void => {
    const scrim = Box(
      {
        id: opts.id,
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        paddingTop: Math.max(2, Math.round(ctx.termH() / (opts.paddingDiv ?? 3))),
        zIndex: opts.zIndex,
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        onMouseDown: () => opts.onClose(),
      },
      Box(
        {
          id: `${opts.id}-panel`,
          width: opts.width,
          ...chromeSurface(ctx.uiStyle(), ctx.colors(), ctx.colors().sidebarBg),
          paddingTop: 1,
          paddingBottom: 1,
          flexDirection: "column",
          onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} },
        },
        ...opts.rows(),
      ),
    );
    ctx.rootAdd(scrim);
    ctx.stripSelectable();
  };

  const closeDialog = (id: string): void => {
    const scrim: any = ctx.byId(id);
    scrim?.parent?.remove(scrim);
  };

  // hover button used by the conflict + yes/no dialogs (identical builders)
  const dialogBtn = (id: string, label: string, fg: string, onPick: () => void): ReturnType<typeof Box> => {
    const setBg = (on: boolean) => {
      const n: any = ctx.byId(id);
      if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on, ctx.colors().sidebarBg));
    };
    return Box(
      {
        id,
        height: 1,
        flexGrow: 1,
        flexDirection: "row",
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false, ctx.colors().sidebarBg),
        onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {}; onPick(); },
        onMouseOver: () => setBg(true),
        onMouseOut: () => setBg(false),
      },
      Text({ content: label, fg }),
    );
  };

  return { openDialog, closeDialog, dialogBtn };
};

