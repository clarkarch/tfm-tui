import { Box, type MouseEvent, Text } from "@opentui/core";
import type { ReadStream } from "node:fs";
import { fmtBytes } from "../fs/propsinfo";
import { hoverEvents, toggleIconState, type IconSlotHandle, type IconSpec, type SlotElement } from "./ui-slots";
import { sleep } from "./ui-lookup";
import type { Theme } from "../config/config";
import {
  TOAST_GAP,
  TOAST_H,
  TOAST_ICON_CELLS,
  TOAST_TEXT_BUDGET,
  TOAST_W,
  truncateToastText,
  type ToastHandle,
} from "./notify";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import { applySurface, islandSurface } from "./style";

// --- live copy progress: floating toast (top-right) with pause/cancel ---
// Owns the `prog` state the transfer engine reports into, the throttled
// repaint and the spinner. The toast SHELL (positioning, slide-in, stack
// membership, lifetime) lives in ./notify — this module only builds the
// interior rows and drives them through a sticky handle, so progress and
// plain notifies tile in one stack and can never share a slot. ---

export type ProgressCtx = {
  byId(id: string): MaybeNode;
  stripSelectable(): void;
  // live theme — always read through the getter, never captured
  colors(): Theme;
  makeIconSlot(
    name: string,
    states: { fg: string; bg: string }[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: MouseEvent) => void,
    statesFactory?: () => { fg: string; bg: string }[],
  ): IconSlotHandle;
  setIconState(spec: IconSpec | undefined, stateIdx: number): boolean;
  drainIconQueue(): unknown;
  // toast shell — owned by ./notify (single stack)
  notifySticky(children: SlotElement[], opts?: { width?: number; height?: number }): ToastHandle | null;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

export type ProgressState = {
  active: boolean;
  verb: string;
  doneFiles: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  paused: boolean;
  cancelled: boolean;
  // pre-scan "counting" mode: totals are still unknown, so paintProgress shows
  // an indeterminate `counting N files…` (nautilus' "Preparing" counter)
  counting?: boolean;
  currentRs: ReadStream | null;
  toastUp: boolean;
  // external-process controls (archive tools): cancel/pause hooks the toast
  // buttons invoke when no ReadStream is live
  processCancel?: (() => void) | null;
  processPause?: (() => void) | null;
};

export const pctOf = (bytes: number, totalBytes: number): number =>
  totalBytes > 0 ? Math.min(100, Math.floor((bytes / totalBytes) * 100)) : 0;

const barCells = (filled: number, cells: number): string =>
  "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));

export const barLine = (bytes: number, totalBytes: number, cells: number): string => {
  const filled = Math.round((pctOf(bytes, totalBytes) / 100) * cells);
  return `${barCells(filled, cells)} ${fmtBytes(bytes)}/${fmtBytes(totalBytes)}`;
};

// archive tools report entry names, not bytes — a file-count bar keeps the
// progress honest when totalBytes is unknown (totalBytes stays 0)
export const pctOfFiles = (done: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;

export const barLineFiles = (done: number, total: number, cells: number): string => {
  const filled = Math.round((pctOfFiles(done, total) / 100) * cells);
  return `${barCells(filled, cells)} ${Math.min(done, total)}/${total}`;
};

// pick the bar width so `<bar> <done>/<total>` fits `budget` cells WITHOUT
// truncating the numbers (a cut size reads as a different size). Clamped so
// the bar stays a visible bar even when the numbers are long.
export const barCellsFor = (budget: number, numer: string, denom: string): number =>
  Math.max(4, Math.min(14, budget - 2 - numer.length - denom.length));

// tiny transfers don't need a toast — canonical predicate lives in
// ./fsutil (the transfer pre-scan shares it); re-exported here so the
// widget's existing import surface doesn't move.
export { shouldToast } from "../fs/fsutil";

// "counting N files…" — the pre-scan has no honest total yet, so the toast
// must not print a fake `N/0 (0%)` bar. Pure so it's testable without a renderer.
export const countingLine = (files: number): string => `counting ${files} file${files === 1 ? "" : "s"}…`;

// verb → the 2-row media icon that owns the transfer toast's left column
// (same B1 shape as notify). Unknown verbs fall back to the copy glyph.
export const progressIconFor = (verb: string): string => {
  const v = verb.toLowerCase();
  if (v.includes("delet")) return "trash-can";
  if (v.includes("move") || v.includes("mov")) return "content-cut";
  if (v.includes("extract")) return "zip-box";
  if (v.includes("compress")) return "package";
  return "content-copy";
};

export const makeProgress = (ctx: ProgressCtx) => {
  const PROG_T_TITLE = "tfm-prog-title";
  const PROG_T_BAR = "tfm-prog-bar";
  const PROG_T_BTNS = "tfm-prog-btns";
  // the text column is TOAST_TEXT_BUDGET wide; the pause/close controls ride
  // the right end of the title row (2+2 cells + a gap), so the title gets what
  // is left and the bar keeps the full column
  const PROG_TITLE_BUDGET = TOAST_TEXT_BUDGET - 6;
  const PROG_BAR_BUDGET = TOAST_TEXT_BUDGET;
  // braille spinner frames (same as ~/loading_animation.py)
  const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const prog: ProgressState = {
    active: false,
    verb: "copying",
    doneFiles: 0,
    totalFiles: 0,
    bytes: 0,
    totalBytes: 0,
    paused: false,
    cancelled: false,
    currentRs: null,
    toastUp: false,
  };
  // live sticky handle — a re-show during the done-linger closes it first,
  // so two progress toasts never share the stack
  let activeHandle: ToastHandle | null = null;
  let progLastPaint = 0;
  let progSpinIdx = 0;
  let progSpinTimer: ReturnType<typeof setTimeout> | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  const progSetText = (nodeId: string, s: string): void => {
    const n = ctx.byId(nodeId);
    if (n) {
      try {
        n.content = s;
      } catch {}
    }
  };

  const paintProgress = (force = false): void => {
    if (!prog.active || !prog.toastUp) return;
    const now = Date.now();
    if (!force && now - progLastPaint < 120) return;
    progLastPaint = now;
    const spin = prog.paused ? "⏸" : SPIN_FRAMES[progSpinIdx];
    if (prog.counting) {
      progSetText(PROG_T_TITLE, truncateToastText(`${spin} ${countingLine(prog.doneFiles)}`, PROG_TITLE_BUDGET));
      progSetText(PROG_T_BAR, "");
      return;
    }
    const filesMode = prog.totalBytes <= 0 && prog.totalFiles > 0;
    const pct = filesMode ? pctOfFiles(prog.doneFiles, prog.totalFiles) : pctOf(prog.bytes, prog.totalBytes);
    progSetText(
      PROG_T_TITLE,
      truncateToastText(`${spin} ${prog.verb} ${prog.doneFiles}/${prog.totalFiles} (${pct}%)`, PROG_TITLE_BUDGET),
    );
    // size the bar to the numbers so the totals are never cut off
    const barCells = filesMode
      ? barCellsFor(PROG_BAR_BUDGET, String(Math.min(prog.doneFiles, prog.totalFiles)), String(prog.totalFiles))
      : barCellsFor(PROG_BAR_BUDGET, fmtBytes(prog.bytes), fmtBytes(prog.totalBytes));
    progSetText(
      PROG_T_BAR,
      filesMode
        ? barLineFiles(prog.doneFiles, prog.totalFiles, barCells)
        : barLine(prog.bytes, prog.totalBytes, barCells),
    );
  };

  const showProgressToast = (): void => {
    if (prog.toastUp) return;
    prog.toastUp = true;
    // a previous toast may still be lingering its done-state — close it
    // first so two progress toasts never share the stack
    activeHandle?.close();
    activeHandle = null;
    // ...and stop its spinner: that close path does not go through
    // finishProgressToast, so without this a re-show left a second 100ms
    // interval repainting a detached node forever
    if (progSpinTimer) {
      clearInterval(progSpinTimer);
      progSpinTimer = null;
    }
    // same for a pending done-linger: its handle-identity guard would no-op
    // it anyway, but a cleared timer is proof, not a race won
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    const setPauseVisual = (): void => {
      const p = ctx.byId(progPauseSpec.slotId);
      const l = ctx.byId(progPlaySpec.slotId);
      try {
        if (p) p.visible = !prog.paused;
      } catch {}
      try {
        if (l) l.visible = !!prog.paused;
      } catch {}
    };
    // pause/play are different shapes → two slots stacked in one hit area.
    // toast icons carry a hover state baked for the toast bg (the island fill);
    // the wrapper flips through islandSurface — the toast keeps its accentBg
    // island in every ui-style, so the buttons' rest fill must never clear
    // (btnSurface's outline branch would).
    const progBtnStates = (): { fg: string; bg: string }[] => [
      { fg: ctx.colors().white, bg: ctx.colors().accentBg },
      { fg: ctx.colors().white, bg: ctx.colors().hoverBg },
    ];
    const progPaint = (spec: IconSpec | undefined, btnId: string, on: boolean) => {
      ctx.setIconState(spec, toggleIconState(on, false));
      try {
        const n = ctx.byId(btnId);
        if (n) applySurface(n, islandSurface(ctx.colors(), on, ctx.colors().accentBg));
      } catch {}
    };
    const progPauseSpec = ctx.makeIconSlot("pause", progBtnStates(), 1, 0, undefined, progBtnStates);
    const progPlaySpec = ctx.makeIconSlot("play", progBtnStates(), 1, 0, undefined, progBtnStates);
    const progCloseSpec = ctx.makeIconSlot("close", progBtnStates(), 1, 0, undefined, progBtnStates);
    // ids live on the TEXT nodes — boxes have no .content, mutating them no-ops.
    // The shell (position, slide-in, stack slot) comes from notifySticky.
    // B1 media-object layout (same as notify): a 2-row verb icon owns the left
    // column and title + bar share the text column beside it. The pause/close
    // controls ride the right end of the title row, so the toast keeps the
    // same 2-row-content + symmetric-gutter shape as every notification.
    const mediaStates = (): { fg: string; bg: string }[] => [{ fg: ctx.colors().white, bg: ctx.colors().accentBg }];
    const verbSlot = ctx.makeIconSlot(
      progressIconFor(prog.verb),
      mediaStates(),
      TOAST_ICON_CELLS,
      0,
      undefined,
      mediaStates,
    );
    const btnsGroup = Box(
      { id: PROG_T_BTNS, flexDirection: "row", columnGap: 1 },
      Box(
        {
          id: "tfm-prog-pause",
          width: 2,
          height: 1,
          flexDirection: "row",
          ...islandSurface(ctx.colors(), false, ctx.colors().accentBg),
          onMouseDown: () => {
            prog.paused = !prog.paused;
            if (!prog.paused) {
              try {
                prog.currentRs?.resume();
              } catch {}
            } else {
              try {
                prog.currentRs?.pause();
              } catch {}
            }
            prog.processPause?.();
            setPauseVisual();
          },
          ...hoverEvents(
            (on) => progPaint(prog.paused ? progPlaySpec.spec : progPauseSpec.spec, "tfm-prog-pause", on),
            ctx.setPointer,
          ),
        },
        progPauseSpec.el,
        progPlaySpec.el,
      ),
      Box(
        {
          id: "tfm-prog-close",
          width: 2,
          height: 1,
          flexDirection: "row",
          ...islandSurface(ctx.colors(), false, ctx.colors().accentBg),
          onMouseDown: () => {
            prog.cancelled = true;
            try {
              prog.currentRs?.destroy(new Error("cancelled"));
            } catch {}
            prog.processCancel?.();
          },
          ...hoverEvents((on) => progPaint(progCloseSpec.spec, "tfm-prog-close", on), ctx.setPointer),
        },
        progCloseSpec.el,
      ),
    );
    const titleRow = Box(
      { height: 1, flexDirection: "row", columnGap: 1 },
      Box(
        { flexGrow: 1 },
        Text({ id: PROG_T_TITLE, content: `${SPIN_FRAMES[0]} ${prog.verb}`, fg: ctx.colors().white }),
      ),
      btnsGroup,
    );
    const barRow = Box({ height: 1 }, Text({ id: PROG_T_BAR, content: "", fg: ctx.colors().white }));
    const mediaRow = Box(
      { flexDirection: "row", columnGap: TOAST_GAP, alignItems: "center" },
      verbSlot.el,
      Box({ flexDirection: "column", flexGrow: 1 }, titleRow, barRow),
    );
    activeHandle = ctx.notifySticky([mediaRow], { width: TOAST_W, height: TOAST_H });
    // button Texts must not enter text-selection mode or they hijack the clicks
    ctx.stripSelectable();
    setPauseVisual(); // play slot ships visible — hide until actually paused
    void ctx.drainIconQueue();
    progSpinTimer = setInterval(() => {
      progSpinIdx = (progSpinIdx + 1) % SPIN_FRAMES.length;
      paintProgress(true);
    }, 100);
  };

  // swap to a terminal state (✓/✗ passed in title), linger briefly, then close
  const finishProgressToast = (title: string): void => {
    if (!prog.toastUp) return;
    prog.toastUp = false;
    // the buttons are gone with the toast — their out never fires, restore
    ctx.setPointer?.("default");
    const doneHandle = activeHandle;
    if (progSpinTimer) {
      clearInterval(progSpinTimer);
      progSpinTimer = null;
    }
    progSetText(PROG_T_TITLE, truncateToastText(title, PROG_TITLE_BUDGET));
    progSetText(PROG_T_BAR, "");
    // done means the controls go away — nothing left to pause or cancel
    const btns = ctx.byId(PROG_T_BTNS);
    if (btns) {
      try {
        btns.visible = false;
      } catch {}
    }
    lingerTimer = setTimeout(() => {
      // superseded by a re-show — the new toast owns the stack now
      if (activeHandle !== doneHandle) return;
      activeHandle = null;
      lingerTimer = null;
      try {
        doneHandle?.close();
      } catch {}
    }, 1800);
  };

  // pause/cancel gates used between files AND mid-stream
  const pauseGate = async (): Promise<void> => {
    while (prog.paused && !prog.cancelled) await sleep(80);
  };

  // theme-switch repaint while a transfer toast is up: container + texts +
  // buttons by id. Ticks only rewrite text content, so without this a
  // mid-transfer palette landing leaves the toast stale until it finishes.
  const repaint = (): void => {
    if (activeHandle === null) return;
    const c = ctx.colors();
    try {
      const shell = ctx.byId(activeHandle.nodeId);
      if (shell) shell.backgroundColor = c.accentBg;
    } catch {}
    for (const id of [PROG_T_TITLE, PROG_T_BAR]) {
      try {
        const n = ctx.byId(id);
        if (n) n.fg = c.white;
      } catch {}
    }
    for (const id of ["tfm-prog-pause", "tfm-prog-close"]) {
      try {
        const n = ctx.byId(id);
        if (n) applySurface(n, islandSurface(c, false, c.accentBg));
      } catch {}
    }
  };

  return {
    prog,
    paintProgress,
    showProgressToast,
    finishProgressToast,
    pauseGate,
    isOpen: (): boolean => activeHandle !== null,
    repaint,
  };
};
