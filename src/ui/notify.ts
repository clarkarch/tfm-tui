import { Box, Text } from "@opentui/core";

// --- Toast notifications (top-right stack, animated slide-in + fade-out).
// THE single toast stack: plain auto-dismiss toasts AND the sticky transfer
// progress toast all live here as entries, so expiry/close reflows every
// survivor uniformly and two toasts can never share a slot. Takes the theme
// colors and a host handle via ctx so it never imports app state. ---

export type NotifyCtx = {
  rootAdd(node: any): void;
  remove(node: any): void;
  byId(id: string): any;
  termW(): number;
  accentBg(): string;
  white(): string;
  sidebarFgMuted(): string;
  // config knob [ui] toast-duration-ms (default 3000)
  durationMs?(): number;
};

export type ToastHandle = { id: number; nodeId: string; close: () => void };

// one width for every toast (plain notifies AND the progress toast) —
// content-sized widths left the stack with zigzag edges on both sides.
// 36 fits typical summaries untruncated; longer failure lines ellipsize
// (the full text always persists on the status bar).
export const TOAST_W = 36;

// truncate with an ellipsis instead of a hard cut
export const truncateToastText = (s: string, budget: number): string =>
  s.length > budget ? `${s.slice(0, Math.max(0, budget - 1))}…` : s;

type ToastEntry = { id: number; nodeId: string; height: number; sticky: boolean; timer: any };

// shared slide-in animation (slide-out is just the reverse direction)
export const animateLeft = (node: any, from: number, to: number, ms: number): void => {
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
  notify: (message: string, title?: string) => void;
  notifySticky: (children: any[], opts?: { width?: number; height?: number }) => ToastHandle | null;
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
    const node: any = ctx.byId(entry.nodeId);
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
      const n: any = ctx.byId(t.nodeId);
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
    const real: any = ctx.byId(entry.nodeId);
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

  const pushToast = (width: number, height: number, children: any[], sticky: boolean): ToastHandle | null => {
    // toasts fire from all over (incl. error paths during native memory
    // pressure — see the OOM note in AGENTS.md); a missing toast must never
    // take the app down, so the whole build is guarded
    try {
      const id = ++toastSeq;
      const nodeId = `tfm-toast-${id}`;
      const y = slotTop(toasts.length);
      const node: any = Box(
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
      const real: any = ctx.byId(nodeId);
      if (!real) return null;
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
        const duration = ctx.durationMs?.() ?? 3000;
        entry.timer = setTimeout(() => fadeOut(id), duration);
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
    notify(message, title = "tfm") {
      const w = TOAST_W;
      pushToast(
        w,
        3,
        [
          Text({ content: truncateToastText(title, w - 3), fg: ctx.white() }),
          Text({ content: truncateToastText(message, w - 3), fg: ctx.sidebarFgMuted() }),
        ],
        false,
      );
    },
    notifySticky(children, opts) {
      return pushToast(opts?.width ?? TOAST_W, opts?.height ?? 4, children, true);
    },
  };
};
