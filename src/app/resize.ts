// --- Resize handling: a terminal drag fires RESIZE many times per second;
// the rebuild is trailing-debounced so only the final geometry repaints. The
// icon queue resets first so every raster re-renders at the new cell pixels
// (kitty rasters are baked at exact sizes). ---

import type { Scheduler } from "../ui/uiutil";

export type ResizeCtx = {
  resetIconQueue(): void;
  renderAll(): void;
  delayMs?: number;
  // injectable clock (tests use a virtual one); defaults to real timers
  sched?: Scheduler;
};

export const makeResizeWatcher = (ctx: ResizeCtx) => {
  const ms = ctx.delayMs ?? 150;
  const sched: Scheduler = ctx.sched ?? globalThis;
  let timer: unknown = null;
  const onResize = (): void => {
    if (timer !== null) sched.clearTimeout(timer);
    timer = sched.setTimeout(() => {
      timer = null;
      ctx.resetIconQueue();
      ctx.renderAll();
    }, ms);
  };
  return { onResize };
};
