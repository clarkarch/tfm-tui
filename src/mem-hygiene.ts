// --- Native memory hygiene: OpenTUI's native objects (TextBuffers, images)
// are freed from bun GC finalizers, but bun only runs GC when the JS HEAP
// demands it — native memory pressure never triggers it. Sustained UI churn
// (theme flips, panel rebuilds) grows the native allocator unbounded until
// small allocations start failing ("Failed to create TextBuffer" = the
// floating-UI-vanishes crash). Poke the GC on a schedule so finalizers drain
// regularly, and trace allocator stats under --debug. Renderer-free — the
// (private) allocator-stats reach happens at the call site. ---

export type AllocatorStats = { activeAllocations: number; totalRequestedBytes: number };

// one "mem ..." heartbeat line: allocator activity + process RSS
export const nativeMemLine = (stats: AllocatorStats | null): string => {
  let out = "n/a";
  if (stats) {
    out = `native active=${stats.activeAllocations} mem=${(stats.totalRequestedBytes / 1048576).toFixed(1)}MB`;
  }
  try {
    out += ` rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`;
  } catch {}
  return out;
};

export type MemHygieneCtx = {
  // renderer.lib.getAllocatorStats() is private — any-cast it at the call site
  allocatorStats: () => AllocatorStats | null;
  // heartbeat lines are only interesting under --debug
  debugLog?: (msg: string) => void;
  intervalMs?: number;
};

// returns a stop() so tests (or a future settings knob) can tear it down
export const startMemHygiene = (ctx: MemHygieneCtx): (() => void) => {
  const timer = setInterval(() => {
    try {
      Bun.gc(false);
    } catch {}
    if (ctx.debugLog) ctx.debugLog(`mem ${nativeMemLine(ctx.allocatorStats())}`);
  }, ctx.intervalMs ?? 10000);
  timer.unref?.();
  return () => clearInterval(timer);
};
