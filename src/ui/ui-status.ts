// --- Status bar writes: transient messages land on tfm-status-label and the
// selection summary reclaims the bar after a quiet period (the reset fires
// `resetDelayMs` after the LAST message, like a debounce). The refresh fn is
// injected (selection's updateSelectionStatusReal) so this module stays
// renderer-free — nodes arrive through byId. ---

import { debounced } from "./uiutil";

export type StatusCtx = {
  byId(id: string): any;
  refresh(): void;
  resetDelayMs?: number;
};

export const makeStatus = (ctx: StatusCtx) => {
  const clearStatusMsg = debounced(ctx.resetDelayMs ?? 2500, () => ctx.refresh());

  const setStatusMsg = (text: string): void => {
    const status: any = ctx.byId("tfm-status-label");
    if (status) {
      try {
        status.content = text;
      } catch {}
    }
    clearStatusMsg();
  };

  return { setStatusMsg, clearStatusMsg };
};
