import { describe, expect, test } from "bun:test";
import { Box, Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  MAX_TOAST_LINES,
  TOAST_H,
  TOAST_PAD_Y,
  makeNotify,
  toastLevelMeta,
  truncateToastText,
  wrapToastText,
  type NotifyCtx,
} from "./notify";
import { makeProgress } from "./ui-progress";
import type { IconSlotHandle, SlotElement } from "./ui-slots";

const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(10);
};

// wait for a toast's slide-in to finish (its `left` stops changing) so the
// whole box is on-screen before asserting on painted text near the right edge
const settleSlide = async (r: any, id = "tfm-toast-1"): Promise<void> => {
  let last: number | undefined;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await r.renderOnce();
    const n = r.renderer.root.findDescendantById(id) as any;
    if (n && last !== undefined && n.left === last) return;
    last = n?.left;
    await Bun.sleep(30);
  }
};

// byId stubs stand in for post-mount renderables (proxy props throw
// pre-mount, so positions are pinned through the stub sets instead).
const makeFake = (opts?: { durationMs?: number }) => {
  const nodes = new Map<string, any>();
  const removed: string[] = [];
  const icons: Array<{ name: string; fg: string; bg: string; heightCells: number }> = [];
  const ctx: NotifyCtx = {
    rootAdd: (_node: any) => {},
    remove: (node: any) => {
      removed.push(node.id);
    },
    makeIconSlot: (name: string, states: Array<{ fg: string; bg: string }>, heightCells = 1) => {
      icons.push({ name, fg: states[0]?.fg ?? "", bg: states[0]?.bg ?? "", heightCells });
      // the notify path only reads slotId; the slot's icon surface is untested here
      return { el: { icon: name }, slotId: `slot-${icons.length}`, spec: {} } as unknown as IconSlotHandle;
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
  test("info keeps the classic white title + white body + base duration", () => {
    // body is white, not muted: muted is only guaranteed on sidebarBg, never
    // on the accentBg island (derived fills kept failing it) — one fill
    // cannot serve both bright and dim text
    expect(toastLevelMeta("info", colors, 3000)).toEqual({
      icon: "information",
      titleFg: "#ffffff",
      bodyFg: "#ffffff",
      duration: 3000,
    });
  });
  test("success tints the title green with a check icon", () => {
    expect(toastLevelMeta("success", colors, 3000)).toEqual({
      icon: "check",
      titleFg: "#7fd88f",
      bodyFg: "#ffffff",
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
    // every notify is TOAST_H (4) rows now, so the follower starts at 1 + 4 + 1
    expect(nodes.get("tfm-toast-1").top).toBe(1);
    expect(nodes.get("tfm-toast-2").top).toBe(1 + 4 + 1);
    // both toasts fade and remove themselves without taking the app down
    await settleUntil(() => removed.length >= 2);
    expect(removed).toContain("tfm-toast-1");
    expect(removed).toContain("tfm-toast-2");
  });

  test("long warnings ellipsize to ONE body line (strict 2-row toasts)", async () => {
    const { ctx, nodes } = makeFake();
    const { notify } = makeNotify(ctx);
    // strict 2-row content: a long message never grows the toast — it folds
    // into one ellipsized line, so the follower tiles at a fixed offset.
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
    // white info, green check, red close — the meta→slot wiring, not just names.
    // bg is the toast island's accentBg: the raster flattens onto the island
    // (the toast shell is a floating layer — see FLOAT_TOAST_PREFIX), so its
    // icon stays opaque under `transparent-partial` like every menu/dialog icon.
    // heightCells 2 is the B1 layout: a 2-row icon column beside the text.
    expect(icons).toEqual([
      { name: "information", fg: "#ffffff", bg: "#1a1b26", heightCells: 2 },
      { name: "check", fg: "#7fd88f", bg: "#1a1b26", heightCells: 2 },
      { name: "close", fg: "#e06c75", bg: "#1a1b26", heightCells: 2 },
    ]);
  });

  test("sticky toasts never auto-dismiss; close() fades out and reflows", async () => {
    // the progress toast lives on a sticky handle — it must survive past
    // the auto-dismiss window, share the fade-out with plain notifies, and
    // leave no hole when closed
    const { ctx, nodes, removed } = makeFake({ durationMs: 10000 });
    const { notify, notifySticky } = makeNotify(ctx);
    const sticky = notifySticky([{ kind: "progress" } as unknown as SlotElement], { width: 36, height: 4 });
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
        makeIconSlot: (name: string) =>
          ({
            el: Box({ id: `tfm-icon-test-${name}`, width: 2, height: 1 }, Text({ content: name })),
            slotId: `tfm-icon-test-${name}`,
            spec: {},
          }) as unknown as IconSlotHandle,
        drainIconQueue: () => {},
        stripSelectable: () => {},
        durationMs: () => 10000,
      });
      notify("first-msg");
      notify("second-msg with text");
      // slide-in takes ~180ms — poll the PAINTED frame until both toasts show
      // (never a bare sleep; animated renders are timing-dependent)
      const slideIn = Date.now() + 3000;
      while (Date.now() < slideIn) {
        await r.renderOnce();
        const rows = r.captureCharFrame().split("\n");
        if (rows.some((row) => row.includes("first-msg")) && rows.some((row) => row.includes("second-msg"))) break;
        await Bun.sleep(20);
      }
      await settleSlide(r, "tfm-toast-1");
      await settleSlide(r, "tfm-toast-2");
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
      const row2 = rows[rowOf("second-msg")]!;
      expect(row.search(/\S/)).toBe(row2.search(/\S/));
      const widthOf = (id: string): number => (r.renderer.root.findDescendantById(id) as any)?.width;
      expect(widthOf("tfm-toast-1")).toBe(36);
      expect(widthOf("tfm-toast-2")).toBe(36);
    } finally {
      await r.dispose(); // 0.6.0: destroy + await closed
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
        makeIconSlot: (name: string) =>
          ({
            el: Box({ id: `tfm-icon-test-${name}`, width: 2, height: 1 }, Text({ content: name })),
            slotId: `tfm-icon-test-${name}`,
            spec: {},
          }) as unknown as IconSlotHandle,
        drainIconQueue: () => {},
        stripSelectable: () => {},
        durationMs: () => 10000,
      });
      const colors = () => ({ white: "#ffffff", accentBg: "#1a1b26", hoverBg: "#2a2b36" }) as any;
      const progress = makeProgress({
        byId: (id: string) => r.renderer.root.findDescendantById(id),
        stripSelectable: () => {},
        colors,
        makeIconSlot: () =>
          ({ el: Text({ content: "i" }), slotId: "tfm-icon-test", spec: {} }) as unknown as IconSlotHandle,
        setIconState: () => false,
        drainIconQueue: () => {},
        notifySticky: (children: any[], opts?: { width?: number; height?: number }) => notifySticky(children, opts),
      });
      notify("early-note");
      progress.showProgressToast();
      stopSpinner = () => progress.finishProgressToast("done");
      notify("late-note");
      // poll the painted frame until all three toasts have slid fully into
      // view (slide-in timing). The break must cover EVERY string asserted
      // below: a toast sliding in from the right is clipped at the screen edge,
      // and the B1 text column starts further right than the old full-width
      // body, so a short string ("late-note") can be fully painted while a
      // longer sibling ("early-note") is still cut by a cell — the old
      // two-string condition broke on that partial frame.
      const slideIn = Date.now() + 3000;
      const up = (rows: string[], s: string): boolean => rows.some((row) => row.includes(s));
      while (Date.now() < slideIn) {
        await r.renderOnce();
        const rows = r.captureCharFrame().split("\n");
        if (up(rows, "copying") && up(rows, "early-note") && up(rows, "late-note")) break;
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
      await r.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("notify layout (B1: big icon column)", () => {
  test("title and body share a text column beside a 2-row icon", async () => {
    // the media-object layout: the level icon owns its own left column and the
    // title + wrapped description sit in a text column to its right, so the
    // body is INDENTED under the title rather than running the full width.
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
        // faithful slot: mirrors makeIconSlot's own width/height formula
        // (`heightCells*2` × `heightCells`) so the reserved column matches prod
        makeIconSlot: (name: string, _states: any, heightCells = 1) =>
          ({
            el: Box(
              { id: `tfm-icon-test-${name}`, width: Math.round(heightCells * 2), height: heightCells },
              Text({ content: name }),
            ),
            slotId: `tfm-icon-test-${name}`,
            spec: {},
          }) as unknown as IconSlotHandle,
        drainIconQueue: () => {},
        stripSelectable: () => {},
        durationMs: () => 10000,
      });
      notify("Copied 3 items to /home", "tfm");
      // slide-in takes ~180ms — poll the painted frame until the body shows
      // (never a bare sleep; the assertion below is expressed RELATIVE to the
      // toast's own left edge, so the in-flight slide doesn't matter)
      const slideIn = Date.now() + 3000;
      while (Date.now() < slideIn) {
        await r.renderOnce();
        if (r.captureCharFrame().includes("Copied 3 items")) break;
        await Bun.sleep(20);
      }
      await r.renderOnce();
      const rows = r.captureCharFrame().split("\n");
      const titleRow = rows.findIndex((row) => row.includes("tfm"));
      const bodyRow = rows.findIndex((row) => row.includes("Copied 3 items"));
      expect(titleRow).toBeGreaterThanOrEqual(0);
      expect(bodyRow).toBe(titleRow + 1);
      const toast = r.renderer.root.findDescendantById("tfm-toast-1") as any;
      const left = toast.left;
      // text column x = 1 pad + 4 icon + 1 gap = 6, measured from the toast's
      // own left edge: title AND body start there, never the toast edge (that
      // hanging indent IS the B1 look)
      expect(rows[titleRow]!.indexOf("tfm") - left).toBe(6);
      expect(rows[bodyRow]!.indexOf("Copied") - left).toBe(6);
      // the icon owns the left column and is 2 rows tall (heightCells)
      const icon = r.renderer.root.findDescendantById("tfm-icon-test-information") as any;
      expect(icon.height).toBe(2);
      expect(icon.width).toBe(4);
      // strict 2-row shape + symmetric vertical gutter: the toast is exactly
      // TOAST_H tall, the content block starts TOAST_PAD_Y rows down, and the
      // row above the title and the row below the body are both blank — so the
      // 2-row icon is centered (equal space above and below), never top-heavy.
      expect(toast.height).toBe(TOAST_H);
      // the content block starts one gutter row below the toast's top edge
      expect(titleRow).toBe(toast.top + TOAST_PAD_Y);
      const within = (row: string): string => row.slice(left, left + toast.width).trim();
      expect(within(rows[titleRow - 1]!)).toBe("");
      expect(within(rows[bodyRow + 1]!)).toBe("");
    } finally {
      await r.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("long messages ellipsize to one body line (fixed height)", async () => {
    // strict 2 rows: a long message must NOT grow the toast — it folds into a
    // single ellipsized body line, keeping every notification the same height.
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
        makeIconSlot: (name: string, _states: any, heightCells = 1) =>
          ({
            el: Box(
              { id: `tfm-icon-test-${name}`, width: Math.round(heightCells * 2), height: heightCells },
              Text({ content: name }),
            ),
            slotId: `tfm-icon-test-${name}`,
            spec: {},
          }) as unknown as IconSlotHandle,
        drainIconQueue: () => {},
        stripSelectable: () => {},
        durationMs: () => 10000,
      });
      notify("clone failed: Repository not found on this remote host today ok", "tfm");
      const slideIn = Date.now() + 3000;
      while (Date.now() < slideIn) {
        await r.renderOnce();
        if (r.captureCharFrame().includes("clone failed")) break;
        await Bun.sleep(20);
      }
      await settleSlide(r);
      await r.renderOnce();
      const rows = r.captureCharFrame().split("\n");
      const titleRow = rows.findIndex((row) => row.includes("tfm"));
      const bodyRow = rows.findIndex((row) => row.includes("clone failed"));
      expect(titleRow).toBeGreaterThanOrEqual(0);
      expect(bodyRow).toBe(titleRow + 1);
      // the body folded into ONE ellipsized line — and the row below it is the
      // blank bottom gutter, never a second body line
      expect(rows[bodyRow]!.includes("…")).toBe(true);
      const toast = r.renderer.root.findDescendantById("tfm-toast-1") as any;
      expect(toast.height).toBe(TOAST_H);
      expect(rows[bodyRow + 1]!.slice(toast.left, toast.left + toast.width).trim()).toBe("");
    } finally {
      await r.dispose(); // 0.6.0: destroy + await closed
    }
  });
});
