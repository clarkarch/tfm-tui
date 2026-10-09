import { Box, type MouseEvent, RGBA, Text } from "@opentui/core";
import type { VChild } from "@opentui/core";
import path from "node:path";
import { applySurface, btnSurface, floatSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { FLOAT_Z, type Floats } from "./floats";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import { hoverEvents, type SlotElement } from "./ui-slots";

// --- Shared skeleton for the centered floating dialogs (conflict / props /
// yesno): full-screen dimmed scrim + a chrome panel that swallows clicks,
// teardown is one scrim removal. Callers supply id/zIndex/width and build
// their panel rows fresh (they close over live state). Theme and renderer
// access arrive through ctx. ---

type DialogsCtx = {
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  stripSelectable(): void;
  termH(): number;
  uiStyle(): UiStyle;
  colors(): Theme;
  // skeleton baseline for ANY future dialog: the context menu floats above
  // every modal, so a scrim must never come up under an open menu. The real
  // dismiss-others policy lives in ./floats (modal open clears the desktop);
  // conflict/yesno/props route their opens through floats — this call is the
  // safety net for dialogs that don't.
  closeFileMenu(): void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

// The modal-scrim skeleton every floating panel opens with (pick/prompt/
// bulk-rename/esc-menu): absolute scrim + floatSurface panel that stops click
// propagation so an inside click never dismisses. Deps arrive directly (same
// seam as the widgets' ctx) — no ctx-type plumbing. ids must stay byte-
// identical (rethemeChrome repaints them by id).
export const makeModalScrim = (
  deps: {
    uiStyle: () => UiStyle;
    colors: () => Theme;
  },
  opts: {
    id: string;
    zIndex: number;
    panelWidth: number;
    onClose: () => void;
    // extra panel mousedown (esc-menu's capture cancel) — runs after the
    // stopPropagation, so the scrim handler never sees it
    panelMouseDown?: (ev: MouseEvent) => void;
  },
  ...children: VChild[]
): unknown =>
  Box(
    {
      id: opts.id,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      zIndex: opts.zIndex,
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      onMouseDown: () => opts.onClose(),
    },
    Box(
      {
        id: `${opts.id}-panel`,
        width: opts.panelWidth,
        ...floatSurface(deps.uiStyle(), deps.colors(), deps.colors().sidebarBg),
        paddingTop: 1,
        paddingBottom: 1,
        flexDirection: "column",
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          opts.panelMouseDown?.(ev);
        },
      },
      ...children,
    ),
  );

export const makeDialogs = (ctx: DialogsCtx) => {
  const openDialog = (opts: {
    id: string;
    zIndex: number;
    width: number;
    paddingDiv?: number; // vertical centering divisor: terminalHeight / this (3, props uses 4)
    rows: () => SlotElement[];
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
          ...floatSurface(ctx.uiStyle(), ctx.colors(), ctx.colors().sidebarBg),
          paddingTop: 1,
          paddingBottom: 1,
          flexDirection: "column",
          onMouseDown: (ev: MouseEvent) => {
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
    const scrim = ctx.byId(id);
    scrim?.parent?.remove(scrim);
  };

  // hover button used by the conflict + yes/no dialogs (identical builders)
  const dialogBtn = (id: string, label: string, fg: string, onPick: () => void): ReturnType<typeof Box> => {
    const setBg = (on: boolean) => {
      const n = ctx.byId(id);
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
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          onPick();
        },
        // the one hover wiring (see ui-slots.hoverEvents) — move, not over
        ...hoverEvents(setBg, ctx.setPointer),
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

type ConflictCtx = {
  colors(): Theme;
  uiStyle(): UiStyle;
  byId(id: string): MaybeNode;
  drainIconQueue(): void | Promise<void>;
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
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
    // hovered buttons have no out (their nodes are gone) — restore here
    ctx.setPointer?.("default");
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
        dialogBtn(`tfm-conflict-b${bseq++}`, label, c.white, onPick);
      const pick = (choice: ConflictChoice, all?: ConflictChoice) => {
        if (all) conflictPolicy = all;
        closeConflict(choice);
      };
      // hard-sliced names used to truncate silently — same-prefix files in
      // one folder were indistinguishable at the exact moment of choice
      const ellipsize = (s: string, max: number): string =>
        s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
      const locationLine = ` an item called "${name}" already exists in ${parentName}`;
      const rows: ReturnType<typeof Box>[] = [
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ id: "tfm-conflict-title", content: ` Replace "${ellipsize(name, CONFLICT_W - 14)}"?`, fg: c.accent }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ id: "tfm-conflict-div", content: ` ${"~".repeat(CONFLICT_W - 2)}`, fg: c.divider }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({
            id: "tfm-conflict-loc",
            content: ellipsize(locationLine, CONFLICT_W - 1),
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

  // theme-switch repaint while open: panel + texts by id, buttons back to
  // rest (hover repaints live on the next mouse move). No rebuild — the
  // pending promise + remembered policy survive.
  const repaintConflict = (): void => {
    if (!conflictOpen) return;
    const c = ctx.colors();
    try {
      const panel = ctx.byId("tfm-conflict");
      if (panel) applySurface(panel, floatSurface(ctx.uiStyle(), c, c.sidebarBg));
    } catch {}
    const setFg = (id: string, fg: string): void => {
      try {
        const n = ctx.byId(id);
        if (n) n.fg = fg;
      } catch {}
    };
    setFg("tfm-conflict-title", c.accent);
    setFg("tfm-conflict-div", c.divider);
    setFg("tfm-conflict-loc", c.sidebarFgMuted);
    // 3 buttons, 6 with the …all row — loop the id space, skip the missing
    for (let i = 0; i < 8; i++) {
      try {
        const btn = ctx.byId(`tfm-conflict-b${i}`);
        if (!btn) continue;
        applySurface(btn, btnSurface(ctx.uiStyle(), c, false, c.sidebarBg));
        const label = btn.getChildren?.()?.[0];
        if (label) label.fg = c.white;
      } catch {}
    }
  };

  return {
    promptConflict,
    closeConflict,
    isOpen: (): boolean => conflictOpen,
    repaint: repaintConflict,
    policy: (): ConflictChoice | null => conflictPolicy,
    resetPolicy: (): void => {
      conflictPolicy = null;
    },
  };
};

// --- Floating Yes/No confirmation ("Empty Trash?", "Permanently delete …?").
// State lives here; the trash-bound wrappers (confirmEmptyTrash /
// confirmDeleteForever) live in ./trashops. ---

type YesNoCtx = {
  colors(): Theme;
  uiStyle(): UiStyle;
  byId(id: string): MaybeNode;
  // NO readiness gate: a dialog mounts on the renderer root, which exists for
  // the renderer's whole life. The old `canOpen: () => !!renderer.resolution`
  // wiring only became true once the terminal answered OpenTUI's pixel-size
  // query — never on the Linux console or tmux, where Empty Trash / Delete
  // Forever then silently no-op'd. makeConflict opens ungated for the same
  // reason; callers reach confirm() only after boot (keymap/menu).
  //
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

const YESNO_W = 48;

// word-wrap a confirm message into at most two panel lines (the old single
// slice cut "This cannot be undone." off every delete prompt). Pure + exported
// for tests. Budget = panel minus side padding and the leading-space indent.
export const wrapYesNoMessage = (message: string, width: number = YESNO_W): string[] => {
  const budget = width - 3;
  const words = message.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > budget) {
      if (cur) lines.push(cur);
      // hard-slice space-less runs (never a silent cut — ellipsis marks it)
      let rest = w;
      while (rest.length > budget) {
        lines.push(rest.slice(0, budget - 1) + "…");
        rest = rest.slice(budget - 1);
        if (lines.length === 2) {
          lines[1] = `${lines[1]}`.slice(0, budget - 1) + "…";
          return lines;
        }
      }
      cur = rest;
      continue;
    }
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= budget) cur = next;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === 2) {
        lines[1] = `${lines[1]}`.slice(0, budget - 1) + "…";
        return lines;
      }
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) {
    const folded = lines.slice(1).join(" ");
    const first = lines[0] ?? "";
    return [first, folded.length > budget ? `${folded.slice(0, budget - 1)}…` : folded];
  }
  return lines.length ? lines : [""];
};

export const makeYesNo = (dialogs: ReturnType<typeof makeDialogs>, ctx: YesNoCtx) => {
  const { openDialog, closeDialog, dialogBtn } = dialogs;

  let open = false;
  // danger flag of the pending confirm (drives the message fg on repaint)
  let lastDanger = false;
  // keyboard cursor over the two buttons (0 = No, 1 = Yes label). Defaults to
  // No so an accidental Enter never confirms a destructive op.
  let focusIdx = 0;
  let pendingYes: (() => void) | null = null;

  // raw teardown — registered with floats at open time
  const rawClose = (): void => {
    closeDialog("tfm-yesno");
    open = false;
    pendingYes = null;
    // hovered buttons have no out (their nodes are gone) — restore here
    ctx.setPointer?.("default");
  };

  const close = (): void => {
    ctx.floats.close("yesno");
  };

  // keyboard cursor paint — same surface dialogBtn's hover uses, by id
  const paintFocus = (): void => {
    const c = ctx.colors();
    for (let i = 0; i < 2; i++) {
      try {
        const node = ctx.byId(`tfm-yesno-b${i}`);
        if (node) applySurface(node, btnSurface(ctx.uiStyle(), c, i === focusIdx, c.sidebarBg));
      } catch {}
    }
  };

  // arrows move the cursor between No/Yes; submit activates the focused one.
  // Focus defaults to No so a stray Enter never confirms a destructive op.
  const moveFocus = (delta: number): void => {
    if (!open) return;
    focusIdx = (focusIdx + delta + 2) % 2;
    paintFocus();
  };

  const submit = (): void => {
    if (!open) return;
    if (focusIdx === 1) {
      const cb = pendingYes;
      close();
      cb?.();
    } else {
      close();
    }
  };

  const confirm = (message: string, yesLabel: string, onYes: () => void, danger = false): boolean => {
    if (open) return false;
    ctx.floats.open("yesno", rawClose);
    open = true;
    focusIdx = 0;
    pendingYes = onYes;
    lastDanger = danger;
    const c = ctx.colors();
    const yesFg = danger ? c.ansi1 : c.accent;
    let bseq = 0;
    const mkBtn = (label: string, fg: string, onPick: () => void): ReturnType<typeof Box> =>
      dialogBtn(`tfm-yesno-b${bseq++}`, label, fg, onPick);
    const msgLines = wrapYesNoMessage(message);
    openDialog({
      id: "tfm-yesno",
      zIndex: FLOAT_Z.yesno,
      width: YESNO_W,
      rows: () => [
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ id: "tfm-yesno-msg", content: ` ${msgLines[0] ?? ""}`, fg: yesFg }),
        ),
        ...(msgLines.length > 1
          ? [
              Box(
                { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
                Text({ id: "tfm-yesno-msg2", content: ` ${msgLines[1] ?? ""}`, fg: yesFg }),
              ),
            ]
          : []),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ id: "tfm-yesno-div", content: ` ${"~".repeat(YESNO_W - 2)}`, fg: c.divider }),
        ),
        Box({ height: 1 }),
        Box(
          { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
          mkBtn("[ No ]", c.white, () => close()),
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

  // theme-switch repaint while open: panel + texts by id, buttons through
  // the live focus paint. No rebuild — the pending confirm + cursor survive.
  const repaintYesNo = (): void => {
    if (!open) return;
    const c = ctx.colors();
    try {
      const panel = ctx.byId("tfm-yesno");
      if (panel) applySurface(panel, floatSurface(ctx.uiStyle(), c, c.sidebarBg));
    } catch {}
    for (const id of ["tfm-yesno-msg", "tfm-yesno-msg2"]) {
      try {
        const msg = ctx.byId(id);
        if (msg) msg.fg = lastDanger ? c.ansi1 : c.accent;
      } catch {}
    }
    try {
      const div = ctx.byId("tfm-yesno-div");
      if (div) div.fg = c.divider;
    } catch {}
    try {
      paintFocus();
    } catch {}
  };

  return { confirm, close, isOpen: (): boolean => open, repaint: repaintYesNo, moveFocus, submit };
};
