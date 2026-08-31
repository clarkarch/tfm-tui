// --- Resize handling: a terminal drag fires RESIZE many times per second;
// the rebuild is trailing-debounced so only the final geometry repaints. The
// icon queue resets first so every raster re-renders at the new cell pixels
// (kitty rasters are baked at exact sizes). ---

export type ResizeCtx = {
  resetIconQueue(): void;
  renderAll(): void;
  delayMs?: number;
};

export const makeResizeWatcher = (ctx: ResizeCtx) => {
  const ms = ctx.delayMs ?? 150;
  let timer: any = null;
  const onResize = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      ctx.resetIconQueue();
      ctx.renderAll();
    }, ms);
  };
  return { onResize };
};
