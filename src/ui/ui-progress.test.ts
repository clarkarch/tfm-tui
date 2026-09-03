import { describe, expect, test } from "bun:test";
import { barLine, makeProgress, pctOf, shouldToast, type ProgressCtx } from "./ui-progress";
import type { ToastHandle } from "./notify";

const MB = 1024 * 1024;

const stubCtx = (over: Partial<ProgressCtx> = {}): { ctx: ProgressCtx; calls: string[] } => {
  const calls: string[] = [];
  const ctx: ProgressCtx = {
    byId: () => undefined,
    stripSelectable: () => {},
    // partial theme is fine — only white/accentBg/hoverBg are read
    colors: () => ({ white: "#ffffff", accentBg: "#1a1b26", hoverBg: "#2a2b36" }) as any,
    makeIconSlot: () => ({ el: {}, slotId: "tfm-icon-test", spec: {} }),
    setIconState: () => false,
    drainIconQueue: () => {},
    // shell belongs to ./notify — the stub hands out closable handles
    notifySticky: (_children: any[], _opts?: { width?: number; height?: number }) => {
      calls.push("sticky:show");
      const handle: ToastHandle = {
        id: calls.length,
        nodeId: `tfm-toast-${calls.length}`,
        close: () => {
          calls.push("sticky:close");
        },
      };
      return handle;
    },
    ...over,
  };
  return { ctx, calls };
};

describe("pctOf", () => {
  test("zero total never divides by zero", () => {
    expect(pctOf(0, 0)).toBe(0);
    expect(pctOf(10, 0)).toBe(0);
  });

  test("floors to whole percent", () => {
    expect(pctOf(50, 200)).toBe(25);
    expect(pctOf(1, 3)).toBe(33);
  });

  test("clamps at 100", () => {
    expect(pctOf(300, 200)).toBe(100);
  });
});

describe("barLine", () => {
  test("empty bar at zero bytes", () => {
    expect(barLine(0, 0, 14)).toBe("░░░░░░░░░░░░░░ 0 B/0 B");
  });

  test("half fill rounds to nearest cell", () => {
    expect(barLine(50, 100, 14)).toBe("███████░░░░░░░ 50 B/100 B");
  });

  test("full bar when bytes exceed total", () => {
    expect(barLine(200, 100, 14)).toBe("██████████████ 200 B/100 B");
  });
});

describe("shouldToast", () => {
  test("small transfers stay toastless", () => {
    expect(shouldToast(4 * MB, 1)).toBe(false);
    expect(shouldToast(0, 4)).toBe(false);
  });

  test("big byte count or many files raises the toast", () => {
    expect(shouldToast(4 * MB + 1, 1)).toBe(true);
    expect(shouldToast(0, 5)).toBe(true);
  });
});

describe("makeProgress gates", () => {
  test("pauseGate blocks while paused and unblocks on resume", async () => {
    const { prog, pauseGate } = makeProgress(stubCtx().ctx);
    prog.paused = true;
    let released = false;
    const gate = pauseGate().then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(released).toBe(false);
    prog.paused = false;
    await gate;
    expect(released).toBe(true);
  });

  test("pauseGate returns immediately when cancelled", async () => {
    const { prog, pauseGate } = makeProgress(stubCtx().ctx);
    prog.paused = true;
    prog.cancelled = true;
    await pauseGate();
  });

  test("paintProgress is a safe no-op with no live nodes", () => {
    const { prog, paintProgress } = makeProgress(stubCtx().ctx);
    prog.active = true;
    prog.toastUp = true;
    expect(() => paintProgress(true)).not.toThrow();
  });

  test("showProgressToast builds with stub ctx; finish clears the spinner", () => {
    const { prog, showProgressToast, finishProgressToast } = makeProgress(stubCtx().ctx);
    prog.active = true;
    showProgressToast();
    expect(prog.toastUp).toBe(true);
    finishProgressToast("✓ done");
    expect(prog.toastUp).toBe(false);
  });

  test("show opens one sticky shell; finish closes it after the linger", async () => {
    // the shell belongs to ./notify — progress only drives the handle:
    // no close during the linger (notifies must keep stacking below),
    // exactly one close after it
    const { ctx, calls } = stubCtx();
    const { showProgressToast, finishProgressToast } = makeProgress(ctx);
    showProgressToast();
    expect(calls).toEqual(["sticky:show"]);
    finishProgressToast("✓ done");
    // still lingering: handle open
    expect(calls).toEqual(["sticky:show"]);
    const deadline = Date.now() + 5000;
    while (!calls.includes("sticky:close") && Date.now() < deadline) await Bun.sleep(50);
    expect(calls).toEqual(["sticky:show", "sticky:close"]);
  });

  test("re-show during the linger closes the stale handle first", async () => {
    // back-to-back transfers: without the handoff the lingering done-toast
    // and the fresh toast share the stack
    const { ctx, calls } = stubCtx();
    const { prog, showProgressToast, finishProgressToast } = makeProgress(ctx);
    showProgressToast();
    finishProgressToast("✓ done");
    showProgressToast(); // second transfer lands inside the linger window
    expect(calls).toEqual(["sticky:show", "sticky:close", "sticky:show"]);
    expect(prog.toastUp).toBe(true);
    // past the old lifecycle's linger point: it must not close the new toast
    await Bun.sleep(2100);
    expect(calls).toEqual(["sticky:show", "sticky:close", "sticky:show"]);
    expect(prog.toastUp).toBe(true);
  });
});
