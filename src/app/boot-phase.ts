// --- The boot paint's PHASE.
//
// The lazy plugin scan asks one question when it settles: "does the boot
// paint still cover my arrival, or do I need a repaint?" The old shape
// answered it with a BOOLEAN (`bootRendered`), which cannot say whether the
// paint is still IN FLIGHT:
//
//   pre-paint — the boot paint has not been requested: the pending paint
//               reads the live plugin registry, so it covers the arrival
//               → NO repaint
//   painting  — the paint is in flight: it read the registry BEFORE the
//               arrival, so a repaint IS due — but firing it now would
//               interleave a second full render with the boot paint (the
//               grid's gen guard abandons the boot's own render mid-flight)
//               → DEFER it until the paint settles
//   painted   — the paint window is closed → repaint NOW
//
// Pure: no imports, no fs, no renderer. The gate is owned by the wiring
// cluster that asks the question (the plugins wiring) and driven by the
// one that performs the paint (the boot render seam).

export type BootPhase = "pre-paint" | "painting" | "painted";

export type BootPaintGate = {
  /** the current phase */
  phase(): BootPhase;
  /** the boot paint was REQUESTED — the phase flips in the SAME call that performs it */
  beginPaint(): void;
  /** the boot paint SETTLED — a deferred late-arrival repaint runs now */
  endPaint(): void;
  /** a late arrival: skip it, defer it, or fire it — per the phase */
  lateArrival(repaint: () => void): void;
};

export const makeBootPaintGate = (): BootPaintGate => {
  let phase: BootPhase = "pre-paint";
  // the repaint a late arrival asked for while the paint was in flight —
  // ONE slot: the last request wins (they all ask for the same repaint)
  let deferred: (() => void) | null = null;
  return {
    phase: () => phase,
    beginPaint: () => {
      // one-way: a CLOSED paint window never reopens — a late arrival would
      // then be deferred forever (nothing would end the second paint)
      if (phase === "pre-paint") phase = "painting";
    },
    endPaint: () => {
      phase = "painted";
      const due = deferred;
      deferred = null;
      due?.();
    },
    lateArrival: (repaint) => {
      // the pending paint will read the live registry — it covers the arrival
      if (phase === "pre-paint") return;
      // the paint is in flight: defer, so the boot paint is not interleaved
      if (phase === "painting") {
        deferred = repaint;
        return;
      }
      repaint();
    },
  };
};
