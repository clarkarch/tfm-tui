import { describe, expect, test } from "bun:test";
import { Box, Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  MAX_TOAST_LINES,
  makeNotify,
  toastLevelMeta,
  truncateToastText,
  wrapToastText,
  type NotifyCtx,
} from "./notify";
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
  const icons: Array<{ name: string; fg: string }> = [];
  const ctx: NotifyCtx = {
    rootAdd: (_node: any) => {},
    remove: (node: any) => {
      removed.push(node.id);
    },
    makeIconSlot: (name: string, states: Array<{ fg: string; bg: string }>) => {
      icons.push({ name, fg: states[0]?.fg ?? "" });
      return { el: { icon: name }, slotId: `slot-${icons.length}`, spec: {} };
    },
    drainIconQueue: () => {},
    stripSelectable: () => {},
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
    ansi1: () => "#e06c75",
    ansi2: () => "#7fd88f",
    durationMs: () => opts?.durationMs ?? 25,
  };
  return { ctx, nodes, removed, icons };
};

describe("toastLevelMeta", () => {
  const colors = { white: "#ffffff", muted: "#666666", red: "#e06c75", green: "#7fd88f" };
  test("info keeps the classic white title + muted body + base duration", () => {
    expect(toastLevelMeta("info", colors, 3000)).toEqual({
      icon: "information",
      titleFg: "#ffffff",
      bodyFg: "#666666",
      duration: 3000,
    });
  });
  test("success tints the title green with a check icon", () => {
    expect(toastLevelMeta("success", colors, 3000)).toEqual({
      icon: "check",
      titleFg: "#7fd88f",
      bodyFg: "#666666",
      duration: 3000,
    });
  });
  test("error tints the title red, brightens the body, lingers 5s", () => {
    expect(toastLevelMeta("error", colors, 3000)).toEqual({
      icon: "close",
      titleFg: "#e06c75",
      bodyFg: "#ffffff",
      duration: 5000,
    });
  });
  test("error never shortens a longer configured duration", () => {
    expect(toastLevelMeta("error", colors, 10000).duration).toBe(10000);
  });
});

describe("truncateToastText", () => {
  test("short text passes through, long text gets an ellipsis", () => {
    expect(truncateToastText("abc", 5)).toBe("abc");
    expect(truncateToastText("abcdef", 5)).toBe("abcd…");
    expect(truncateToastText("abcdef", 1)).toBe("…");
  });
});

describe("wrapToastText", () => {
  test("short text stays one line; words wrap greedily within budget", () => {
    expect(wrapToastText("abc", 5)).toEqual(["abc"]);
    expect(wrapToastText("aa bb cc", 5)).toEqual(["aa bb", "cc"]);
    expect(wrapToastText("", 5)).toEqual([""]);
  });

  test("space-less runs hard-slice (URLs never push one giant line)", () => {
    expect(wrapToastText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("overflow past the cap folds into a visible ellipsis, never a silent cut", () => {
    const lines = wrapToastText("one two three four five six", 7, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect(lines[1]!.length).toBeLessThanOrEqual(7);
    // default cap applies without the arg
    expect(wrapToastText(Array.from({ length: 20 }, (_, i) => `w${i}`).join(" "), 10)).toHaveLength(MAX_TOAST_LINES);
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

  test("long warnings wrap over rows instead of one truncated line", async () => {
    const { ctx, nodes } = makeFake();
    const { notify } = makeNotify(ctx);
    // 33-char budget: three rows (title + 3) — the follower tiles below all of it
    notify("clone failed: Repository not found on this remote host today ok");
    expect(nodes.get("tfm-toast-1").top).toBe(1);
    notify("next");
    expect(nodes.get("tfm-toast-2").top).toBe(1 + 4 + 1);
  });

  test("each level queues its raster icon slot with the level tint", () => {
    const { ctx, icons } = makeFake();
    const { notify } = makeNotify(ctx);
    notify("a", "t", "info");
    notify("b", "t", "success");
    notify("c", "t", "error");
    // white info, green check, red close — the meta→slot wiring, not just names
    expect(icons).toEqual([
      { name: "information", fg: "#ffffff" },
      { name: "check", fg: "#7fd88f" },
      { name: "close", fg: "#e06c75" },
    ]);
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
    // auto-dismisses; the plain toast's 10s window hasn't elapsed either) —
    // poll for the FORBIDDEN removal so a regression fails fast
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      await Bun.sleep(20);
      expect(removed).toEqual([]);
    }
    sticky!.close();
    await settleUntil(() => removed.includes(sticky!.nodeId));
    expect(removed).toEqual([sticky!.nodeId]);
    expect(nodes.get("tfm-toast-2").top).toBe(1);
    // double close is a safe no-op
    sticky!.close();
    await settleUntil(() => removed.length > 1 || Date.now() > deadline); // poll, never a bare sleep
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
        makeIconSlot: (name: string) => ({
          el: Box({ id: `tfm-icon-test-${name}`, width: 2, height: 1 }, Text({ content: name })),
          slotId: `tfm-icon-test-${name}`,
          spec: {},
        }),
        drainIconQueue: () => {},
        stripSelectable: () => {},
        durationMs: () => 10000,
      });
      notify("first-msg");
      notify("second-msg with a much longer tail");
      // slide-in takes ~180ms — poll the PAINTED frame until both toasts show
      // (never a bare sleep; animated renders are timing-dependent)
      const slideIn = Date.now() + 3000;
      while (Date.now() < slideIn) {
        await r.renderOnce();
        const rows = r.captureCharFrame().split("\n");
        if (rows.some((row) => row.includes("first-msg")) && rows.some((row) => row.includes("longer tail"))) break;
        await Bun.sleep(20);
      }
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
        makeIconSlot: (name: string) => ({
          el: Box({ id: `tfm-icon-test-${name}`, width: 2, height: 1 }, Text({ content: name })),
          slotId: `tfm-icon-test-${name}`,
          spec: {},
        }),
        drainIconQueue: () => {},
        stripSelectable: () => {},
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
      // poll the painted frame until all three are up (slide-in timing)
      const slideIn = Date.now() + 3000;
      while (Date.now() < slideIn) {
        await r.renderOnce();
        const rows = r.captureCharFrame().split("\n");
        if (rows.some((row) => row.includes("copying")) && rows.some((row) => row.includes("late-note"))) break;
        await Bun.sleep(20);
      }
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
