// --- The boot paint's PHASE.
//
// The lazy plugin scan asks one question when it settles: "does the boot
// paint still cover my arrival, or do I need a repaint?" The old shape
// answered it with a BOOLEAN (`bootRendered`), which cannot say whether the
// paint is still IN FLIGHT:
//
//   pre-paint  — the boot paint has not been requested: the pending paint
//                reads the live plugin registry, so it covers the arrival
//                → NO repaint
//   painting   — the paint is in flight: it read the registry BEFORE the
//                arrival, so a repaint IS due — but firing it now would
//                interleave a second full render with the boot paint (the
//                grid's gen guard abandons the boot's own render
//                mid-flight) → DEFER it until the paint settles
//   painted    — the paint landed without the arrival → repaint NOW

import { describe, expect, test } from "bun:test";
import { makeBootPaintGate } from "./boot-phase";

describe("the boot paint gate", () => {
  test("a late arrival BEFORE the paint needs no repaint — the pending paint covers it", () => {
    const gate = makeBootPaintGate();
    let repaints = 0;
    gate.lateArrival(() => {
      repaints++;
    });
    expect(repaints).toBe(0);
    expect(gate.phase()).toBe("pre-paint");
  });

  test("a late arrival DURING the paint is DEFERRED, not interleaved with it", () => {
    const gate = makeBootPaintGate();
    let repaints = 0;
    gate.beginPaint();
    expect(gate.phase()).toBe("painting");
    gate.lateArrival(() => {
      repaints++;
    });
    // the in-flight paint read the plugin registry BEFORE the arrival: a
    // repaint is due, but firing it now would start a second full render
    // beside the boot paint
    expect(repaints).toBe(0);
    gate.endPaint();
    // the paint settled → the deferred repaint runs, exactly once
    expect(repaints).toBe(1);
    expect(gate.phase()).toBe("painted");
  });

  test("a late arrival AFTER the paint repaints immediately", () => {
    const gate = makeBootPaintGate();
    gate.beginPaint();
    gate.endPaint();
    let repaints = 0;
    gate.lateArrival(() => {
      repaints++;
    });
    expect(repaints).toBe(1);
  });

  test("two arrivals during one paint repaint ONCE", () => {
    const gate = makeBootPaintGate();
    gate.beginPaint();
    let repaints = 0;
    gate.lateArrival(() => {
      repaints++;
    });
    gate.lateArrival(() => {
      repaints++;
    });
    gate.endPaint();
    expect(repaints).toBe(1);
  });

  test("the phase is one-way: a second begin never reopens a finished paint", () => {
    const gate = makeBootPaintGate();
    gate.beginPaint();
    gate.beginPaint();
    expect(gate.phase()).toBe("painting");
    gate.endPaint();
    gate.endPaint();
    expect(gate.phase()).toBe("painted");
    // a late arrival after a reopened paint would be deferred forever
    let repaints = 0;
    gate.beginPaint();
    expect(gate.phase()).toBe("painted");
    gate.lateArrival(() => {
      repaints++;
    });
    expect(repaints).toBe(1);
  });
});
