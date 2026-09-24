import { Box, Text } from "@opentui/core";
import type { NotifyLevel } from "../lib/notify-level";
import type { MaybeNode, NodeLike } from "../lib/node-like";
import type { IconSlotHandle, SlotElement } from "./ui-slots";

// --- Toast notifications (top-right stack, animated slide-in + fade-out).
// THE single toast stack: plain auto-dismiss toasts AND the sticky transfer
// progress toast all live here as entries, so expiry/close reflows every
// survivor uniformly and two toasts can never share a slot. Takes the theme
// colors and a host handle via ctx so it never imports app state. The level
// vocabulary lives in ../lib/notify-level (leaf, so fs/app/input can name it
// without importing from ui/). ---

export type NotifyCtx = {
  rootAdd(node: unknown): void;
  remove(node: unknown): void;
  byId(id: string): MaybeNode;
  termW(): number;
  accentBg(): string;
  white(): string;
  sidebarFgMuted(): string;
  // level tints — optional with a white fallback; the icon plumbing below
  // (slot/drain/selectable) is required
  ansi1?(): string;
  ansi2?(): string;
  // raster level icon: single-state slot (fg = level color on the toast bg);
  // the async drain swaps the fallback glyph for the tinted raster
  makeIconSlot(
    name: string,
    states: { fg: string; bg: string }[],
    heightCells?: number,
  ): IconSlotHandle;
  drainIconQueue(): unknown;
  stripSelectable(): void;
  // config knob [ui] toast-duration-ms (default 3000)
  durationMs?(): number;
};

// error toasts linger so the failure is actually read; a longer configured
// duration always wins (never shorten what the user asked for)
export const ERROR_TOAST_MS = 5000;

// pure level mapping (tested): raster icon + title/body fg + lifetime. Stays
// on existing Theme keys (white/muted/ansi1/ansi2) — no new theme knobs.
// Toasts keep their accentBg fill in every ui-style (a border ring would clip
// the 3-row shape, same reason tiles stay fill-only).
export const toastLevelMeta = (
  level: NotifyLevel,
  colors: { white: string; muted: string; red: string; green: string },
  durationMs: number,
): { icon: "information" | "check" | "close"; titleFg: string; bodyFg: string; duration: number } => {
  if (level === "error")
    return { icon: "close", titleFg: colors.red, bodyFg: colors.white, duration: Math.max(durationMs, ERROR_TOAST_MS) };
  if (level === "success") return { icon: "check", titleFg: colors.green, bodyFg: colors.muted, duration: durationMs };
  return { icon: "information", titleFg: colors.white, bodyFg: colors.muted, duration: durationMs };
};

export type ToastHandle = { id: number; nodeId: string; close: () => void };

// one width for every toast (plain notifies AND the progress toast) —
// content-sized widths left the stack with zigzag edges on both sides.
// Messages word-wrap up to MAX_TOAST_LINES rows (the stack already tiles
// mixed heights); only beyond that does the last line ellipsize. Titles
// stay one truncated line.
export const TOAST_W = 36;
export const MAX_TOAST_LINES = 3;

// truncate with an ellipsis instead of a hard cut
export const truncateToastText = (s: string, budget: number): string =>
  s.length > budget ? `${s.slice(0, Math.max(0, budget - 1))}…` : s;

// greedy word wrap with hard-slicing for space-less runs (URLs, hashes).
// Always returns ≥1 line; overflow past maxLines folds into an ellipsis on
// the last kept line so the cut is visible, never silent.
export const wrapToastText = (s: string, budget: number, maxLines: number = MAX_TOAST_LINES): string[] => {
  const chunks: string[] = [];
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > budget) {
      chunks.push(rest.slice(0, budget));
      rest = rest.slice(budget);
    }
    if (rest) chunks.push(rest);
  }
  if (!chunks.length) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of chunks) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= budget) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  // lines.length > maxLines is guaranteed here, so the last kept row exists
  const lastIdx = maxLines - 1;
  const last = kept[lastIdx];
  if (last === undefined) return kept;
  const tail = `${last}…`;
  kept[lastIdx] = tail.length > budget ? truncateToastText(tail, budget) : tail;
  return kept;
};

type ToastEntry = {
  id: number;
  nodeId: string;
  height: number;
  sticky: boolean;
  // auto-dismiss handle; null while a sticky toast waits for an explicit close
  timer: ReturnType<typeof setTimeout> | null;
};

// shared slide-in animation (slide-out is just the reverse direction)
const animateLeft = (node: NodeLike, from: number, to: number, ms: number): void => {
  const steps = 8;
  let i = 0;
  const tick = () => {
    i++;
    try {
      node.left = Math.round(from + ((to - from) * i) / steps);
    } catch {}
    if (i < steps) setTimeout(tick, Math.max(16, ms / steps));
  };
  tick();
};

export const makeNotify = (
  ctx: NotifyCtx,
): {
  notify: (message: string, title?: string, level?: NotifyLevel) => void;
  notifySticky: (children: SlotElement[], opts?: { width?: number; height?: number }) => ToastHandle | null;
} => {
  let toasts: ToastEntry[] = [];
  let toastSeq = 0;

  // slot grid: entries stack downward with a 1-row gap, each at the running
  // sum of the heights above it — mixed heights (3-row notifies, 4-row
  // progress) always tile without overlap
  const slotTop = (i: number): number => {
    let y = 1;
    for (let j = 0; j < i; j++) y += (toasts[j]?.height ?? 3) + 1;
    return y;
  };

  const removeEntry = (id: number): void => {
    const entry = toasts.find((t) => t.id === id);
    if (!entry) return;
    if (entry.timer) {
      try {
        clearTimeout(entry.timer);
      } catch {}
    }
    const node = ctx.byId(entry.nodeId);
    try {
      if (node) ctx.remove(node);
    } catch {}
    toasts = toasts.filter((t) => t.id !== id);
    restack();
  };

  // reflow survivors after an expiry or a sticky close — positions derive
  // from live array order, never from show-time counts, so they can't stale
  const restack = (): void => {
    toasts.forEach((t, i) => {
      const n = ctx.byId(t.nodeId);
      // a toast reaped by a rebuild is simply not restacked (this used to rely
      // on a property write on null throwing inside the try)
      if (!n) return;
      try {
        n.top = slotTop(i);
      } catch {}
    });
  };

  // one dismiss path for expiry AND sticky close: fade, then remove +
  // reflow. (The progress toast used to slide out while notifies faded —
  // same stack, same goodbye now.)
  const fadeOut = (id: number): void => {
    const entry = toasts.find((t) => t.id === id);
    if (!entry) return;
    if (entry.timer) {
      try {
        clearTimeout(entry.timer);
      } catch {}
      entry.timer = null;
    }
    const real = ctx.byId(entry.nodeId);
    if (!real) {
      removeEntry(id);
      return;
    }
    let op = 1;
    const fade = () => {
      op -= 0.18;
      try {
        real.opacity = Math.max(0, op);
      } catch {}
      if (op > 0) setTimeout(fade, 24);
      else removeEntry(id);
    };
    fade();
  };

  const pushToast = (
    width: number,
    height: number,
    children: SlotElement[],
    sticky: boolean,
    duration?: number,
  ): ToastHandle | null => {
    // toasts fire from all over (incl. error paths during native memory
    // pressure — see the OOM note in AGENTS.md); a missing toast must never
    // take the app down, so the whole build is guarded
    try {
      const id = ++toastSeq;
      const nodeId = `tfm-toast-${id}`;
      const y = slotTop(toasts.length);
      const node = Box(
        {
          id: nodeId,
          position: "absolute",
          left: ctx.termW() + 2,
          top: y,
          width,
          height,
          zIndex: 3500,
          backgroundColor: ctx.accentBg(),
          flexDirection: "column",
          paddingLeft: 1,
        },
        ...children,
      );
      ctx.rootAdd(node);
      // the proxy is dead weight post-mount — animate/dismiss via the real renderable
      const real = ctx.byId(nodeId);
      if (!real) {
        // lookup miss (the memory-pressure scenario the guard anticipates):
        // the node is mounted but untracked — no timer, no removal path. It
        // must not sit on screen forever.
        try {
          node.destroy?.();
        } catch {}
        return null;
      }
      // re-assert the slot: post-mount this is the prop value already, but a
      // concurrent show may have moved the reservation since y was computed
      try {
        real.top = y;
      } catch {}
      const targetX = Math.max(0, ctx.termW() - width - 2);
      animateLeft(real, ctx.termW() + 2, targetX, 180);
      const entry: ToastEntry = { id, nodeId, height, sticky, timer: null };
      toasts.push(entry);
      if (!sticky) {
        entry.timer = setTimeout(() => fadeOut(id), duration ?? ctx.durationMs?.() ?? 3000);
      }
      return {
        id,
        nodeId,
        close: () => fadeOut(id),
      };
    } catch {
      // toast allocation failed (memory pressure) — drop it silently
      return null;
    }
  };

  return {
    notify(message, title = "tfm", level: NotifyLevel = "info") {
      // total-failure-safe like pushToast: toasts fire from error paths under
      // native memory pressure, so a throw anywhere in the build drops the
      // toast instead of taking the reporting call site down with it
      try {
        const w = TOAST_W;
        const lines = wrapToastText(message, w - 3);
        const meta = toastLevelMeta(
          level,
          {
            white: ctx.white(),
            muted: ctx.sidebarFgMuted(),
            red: ctx.ansi1?.() ?? ctx.white(),
            green: ctx.ansi2?.() ?? ctx.white(),
          },
          ctx.durationMs?.() ?? 3000,
        );
        // the level icon is a fixed 2-cell raster slot beside the title (same
        // shape as the progress toast's button slots); the drain swaps the
        // fallback glyph for the tinted raster async
        const slot = ctx.makeIconSlot(meta.icon, [{ fg: meta.titleFg, bg: ctx.accentBg() }], 1);
        pushToast(
          w,
          // short messages keep the classic 3-row shape (title + line + air);
          // longer ones grow instead of truncating
          Math.max(3, 1 + lines.length),
          [
            Box(
              { height: 1, flexDirection: "row", columnGap: 1 },
              slot.el,
              Text({ content: truncateToastText(title, w - 4), fg: meta.titleFg }),
            ),
            ...lines.map((line) => Text({ content: line, fg: meta.bodyFg })),
          ],
          false,
          meta.duration,
        );
      } catch {
        return;
      }
      // icon Texts must not enter text-selection mode; the drain is what
      // swaps the fallback glyph for the raster (its async rejection is
      // dropped — same fire-and-forget contract as the progress toast)
      try {
        ctx.stripSelectable();
      } catch {}
      try {
        const pending = ctx.drainIconQueue() as unknown;
        if (pending instanceof Promise) pending.catch(() => {});
      } catch {}
    },
    notifySticky(children, opts) {
      return pushToast(opts?.width ?? TOAST_W, opts?.height ?? 4, children, true);
    },
  };
};
