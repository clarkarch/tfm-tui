import { describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  barCellsFor,
  barLine,
  barLineFiles,
  countingLine,
  makeProgress,
  pctOf,
  pctOfFiles,
  progressIconFor,
  shouldToast,
  type ProgressCtx,
} from "./ui-progress";
import type { ToastHandle } from "./notify";
import type { MaybeNode } from "../lib/node-like";
import type { IconSlotHandle } from "./ui-slots";

const MB = 1024 * 1024;

const stubCtx = (over: Partial<ProgressCtx> = {}): { ctx: ProgressCtx; calls: string[] } => {
  const calls: string[] = [];
  const ctx: ProgressCtx = {
    byId: () => undefined,
    stripSelectable: () => {},
    // partial theme is fine — only white/accentBg/hoverBg are read
    colors: () => ({ white: "#ffffff", accentBg: "#1a1b26", hoverBg: "#2a2b36" }) as any,
    // the progress path only reads slotId; el/spec are placeholders
    makeIconSlot: () => ({ el: {}, slotId: "tfm-icon-test", spec: {} }) as unknown as IconSlotHandle,
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

describe("pctOfFiles / barLineFiles", () => {
  test("file-count bar for tools that report no bytes", () => {
    expect(pctOfFiles(0, 0)).toBe(0);
    expect(pctOfFiles(1, 4)).toBe(25);
    expect(pctOfFiles(9, 4)).toBe(100);
    expect(barLineFiles(1, 4, 14)).toBe("████░░░░░░░░░░ 1/4");
    expect(barLineFiles(9, 4, 14)).toBe("██████████████ 4/4");
  });
});

describe("barCellsFor", () => {
  test("sizes the bar so the numbers fit inside the budget", () => {
    // 29 - 2 spaces - "120.0 MB" - "500.0 MB"
    expect(barCellsFor(29, "120.0 MB", "500.0 MB")).toBe(11);
    // the resulting line never exceeds the budget
    const cells = barCellsFor(29, "120.0 MB", "500.0 MB");
    expect(barLine(120 * MB, 500 * MB, cells).length).toBeLessThanOrEqual(29);
  });

  test("clamped to [4, 14] — a short line caps, a tight one still shows a bar", () => {
    expect(barCellsFor(29, "1 B", "2 B")).toBe(14);
    // 15 - 2 - 9 - 9 is negative: clamp up so the bar stays a bar
    expect(barCellsFor(15, "1023.9 KB", "1023.9 KB")).toBe(4);
  });
});

describe("progressIconFor", () => {
  test("maps the transfer verb to the media-column icon", () => {
    expect(progressIconFor("copying")).toBe("content-copy");
    expect(progressIconFor("moving")).toBe("content-cut");
    expect(progressIconFor("deleting")).toBe("trash-can");
    expect(progressIconFor("extracting")).toBe("zip-box");
    expect(progressIconFor("compressing")).toBe("package");
    // unknown verbs fall back to the copy glyph (never an unverified asset)
    expect(progressIconFor("teleporting")).toBe("content-copy");
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

  test("the spinner rides the app's shared animation clock", () => {
    // OpenTUI 0.8.0's onAnimationTick: the ticker lives in the render loop,
    // so the spinner cannot drift from the frames it paints (and it stops
    // with the renderer). A private setInterval cannot.
    const ticks: Array<() => void> = [];
    let unsubscribed = 0;
    const nodes = new Map<string, { content: string }>();
    for (const id of ["tfm-prog-title", "tfm-prog-bar"]) nodes.set(id, { content: "" });
    const { ctx } = stubCtx({
      byId: (id: string) => nodes.get(id) as unknown as MaybeNode,
      onTick: (_fps, cb) => {
        ticks.push(cb);
        return () => {
          unsubscribed++;
        };
      },
    });
    const { prog, showProgressToast, finishProgressToast } = makeProgress(ctx);
    prog.active = true;
    showProgressToast();
    expect(ticks.length).toBe(1);
    // the clock drives the spinner
    ticks[0]?.();
    expect(nodes.get("tfm-prog-title")!.content).not.toBe("");
    // and finishing the toast releases the ticker
    finishProgressToast("✓ done");
    expect(unsubscribed).toBe(1);
  });

  test("a re-show releases the previous ticker (a leaked one pins the renderer at 10fps)", () => {
    // The re-show path does NOT go through finishProgressToast — it closes the
    // stale handle itself, so it must stop the stale spinner too. The toast
    // going down without finishProgressToast is the case that leaves a live
    // spinner behind (the stack closed it, not the op).
    const ticks: Array<() => void> = [];
    let unsubscribed = 0;
    const { ctx } = stubCtx({
      onTick: (_fps, cb) => {
        ticks.push(cb);
        return () => {
          unsubscribed++;
        };
      },
    });
    const { prog, showProgressToast } = makeProgress(ctx);
    prog.active = true;
    showProgressToast();
    expect(ticks.length).toBe(1);
    prog.toastUp = false; // the toast vanished without finishProgressToast
    showProgressToast();
    expect(ticks.length).toBe(2);
    // the FIRST ticker was released by the re-show
    expect(unsubscribed).toBe(1);
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
    // past the old lifecycle's linger point: it must not close the new toast.
    // Poll the forbidden close so a regression fails fast instead of at the end.
    const deadline = Date.now() + 2300;
    while (Date.now() < deadline) {
      await Bun.sleep(50);
      expect(calls).toEqual(["sticky:show", "sticky:close", "sticky:show"]);
      expect(prog.toastUp).toBe(true);
    }
  });
});

// The pre-scan can run for seconds before any honest total exists. Painting
// `0/N (0%)` against totalFiles 0 would read as a broken bar, so the counting
// state owns its own line — and must stop owning it the moment totals land.
describe("counting pre-scan paint", () => {
  test("countingLine is singular-aware", () => {
    expect(countingLine(0)).toBe("counting 0 files…");
    expect(countingLine(1)).toBe("counting 1 file…");
    expect(countingLine(1000)).toBe("counting 1000 files…");
  });

  test("paintProgress writes the counting line and blanks the bar", () => {
    const nodes = new Map<string, { content: string }>();
    for (const id of ["tfm-prog-title", "tfm-prog-bar"]) nodes.set(id, { content: "" });
    const { ctx } = stubCtx({ byId: (id: string) => nodes.get(id) as unknown as MaybeNode });
    const { prog, paintProgress } = makeProgress(ctx);
    prog.active = true;
    prog.toastUp = true;
    prog.counting = true;
    prog.doneFiles = 37;
    paintProgress(true);
    expect(nodes.get("tfm-prog-title")!.content).toContain("counting 37 files…");
    expect(nodes.get("tfm-prog-bar")!.content).toBe("");
  });

  test("clearing counting hands the paint back to the byte bar", () => {
    const nodes = new Map<string, { content: string }>();
    for (const id of ["tfm-prog-title", "tfm-prog-bar"]) nodes.set(id, { content: "" });
    const { ctx } = stubCtx({ byId: (id: string) => nodes.get(id) as unknown as MaybeNode });
    const { prog, paintProgress } = makeProgress(ctx);
    prog.active = true;
    prog.toastUp = true;
    prog.counting = true;
    prog.doneFiles = 5;
    paintProgress(true);
    expect(nodes.get("tfm-prog-title")!.content).toContain("counting");
    prog.counting = false;
    prog.doneFiles = 2;
    prog.bytes = 10;
    prog.totalBytes = 20;
    prog.totalFiles = 4;
    paintProgress(true);
    expect(nodes.get("tfm-prog-title")!.content).toContain("copying 2/4 (50%)");
    expect(nodes.get("tfm-prog-bar")!.content).toContain("10 B/20 B");
  });
});

describe("progress repaint", () => {
  const hexInts = (hex: string): [number, number, number, number] => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
  };

  test("repaint() repaints the live toast shell with live colors", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      let live: any = { white: "#ffffff", accentBg: "#1a1b26", hoverBg: "#2a2b36" };
      let seq = 0;
      let slotSeq = 0;
      const { ctx } = stubCtx({
        colors: () => live,
        // real slot boxes — the stub's plain-object el can't mount
        makeIconSlot: () =>
          ({
            el: Box({ width: 2, height: 1 }),
            slotId: `tfm-slot-${++slotSeq}`,
            spec: {},
          }) as unknown as IconSlotHandle,
        byId: (id: string) => t.renderer.root.findDescendantById(id),
        notifySticky: (children: any[]) => {
          const nodeId = `tfm-toast-${++seq}`;
          // mirrors ./notify: accentBg shell wrapping the progress rows
          t.renderer.root.add(Box({ id: nodeId, backgroundColor: live.accentBg }, ...children));
          const handle: ToastHandle = { id: seq, nodeId, close: () => {} };
          return handle;
        },
      });
      const { prog, showProgressToast, isOpen, repaint } = makeProgress(ctx);
      prog.active = true;
      prog.verb = "copying";
      showProgressToast();
      await t.renderOnce();
      expect(isOpen()).toBe(true);
      live = { white: "#f0f0f0", accentBg: "#303040", hoverBg: "#404050" };
      repaint();
      await t.renderOnce();
      const shell = t.renderer.root.findDescendantById("tfm-toast-1") as any;
      expect([...shell.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
      const title = t.renderer.root.findDescendantById("tfm-prog-title") as any;
      expect([...title.fg.toInts()]).toEqual(hexInts("#f0f0f0"));
      const pause = t.renderer.root.findDescendantById("tfm-prog-pause") as any;
      expect([...pause.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("toast buttons hover from the island fill to the shared cue (islandSurface)", async () => {
    // the toast keeps its accentBg island in EVERY ui-style, so the buttons'
    // rest fill must never clear the way btnSurface's outline branch does —
    // a style-independent rest fill is the whole point of islandSurface
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      let seq = 0;
      const { ctx } = stubCtx({
        colors: () => ({ white: "#ffffff", accentBg: "#303040", hoverBg: "#404050" }) as any,
        makeIconSlot: () =>
          ({
            el: Box({ width: 2, height: 1 }),
            slotId: `tfm-slot-${++seq}`,
            spec: {},
          }) as unknown as IconSlotHandle,
        byId: (id: string) => t.renderer.root.findDescendantById(id) as unknown as MaybeNode,
        notifySticky: (children: any[]) => {
          const nodeId = `tfm-toast-${++seq}`;
          t.renderer.root.add(Box({ id: nodeId, backgroundColor: "#303040" }, ...children));
          return { id: seq, nodeId, close: () => {} } as ToastHandle;
        },
      });
      const { prog, showProgressToast } = makeProgress(ctx);
      prog.active = true;
      showProgressToast();
      await t.renderOnce();
      const pause = t.renderer.root.findDescendantById("tfm-prog-pause") as any;
      const closer = t.renderer.root.findDescendantById("tfm-prog-close") as any;
      expect([...pause.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
      expect([...closer.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
      pause.processMouseEvent({ type: "move", button: 0, x: 0, y: 0, modifiers: {} });
      expect([...pause.backgroundColor.toInts()]).toEqual(hexInts("#404050"));
      pause.processMouseEvent({ type: "out", button: 0, x: 0, y: 0, modifiers: {} });
      expect([...pause.backgroundColor.toInts()]).toEqual(hexInts("#303040"));
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("repaint() is a no-op with no live toast", () => {
    const { isOpen, repaint } = makeProgress(stubCtx().ctx);
    expect(isOpen()).toBe(false);
    expect(() => repaint()).not.toThrow();
  });
});
