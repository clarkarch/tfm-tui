import { Box, Text } from "@opentui/core";
import type { ReadStream } from "node:fs";
import { animateLeft } from "./notify";
import { fmtBytes } from "./propsinfo";
import type { Theme } from "./config";

// --- live copy progress: floating toast (top-right) with pause/cancel ---
// Owns the `prog` state the transfer engine reports into, the throttled
// repaint and the slide-in toast with pause/close buttons. Renderer access,
// theme and the icon-slot machinery arrive through ctx (same seam as
// ui-dialogs/notify); the pure math below is exported for tests.

export type ProgressCtx = {
  byId(id: string): any;
  rootAdd(node: any): void;
  remove(node: any): void;
  stripSelectable(): void;
  termW(): number;
  toastCount(): number;
  colors(): Theme & Record<string, any>;
  makeIconSlot(
    name: string,
    states: { fg: string; bg: string }[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: any) => void,
    statesFactory?: () => { fg: string; bg: string }[],
  ): { el: any; slotId: string; spec: any };
  setIconState(spec: any, stateIdx: number): boolean;
  drainIconQueue(): unknown;
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
  currentRs: ReadStream | null;
  toastUp: boolean;
};

export const pctOf = (bytes: number, totalBytes: number): number =>
  totalBytes > 0 ? Math.min(100, Math.floor((bytes / totalBytes) * 100)) : 0;

export const barLine = (bytes: number, totalBytes: number, cells: number): string => {
  const filled = Math.round((pctOf(bytes, totalBytes) / 100) * cells);
  return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled)) + ` ${fmtBytes(bytes)}/${fmtBytes(totalBytes)}`;
};

// tiny transfers don't need a toast
export const shouldToast = (totalBytes: number, totalFiles: number): boolean =>
  totalBytes > 4 * 1024 * 1024 || totalFiles > 4;

export const makeProgress = (ctx: ProgressCtx) => {
  const PROG_TOAST_ID = "tfm-prog-toast";
  const PROG_T_TITLE = "tfm-prog-title";
  const PROG_T_BAR = "tfm-prog-bar";
  const PROG_T_BTNS = "tfm-prog-btns";
  const PROG_W = 42;
  const PROG_BAR_CELLS = 14;
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
  let progLastPaint = 0;
  let progSpinIdx = 0;
  let progSpinTimer: any = null;

  const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const progSetText = (nodeId: string, s: string): void => {
    const n: any = ctx.byId(nodeId);
    if (n) { try { n.content = s; } catch {} }
  };

  const paintProgress = (force = false): void => {
    if (!prog.active || !prog.toastUp) return;
    const now = Date.now();
    if (!force && now - progLastPaint < 120) return;
    progLastPaint = now;
    const spin = prog.paused ? "⏸" : SPIN_FRAMES[progSpinIdx];
    progSetText(PROG_T_TITLE, `${spin} ${prog.verb} ${prog.doneFiles}/${prog.totalFiles} (${pctOf(prog.bytes, prog.totalBytes)}%)`);
    progSetText(PROG_T_BAR, barLine(prog.bytes, prog.totalBytes, PROG_BAR_CELLS).slice(0, PROG_W - 2));
  };

  const showProgressToast = (): void => {
    if (prog.toastUp) return;
    prog.toastUp = true;
    const y = 1 + ctx.toastCount() * 4;
    const setPauseVisual = (): void => {
      const p: any = ctx.byId(progPauseSpec.slotId);
      const l: any = ctx.byId(progPlaySpec.slotId);
      try { if (p) p.visible = !prog.paused; } catch {}
      try { if (l) l.visible = !!prog.paused; } catch {}
    };
    // pause/play are different shapes → two slots stacked in one hit area
    // toast icons carry a hover state baked for the toast bg
    const progBtnStates = (): { fg: string; bg: string }[] => [
      { fg: ctx.colors().white, bg: ctx.colors().accentBg },
      { fg: ctx.colors().white, bg: ctx.colors().hoverBg },
    ];
    const progPaint = (spec: any, btnId: string, on: boolean) => {
      ctx.setIconState(spec, on ? 1 : 0);
      try {
        const n: any = ctx.byId(btnId);
        if (n) n.backgroundColor = on ? ctx.colors().hoverBg : ctx.colors().accentBg;
      } catch {}
    };
    const progPauseSpec = ctx.makeIconSlot("pause", progBtnStates(), 1, 0, undefined, progBtnStates);
    const progPlaySpec = ctx.makeIconSlot("play", progBtnStates(), 1, 0, undefined, progBtnStates);
    const progCloseSpec = ctx.makeIconSlot("close", progBtnStates(), 1, 0, undefined, progBtnStates);
    const scrimless = Box(
      {
        id: PROG_TOAST_ID,
        position: "absolute",
        left: ctx.termW() + 2,
        top: y,
        width: PROG_W,
        height: 4,
        zIndex: 3500,
        backgroundColor: ctx.colors().accentBg,
        flexDirection: "column",
      },
      // ids live on the TEXT nodes — boxes have no .content, mutating them no-ops
      Box({ height: 1 }, Text({ id: PROG_T_TITLE, content: `${SPIN_FRAMES[0]} ${prog.verb}`, fg: ctx.colors().white })),
      Box({ height: 1 }, Text({ id: PROG_T_BAR, content: "", fg: ctx.colors().white })),
      Box(
        { id: PROG_T_BTNS, height: 1, flexDirection: "row", paddingLeft: 1, columnGap: 1 },
        Box(
          {
            id: "tfm-prog-pause",
            width: 2,
            height: 1,
            flexDirection: "row",
            backgroundColor: ctx.colors().accentBg,
            onMouseDown: () => {
              prog.paused = !prog.paused;
              if (!prog.paused) { try { prog.currentRs?.resume(); } catch {} }
              else { try { prog.currentRs?.pause(); } catch {} }
              setPauseVisual();
            },
            onMouseOver: () => progPaint(prog.paused ? progPlaySpec.spec : progPauseSpec.spec, "tfm-prog-pause", true),
            onMouseOut: () => progPaint(prog.paused ? progPlaySpec.spec : progPauseSpec.spec, "tfm-prog-pause", false),
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
            backgroundColor: ctx.colors().accentBg,
            onMouseDown: () => {
              prog.cancelled = true;
              try { prog.currentRs?.destroy(new Error("cancelled")); } catch {}
            },
            onMouseOver: () => progPaint(progCloseSpec.spec, "tfm-prog-close", true),
            onMouseOut: () => progPaint(progCloseSpec.spec, "tfm-prog-close", false),
          },
          progCloseSpec.el,
        ),
      ),
    );
    ctx.rootAdd(scrimless);
    // button Texts must not enter text-selection mode or they hijack the clicks
    ctx.stripSelectable();
    setPauseVisual(); // play slot ships visible — hide until actually paused
    void ctx.drainIconQueue();
    const real: any = ctx.byId(PROG_TOAST_ID);
    if (real) animateLeft(real, ctx.termW() + 2, Math.max(0, ctx.termW() - PROG_W - 2), 180);
    progSpinTimer = setInterval(() => {
      progSpinIdx = (progSpinIdx + 1) % SPIN_FRAMES.length;
      paintProgress(true);
    }, 100);
  };

  // swap to a terminal state (✓/✗ passed in title), linger briefly, slide away
  const finishProgressToast = (title: string): void => {
    if (!prog.toastUp) return;
    prog.toastUp = false;
    if (progSpinTimer) { clearInterval(progSpinTimer); progSpinTimer = null; }
    progSetText(PROG_T_TITLE, title.slice(0, PROG_W - 2));
    progSetText(PROG_T_BAR, "");
    // done means the controls go away — nothing left to pause or cancel
    const btns: any = ctx.byId(PROG_T_BTNS);
    if (btns) { try { btns.visible = false; } catch {} }
    setTimeout(() => {
      const real: any = ctx.byId(PROG_TOAST_ID);
      if (!real) return;
      animateLeft(real, typeof real.left === "number" ? real.left : 0, ctx.termW() + 2, 180);
      setTimeout(() => {
        try { ctx.remove(real); } catch {}
      }, 200);
    }, 1800);
  };

  // pause/cancel gates used between files AND mid-stream
  const pauseGate = async (): Promise<void> => {
    while (prog.paused && !prog.cancelled) await sleepMs(80);
  };

  return { prog, paintProgress, showProgressToast, finishProgressToast, pauseGate };
};
