import { Box, RGBA, Text } from "@opentui/core";
import path from "node:path";
import { applySurface, btnSurface, chromeSurface } from "./style";
import type { Theme } from "../config/config";
import { FLOAT_Z, type Floats } from "./floats";

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
  colors(): Theme;
  // skeleton baseline for ANY future dialog: the context menu floats above
  // every modal, so a scrim must never come up under an open menu. The real
  // dismiss-others policy lives in ./floats (modal open clears the desktop);
  // conflict/yesno/props route their opens through floats — this call is the
  // safety net for dialogs that don't.
  closeFileMenu(): void;
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
    ctx.closeFileMenu();
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
          onMouseDown: (ev: any) => {
            try {
              ev.stopPropagation?.();
            } catch {}
          },
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
        onMouseDown: (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          onPick();
        },
        onMouseOver: () => setBg(true),
        onMouseOut: () => setBg(false),
      },
      Text({ content: label, fg }),
    );
  };

  return { openDialog, closeDialog, dialogBtn };
};

// --- Override/conflict prompt ("Replace …?") for transfer/rename collisions ---
// State + promise plumbing live here; when the choice should apply to the
// whole remaining batch ("…all") the policy is remembered until resetPolicy.

export type ConflictChoice = "replace" | "keepBoth" | "skip";

export type ConflictCtx = {
  colors(): Theme;
  drainIconQueue(): void | Promise<void>;
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
};

export const makeConflict = (dialogs: ReturnType<typeof makeDialogs>, ctx: ConflictCtx) => {
  const { openDialog, closeDialog, dialogBtn } = dialogs;

  const CONFLICT_W = 48;
  let conflictPolicy: ConflictChoice | null = null;
  let conflictOpen = false;
  let conflictResolveFn: ((c: ConflictChoice) => void) | null = null;

  // raw teardown — registered with floats at open time; a floats-initiated
  // close (policy dismissal / replace) resolves a pending prompt as "skip"
  const rawTeardown = (): void => {
    const r = conflictResolveFn;
    conflictResolveFn = null;
    closeDialog("tfm-conflict");
    conflictOpen = false;
    r?.("skip");
  };

  const closeConflict = (c: ConflictChoice): void => {
    const r = conflictResolveFn;
    conflictResolveFn = null;
    r?.(c);
    ctx.floats.close("conflict");
  };

  const promptConflict = (destPath: string, remaining: number): Promise<ConflictChoice> =>
    new Promise<ConflictChoice>((resolve) => {
      // floats.open dismisses every other floating layer (menu, props, …) —
      // the prompt must be the only thing on screen
      ctx.floats.open("conflict", rawTeardown);
      conflictOpen = true;
      conflictResolveFn = resolve;
      const c = ctx.colors();
      const name = path.basename(destPath);
      const parentName = path.basename(path.dirname(destPath)) || "/";
      let bseq = 0;
      const mkBtn = (label: string, onPick: () => void): ReturnType<typeof Box> =>
        dialogBtn(`tfm-conflict-b${bseq++}`, label, c.sidebarFg, onPick);
      const pick = (choice: ConflictChoice, all?: ConflictChoice) => {
        if (all) conflictPolicy = all;
        closeConflict(choice);
      };
      const rows: ReturnType<typeof Box>[] = [
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` Replace "${name.slice(0, CONFLICT_W - 14)}"?`, fg: c.accent }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` ${"~".repeat(CONFLICT_W - 2)}`, fg: c.divider }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({
            content: ` an item called "${name}" already exists in ${parentName}`.slice(0, CONFLICT_W - 1),
            fg: c.sidebarFgMuted,
          }),
        ),
        Box({ height: 1 }),
        Box(
          { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
          mkBtn("[ Replace ]", () => pick("replace")),
          mkBtn("[ Keep both ]", () => pick("keepBoth")),
          mkBtn("[ Skip ]", () => pick("skip")),
        ),
      ];
      if (remaining > 0) {
        rows.push(
          Box({ height: 1 }),
          Box(
            { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
            mkBtn("[ Replace all ]", () => pick("replace", "replace")),
            mkBtn("[ Keep both all ]", () => pick("keepBoth", "keepBoth")),
            mkBtn("[ Skip rest ]", () => pick("skip", "skip")),
          ),
        );
      }
      openDialog({
        id: "tfm-conflict",
        zIndex: FLOAT_Z.conflict,
        width: CONFLICT_W,
        rows: () => rows,
        onClose: () => closeConflict("skip"),
      });
      void ctx.drainIconQueue();
    });

  return {
    promptConflict,
    closeConflict,
    isOpen: (): boolean => conflictOpen,
    policy: (): ConflictChoice | null => conflictPolicy,
    resetPolicy: (): void => {
      conflictPolicy = null;
    },
  };
};

// --- Floating Yes/No confirmation ("Empty Trash?", "Permanently delete …?").
// State lives here; the trash-bound wrappers (confirmEmptyTrash /
// confirmDeleteForever) live in ./trashops. ---

export type YesNoCtx = {
  colors(): Theme;
  // false while the renderer hasn't laid out yet (same gate as makeConflict callers)
  canOpen(): boolean;
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
};

const YESNO_W = 36;

export const makeYesNo = (dialogs: ReturnType<typeof makeDialogs>, ctx: YesNoCtx) => {
  const { openDialog, closeDialog, dialogBtn } = dialogs;

  let open = false;

  // raw teardown — registered with floats at open time
  const rawClose = (): void => {
    closeDialog("tfm-yesno");
    open = false;
  };

  const close = (): void => {
    ctx.floats.close("yesno");
  };

  const confirm = (message: string, yesLabel: string, onYes: () => void, danger = false): boolean => {
    if (open || !ctx.canOpen()) return false;
    ctx.floats.open("yesno", rawClose);
    open = true;
    const c = ctx.colors();
    const yesFg = danger ? c.ansi1 : c.accent;
    let bseq = 0;
    const mkBtn = (label: string, fg: string, onPick: () => void): ReturnType<typeof Box> =>
      dialogBtn(`tfm-yesno-b${bseq++}`, label, fg, onPick);
    openDialog({
      id: "tfm-yesno",
      zIndex: FLOAT_Z.yesno,
      width: YESNO_W,
      rows: () => [
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` ${message}`.slice(0, YESNO_W - 2), fg: yesFg }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` ${"~".repeat(YESNO_W - 2)}`, fg: c.divider }),
        ),
        Box({ height: 1 }),
        Box(
          { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
          mkBtn("[ No ]", c.sidebarFg, () => close()),
          mkBtn(`[ ${yesLabel} ]`, yesFg, () => {
            close();
            onYes();
          }),
        ),
      ],
      onClose: () => close(),
    });
    return true;
  };

  return { confirm, close, isOpen: (): boolean => open };
};
