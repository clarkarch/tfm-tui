import { describe, expect, test } from "bun:test";
import { Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { makeNotify, truncateToastText, type NotifyCtx } from "./notify";
import { makeProgress } from "./ui-progress";

const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(10);
};

// byId stubs stand in for post-mount renderables (proxy props throw
// pre-mount, so positions are pinned through the stub sets instead).
const makeFake = (opts?: { durationMs?: number }) => {
  const nodes = new Map<string, any>();
  const removed: string[] = [];
  const ctx: NotifyCtx = {
    rootAdd: (_node: any) => {},
    remove: (node: any) => {
      removed.push(node.id);
    },
    byId: (id: string): any => {
      let n = nodes.get(id);
      if (!n) {
        n = { id, top: -1, left: -1, opacity: 1 };
        nodes.set(id, n);
      }
      return n;
    },
    termW: () => 80,
    accentBg: () => "#1a1b26",
    white: () => "#ffffff",
    sidebarFgMuted: () => "#666666",
    durationMs: () => opts?.durationMs ?? 25,
  };
  return { ctx, nodes, removed };
};

describe("truncateToastText", () => {
  test("short text passes through, long text gets an ellipsis", () => {
    expect(truncateToastText("abc", 5)).toBe("abc");
    expect(truncateToastText("abcdef", 5)).toBe("abcd…");
    expect(truncateToastText("abcdef", 1)).toBe("…");
  });
});

describe("notify stacking", () => {
  test("consecutive toasts stack at increasing y, never the same slot", async () => {
    const { ctx, nodes, removed } = makeFake();
    const { notify } = makeNotify(ctx);
    notify("first");
    notify("second");
    expect(nodes.get("tfm-toast-1").top).toBe(1);
    expect(nodes.get("tfm-toast-2").top).toBe(5);
    // both toasts fade and remove themselves without taking the app down
    await settleUntil(() => removed.length >= 2);
    expect(removed).toContain("tfm-toast-1");
    expect(removed).toContain("tfm-toast-2");
  });

  test("sticky toasts never auto-dismiss; close() fades out and reflows", async () => {
    // the progress toast lives on a sticky handle — it must survive past
    // the auto-dismiss window, share the fade-out with plain notifies, and
    // leave no hole when closed
    const { ctx, nodes, removed } = makeFake({ durationMs: 10000 });
    const { notify, notifySticky } = makeNotify(ctx);
    const sticky = notifySticky([{ kind: "progress" }], { width: 36, height: 4 });
    expect(sticky).not.toBeNull();
    notify("below");
    expect(nodes.get(sticky!.nodeId).top).toBe(1);
    expect(nodes.get("tfm-toast-2").top).toBe(6);
    // past the auto-dismiss window: nothing left on its own (sticky never
    // auto-dismisses; the plain toast's 10s window hasn't elapsed either)
    await Bun.sleep(100);
    expect(removed).toEqual([]);
    sticky!.close();
    await settleUntil(() => removed.includes(sticky!.nodeId));
    expect(removed).toEqual([sticky!.nodeId]);
    expect(nodes.get("tfm-toast-2").top).toBe(1);
    // double close is a safe no-op
    sticky!.close();
    await Bun.sleep(200);
    expect(removed).toEqual([sticky!.nodeId]);
  });
});

describe("notify stacking (real renderer)", () => {
  test("two toasts paint on separate rows, second below first", async () => {
    const r = await createTestRenderer({ width: 80, height: 24 });
    try {
      const { notify } = makeNotify({
        rootAdd: (node: any) => r.renderer.root.add(node),
        remove: (node: any) => {
          try {
            (node.parent ?? r.renderer.root).remove(node);
          } catch {}
        },
        byId: (id: string) => r.renderer.root.findDescendantById(id),
        termW: () => 80,
        accentBg: () => "#1a1b26",
        white: () => "#ffffff",
        sidebarFgMuted: () => "#666666",
        durationMs: () => 10000,
      });
      notify("first-msg");
      notify("second-msg with a much longer tail");
      // slide-in takes ~180ms; only then are both toasts on screen
      await Bun.sleep(350);
      await r.renderOnce();
      const frame = r.captureCharFrame();
      const rows = frame.split("\n");
      const rowOf = (s: string): number => rows.findIndex((row) => row.includes(s));
      expect(rowOf("first-msg")).toBeGreaterThanOrEqual(0);
      expect(rowOf("second-msg")).toBeGreaterThanOrEqual(0);
      expect(rowOf("second-msg")).toBeGreaterThan(rowOf("first-msg"));
      // one width for the whole stack — ragged per-message widths left
      // zigzag edges on both sides. Text starts inset by padding on both,
      // so pin the box left (frame) and the box width (node geometry).
      const row = rows[rowOf("first-msg")]!;
      const row2 = rows[rowOf("second-msg with a much longer")]!;
      expect(row.search(/\S/)).toBe(row2.search(/\S/));
      const widthOf = (id: string): number => (r.renderer.root.findDescendantById(id) as any)?.width;
      expect(widthOf("tfm-toast-1")).toBe(36);
      expect(widthOf("tfm-toast-2")).toBe(36);
    } finally {
      r.renderer.destroy();
    }
  });

  test("progress toast and notifies tile in one stack, arrival order", async () => {
    // the reported overlap: a notify predates the transfer, the progress
    // toast lands mid-stack, and the next expiry reflows a notify onto it.
    // One stack, arrival order — positions derive from live order, never
    // from show-time counts, so they can't stale.
    const r = await createTestRenderer({ width: 80, height: 24 });
    let stopSpinner: (() => void) | undefined;
    try {
      const { notify, notifySticky } = makeNotify({
        rootAdd: (node: any) => r.renderer.root.add(node),
        remove: (node: any) => {
          try {
            (node.parent ?? r.renderer.root).remove(node);
          } catch {}
        },
        byId: (id: string) => r.renderer.root.findDescendantById(id),
        termW: () => 80,
        accentBg: () => "#1a1b26",
        white: () => "#ffffff",
        sidebarFgMuted: () => "#666666",
        durationMs: () => 10000,
      });
      const colors = () => ({ white: "#ffffff", accentBg: "#1a1b26", hoverBg: "#2a2b36" }) as any;
      const progress = makeProgress({
        byId: (id: string) => r.renderer.root.findDescendantById(id),
        stripSelectable: () => {},
        colors,
        makeIconSlot: () => ({ el: Text({ content: "i" }), slotId: "tfm-icon-test", spec: {} }),
        setIconState: () => false,
        drainIconQueue: () => {},
        notifySticky: (children: any[], opts?: { width?: number; height?: number }) => notifySticky(children, opts),
      });
      notify("early-note");
      progress.showProgressToast();
      stopSpinner = () => progress.finishProgressToast("done");
      notify("late-note");
      await Bun.sleep(350);
      await r.renderOnce();
      const rows = r.captureCharFrame().split("\n");
      const rowOf = (s: string): number => rows.findIndex((row) => row.includes(s));
      expect(rowOf("copying")).toBeGreaterThanOrEqual(0);
      expect(rowOf("early-note")).toBeGreaterThanOrEqual(0);
      expect(rowOf("late-note")).toBeGreaterThanOrEqual(0);
      // arrival order top-to-bottom, no shared rows
      expect(rowOf("early-note")).toBeLessThan(rowOf("copying"));
      expect(rowOf("copying")).toBeLessThan(rowOf("late-note"));
    } finally {
      // stop the spinner interval; the linger timeout is one-shot
      try {
        stopSpinner?.();
      } catch {}
      r.renderer.destroy();
    }
  });
});
