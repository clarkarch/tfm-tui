// --- Status bar writes: transient messages land on tfm-status-label and the
// selection summary reclaims the bar after a quiet period (the reset fires
// `resetDelayMs` after the LAST message, like a debounce). The refresh fn is
// injected (selection's updateSelectionStatusReal) so this module stays
// renderer-free — nodes arrive through byId. ---

import { debounced, type Scheduler } from "../lib/uiutil";

type StatusCtx = {
  setText(id: string, s: string): void;
  refresh(): void;
  resetDelayMs?: number;
  // injectable clock (tests use a virtual one); defaults to real timers
  sched?: Scheduler;
};

// The bar shows EITHER a transient message (an op's outcome) OR the
// selection summary. The phase is ONE explicit record: the old shape kept
// it in the LABEL NODE's content, so nothing knew a message was live — a
// selection-driven write simply overwrote it (the message was yanked before
// its window elapsed) while the reclaim timer stayed armed.
export type StatusState = { phase: "transient"; text: string } | { phase: "summary" };

export const STATUS_LABEL_ID = "tfm-status-label";

export const makeStatus = (ctx: StatusCtx) => {
  let state: StatusState = { phase: "summary" };

  const clearStatusMsg = debounced(
    ctx.resetDelayMs ?? 2500,
    () => {
      // the transient window is over — the summary owns the label again
      state = { phase: "summary" };
      ctx.refresh();
    },
    ctx.sched ?? globalThis,
  );

  // the TRANSIENT writer: it takes the label and holds it until its deadline
  const setStatusMsg = (text: string): void => {
    state = { phase: "transient", text };
    ctx.setText(STATUS_LABEL_ID, text);
    clearStatusMsg();
  };

  // the SUMMARY writer (the selection's status line): a live transient
  // message wins until its deadline. The summary is not lost — the reclaim
  // refresh recomputes it from the live selection when the window ends.
  const setStatusLabel = (id: string, text: string): void => {
    if (id === STATUS_LABEL_ID && state.phase === "transient") return;
    ctx.setText(id, text);
  };

  return { setStatusMsg, setStatusLabel, clearStatusMsg };
};
